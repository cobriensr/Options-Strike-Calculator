import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { AUTH_CLEARED_EVENT, wrapFetch } from '../../utils/authInterceptor';

function makeOriginal(status: number): typeof fetch {
  return vi.fn(
    async () => new Response(null, { status }),
  ) as unknown as typeof fetch;
}

describe('wrapFetch', () => {
  let cookieGetSpy: ReturnType<typeof vi.spyOn>;
  let dispatchSpy: ReturnType<typeof vi.spyOn>;
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
  });

  it('passes through 200 responses untouched', async () => {
    cookieGetSpy.mockReturnValue('sc-hint=1');
    const original = makeOriginal(200);
    const wrapped = wrapFetch(original);

    const res = await wrapped('/api/quotes');

    expect(res.status).toBe(200);
    expect(cookieWrites).toHaveLength(0);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('clears hint cookies and dispatches event on 401 with hint present', async () => {
    cookieGetSpy.mockReturnValue('sc-hint=1');
    const original = makeOriginal(401);
    const wrapped = wrapFetch(original);

    await wrapped('/api/quotes');

    expect(cookieWrites).toHaveLength(2);
    expect(cookieWrites[0]).toContain('sc-hint=');
    expect(cookieWrites[0]).toContain('Max-Age=0');
    expect(cookieWrites[1]).toContain('sc-guest-hint=');
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const event = dispatchSpy.mock.calls[0]?.[0] as CustomEvent;
    expect(event.type).toBe(AUTH_CLEARED_EVENT);
  });

  it('does nothing on 401 when no hint cookie is present', async () => {
    cookieGetSpy.mockReturnValue('');
    const original = makeOriginal(401);
    const wrapped = wrapFetch(original);

    await wrapped('/api/quotes');

    expect(cookieWrites).toHaveLength(0);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('skips clearing on 401 from /api/auth/* paths', async () => {
    cookieGetSpy.mockReturnValue('sc-guest-hint=1');
    const original = makeOriginal(401);
    const wrapped = wrapFetch(original);

    await wrapped('/api/auth/guest-key');

    expect(cookieWrites).toHaveLength(0);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('handles absolute URLs', async () => {
    cookieGetSpy.mockReturnValue('sc-hint=1');
    const original = makeOriginal(401);
    const wrapped = wrapFetch(original);

    await wrapped('https://0dte.vercel.app/api/auth/guest-logout');

    expect(cookieWrites).toHaveLength(0);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('handles Request objects', async () => {
    cookieGetSpy.mockReturnValue('sc-hint=1');
    const original = makeOriginal(401);
    const wrapped = wrapFetch(original);

    const req = new Request('https://0dte.vercel.app/api/quotes');
    await wrapped(req);

    expect(cookieWrites).toHaveLength(2);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it('handles URL objects', async () => {
    cookieGetSpy.mockReturnValue('sc-hint=1');
    const original = makeOriginal(401);
    const wrapped = wrapFetch(original);

    await wrapped(new URL('https://0dte.vercel.app/api/auth/guest-key'));

    expect(cookieWrites).toHaveLength(0);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('returns the original Response object verbatim', async () => {
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
});
