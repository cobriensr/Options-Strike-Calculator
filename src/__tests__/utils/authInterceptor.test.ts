import {
  describe,
  it,
  expect,
  vi,
  afterEach,
  beforeEach,
  type MockInstance,
} from 'vitest';
import { AUTH_CLEARED_EVENT, wrapFetch } from '../../utils/authInterceptor';

type WhoamiMode = 'owner' | 'guest' | 'public';

interface FakeFetchOptions {
  /** Status to return for non-whoami requests. */
  status: number;
  /** Mode to return from /api/auth/whoami probes. */
  whoamiMode?: WhoamiMode;
  /** If true, /api/auth/whoami returns a non-2xx (simulates server hiccup). */
  whoamiFails?: boolean;
}

interface FakeFetch {
  fetch: typeof fetch;
  whoamiCalls: number;
  /** Optional gate — when set, whoami pauses until `releaseGate` is called. */
  gatePromise: Promise<void> | null;
  releaseGate: (() => void) | null;
}

/**
 * Build a fake `fetch` whose default responses honor `opts.status` for
 * arbitrary URLs but special-cases `/api/auth/whoami` so the interceptor
 * can be exercised end-to-end. The optional `gatePromise` lets a test
 * pause whoami responses to verify single-flight probe behavior.
 */
function makeFetch(opts: FakeFetchOptions): FakeFetch {
  const state: FakeFetch = {
    whoamiCalls: 0,
    gatePromise: null,
    releaseGate: null,
    fetch: vi.fn() as unknown as typeof fetch,
  };

  state.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    if (url.includes('/api/auth/whoami')) {
      state.whoamiCalls += 1;
      if (state.gatePromise) await state.gatePromise;
      if (opts.whoamiFails) {
        return new Response(null, { status: 500 });
      }
      return new Response(
        JSON.stringify({ mode: opts.whoamiMode ?? 'public' }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }

    return new Response(null, { status: opts.status });
  }) as unknown as typeof fetch;

  return state;
}

/**
 * Drain microtasks so the wrapper's fire-and-forget probe can settle.
 * The probe does multiple awaits (fetch + json), so we cycle a few
 * times to be sure all chained continuations have run.
 */
async function flushPromises(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

describe('wrapFetch', () => {
  let cookieGetSpy: MockInstance<() => string>;
  let dispatchSpy: MockInstance<(event: Event) => boolean>;
  let cookieWrites: string[];

  beforeEach(() => {
    cookieWrites = [];
    cookieGetSpy = vi.spyOn(document, 'cookie', 'get').mockReturnValue('');
    vi.spyOn(document, 'cookie', 'set').mockImplementation((v: string) => {
      cookieWrites.push(v);
    });
    dispatchSpy = vi.spyOn(window, 'dispatchEvent');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('passes through 200 responses untouched', async () => {
    cookieGetSpy.mockReturnValue('sc-hint=1');
    const fake = makeFetch({ status: 200 });
    const wrapped = wrapFetch(fake.fetch);

    const res = await wrapped('/api/quotes');

    expect(res.status).toBe(200);
    expect(cookieWrites).toHaveLength(0);
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(fake.whoamiCalls).toBe(0);
  });

  it('does NOT clear or probe on a single 401 (debounce holds)', async () => {
    cookieGetSpy.mockReturnValue('sc-hint=1');
    const fake = makeFetch({ status: 401, whoamiMode: 'public' });
    const wrapped = wrapFetch(fake.fetch);

    await wrapped('/api/quotes');
    await flushPromises();

    expect(cookieWrites).toHaveLength(0);
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(fake.whoamiCalls).toBe(0);
  });

  it("clears hints and dispatches event when 2+ 401s + whoami says 'public'", async () => {
    cookieGetSpy.mockReturnValue('sc-guest-hint=1');
    const fake = makeFetch({ status: 401, whoamiMode: 'public' });
    const wrapped = wrapFetch(fake.fetch);

    await wrapped('/api/quotes');
    await wrapped('/api/quotes');
    await flushPromises();

    expect(fake.whoamiCalls).toBe(1);
    expect(cookieWrites).toHaveLength(2);
    expect(cookieWrites[0]).toContain('sc-hint=');
    expect(cookieWrites[0]).toContain('Max-Age=0');
    expect(cookieWrites[1]).toContain('sc-guest-hint=');
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const event = dispatchSpy.mock.calls[0]?.[0] as CustomEvent;
    expect(event.type).toBe(AUTH_CLEARED_EVENT);
  });

  it("does NOT clear when whoami reports 'guest' (server says session is fine)", async () => {
    cookieGetSpy.mockReturnValue('sc-guest-hint=1');
    const fake = makeFetch({ status: 401, whoamiMode: 'guest' });
    const wrapped = wrapFetch(fake.fetch);

    await wrapped('/api/quotes');
    await wrapped('/api/quotes');
    await flushPromises();

    expect(fake.whoamiCalls).toBe(1);
    expect(cookieWrites).toHaveLength(0);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("does NOT clear when whoami reports 'owner'", async () => {
    cookieGetSpy.mockReturnValue('sc-hint=1');
    const fake = makeFetch({ status: 401, whoamiMode: 'owner' });
    const wrapped = wrapFetch(fake.fetch);

    await wrapped('/api/quotes');
    await wrapped('/api/quotes');
    await flushPromises();

    expect(fake.whoamiCalls).toBe(1);
    expect(cookieWrites).toHaveLength(0);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('does NOT clear when whoami probe itself fails (network/server)', async () => {
    cookieGetSpy.mockReturnValue('sc-hint=1');
    const fake = makeFetch({ status: 401, whoamiFails: true });
    const wrapped = wrapFetch(fake.fetch);

    await wrapped('/api/quotes');
    await wrapped('/api/quotes');
    await flushPromises();

    expect(fake.whoamiCalls).toBe(1);
    expect(cookieWrites).toHaveLength(0);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('does nothing on 401 when no hint cookie is present', async () => {
    cookieGetSpy.mockReturnValue('');
    const fake = makeFetch({ status: 401, whoamiMode: 'public' });
    const wrapped = wrapFetch(fake.fetch);

    await wrapped('/api/quotes');
    await wrapped('/api/quotes');
    await flushPromises();

    expect(cookieWrites).toHaveLength(0);
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(fake.whoamiCalls).toBe(0);
  });

  it('skips counting on 401 from /api/auth/* paths', async () => {
    cookieGetSpy.mockReturnValue('sc-guest-hint=1');
    const fake = makeFetch({ status: 401, whoamiMode: 'public' });
    const wrapped = wrapFetch(fake.fetch);

    // 10 auth-endpoint 401s should never trigger a probe.
    for (let i = 0; i < 10; i += 1) {
      await wrapped('/api/auth/guest-key');
    }
    await flushPromises();

    expect(cookieWrites).toHaveLength(0);
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(fake.whoamiCalls).toBe(0);
  });

  it('handles absolute URLs', async () => {
    cookieGetSpy.mockReturnValue('sc-hint=1');
    const fake = makeFetch({ status: 401, whoamiMode: 'public' });
    const wrapped = wrapFetch(fake.fetch);

    await wrapped('https://0dte.vercel.app/api/auth/guest-logout');
    await wrapped('https://0dte.vercel.app/api/auth/guest-logout');
    await flushPromises();

    // Both are auth endpoints — no probe, no clear.
    expect(cookieWrites).toHaveLength(0);
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(fake.whoamiCalls).toBe(0);
  });

  it('handles Request objects', async () => {
    cookieGetSpy.mockReturnValue('sc-hint=1');
    const fake = makeFetch({ status: 401, whoamiMode: 'public' });
    const wrapped = wrapFetch(fake.fetch);

    await wrapped(new Request('https://0dte.vercel.app/api/quotes'));
    await wrapped(new Request('https://0dte.vercel.app/api/quotes'));
    await flushPromises();

    expect(cookieWrites).toHaveLength(2);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(fake.whoamiCalls).toBe(1);
  });

  it('handles URL objects', async () => {
    cookieGetSpy.mockReturnValue('sc-hint=1');
    const fake = makeFetch({ status: 401, whoamiMode: 'public' });
    const wrapped = wrapFetch(fake.fetch);

    await wrapped(new URL('https://0dte.vercel.app/api/auth/guest-key'));
    await wrapped(new URL('https://0dte.vercel.app/api/auth/guest-key'));
    await flushPromises();

    expect(cookieWrites).toHaveLength(0);
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(fake.whoamiCalls).toBe(0);
  });

  it('returns the original Response object verbatim on 401', async () => {
    cookieGetSpy.mockReturnValue('sc-hint=1');
    const expectedBody = JSON.stringify({ error: 'Not authenticated' });
    const original = vi.fn(
      async () => new Response(expectedBody, { status: 401 }),
    ) as unknown as typeof fetch;
    const wrapped = wrapFetch(original);

    const res = await wrapped('/api/quotes');
    const body = await res.text();

    expect(res.status).toBe(401);
    expect(body).toBe(expectedBody);
  });

  it('expires the debounce window — two 401s 6s apart do not trigger', async () => {
    cookieGetSpy.mockReturnValue('sc-hint=1');
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    const fake = makeFetch({ status: 401, whoamiMode: 'public' });
    const wrapped = wrapFetch(fake.fetch);

    await wrapped('/api/quotes');
    nowSpy.mockReturnValue(1_006_000); // 6s later — outside 5s window
    await wrapped('/api/quotes');
    await flushPromises();

    expect(fake.whoamiCalls).toBe(0);
    expect(cookieWrites).toHaveLength(0);
  });

  it('runs only one whoami probe while one is in flight', async () => {
    cookieGetSpy.mockReturnValue('sc-hint=1');
    const fake = makeFetch({ status: 401, whoamiMode: 'public' });
    // Gate the whoami response so the probe stays pending while
    // additional 401s fire.
    fake.gatePromise = new Promise<void>((resolve) => {
      fake.releaseGate = resolve;
    });
    const wrapped = wrapFetch(fake.fetch);

    // Trip the debounce — probe is now pending on the gate.
    await wrapped('/api/quotes');
    await wrapped('/api/quotes');
    await flushPromises();

    expect(fake.whoamiCalls).toBe(1);

    // Five more 401s while the probe is in flight — should NOT spawn
    // additional probes.
    for (let i = 0; i < 5; i += 1) {
      await wrapped('/api/quotes');
    }
    await flushPromises();
    expect(fake.whoamiCalls).toBe(1);

    // Release the gate; the probe completes and clears hints.
    fake.releaseGate?.();
    await flushPromises();

    expect(cookieWrites).toHaveLength(2);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });
});
