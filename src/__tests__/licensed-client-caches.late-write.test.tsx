import { useEffect, type ReactNode } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearLicensedClientCaches } from '../lib/licensed-client-caches';
import { useOpeningFlowSignal } from '../hooks/useOpeningFlowSignal';
import { useRegime0dte } from '../hooks/useRegime0dte';
import { useStickyUnion } from '../hooks/useStickyUnion';

/**
 * A write that is still on its way when access drops to public must not put
 * its key back after the purge. The three writers of licensed data each have
 * one in flight at that moment:
 *
 *   - useOpeningFlowSignal and useRegime0dte (through usePolledWindowSignal):
 *     a request whose reply has not landed;
 *   - useStickyUnion: a feed write held by its 1 s debounce.
 *
 * What stops each is that the panel hosting the hook leaves the tree in the
 * same commit as the access change (getPanelRegistry lists the panels for
 * owner or guest only, and the alerts view drops its feeds without owner or
 * guest market context), and an unmount aborts the request or flushes the
 * pending write before App's purge effect runs. This harness is that shape in
 * small: a parent whose one effect purges when `authed` is false, and a host
 * that leaves with `authed`. The real hooks sit in the hosts. Each case has a
 * control, the same flow with access held, so a missing key means the purge
 * won and not that the harness never wrote one.
 *
 * App's own effect is pinned in App.market-open-gate.test.tsx; the opening-flow
 * hook's abort when the host stays mounted, in hooks/useOpeningFlowSignal.test.ts.
 */

const mode = vi.hoisted(() => ({ current: 'owner' as 'owner' | 'public' }));
vi.mock('../utils/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/auth')>()),
  getAccessMode: () => mode.current,
  checkIsOwner: () => mode.current === 'owner',
}));

interface InFlight {
  url: string;
  signal: AbortSignal;
  reply: (body: unknown) => void;
}
let inFlight: InFlight[] = [];

/** A fetch that stays pending until the test replies, and rejects on abort. */
function stubFetch(): void {
  inFlight = [];
  globalThis.fetch = vi.fn(
    (url: string, init: RequestInit) =>
      new Promise((resolve, reject) => {
        const signal = init.signal as AbortSignal;
        signal.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
        inFlight.push({
          url,
          signal,
          reply: (body) =>
            resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve(body),
            }),
        });
      }),
  ) as unknown as typeof fetch;
}

/** Let the continuations of a settled promise run, inside act. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

const OPENING_FLOW_BODY = {
  date: '2026-11-20',
  windowStatus: 'closed',
  stopPct: 0.2,
  exitMinutesFromEntry: 30,
  tickers: {},
};
const REGIME_BODY = { date: '2026-11-20', gate: 'calm' };
const FEED_KEY = 'feed-union:lottery:2026-11-20:sig';
const FEED_ITEMS = [{ id: 'SPY 600C' }];

function OpeningFlowHost() {
  useOpeningFlowSignal();
  return null;
}
function RegimeHost() {
  useRegime0dte();
  return null;
}
function FeedHost() {
  useStickyUnion(FEED_ITEMS, {
    key: (item) => item.id,
    storageKey: FEED_KEY,
  });
  return null;
}

/** App's purge effect, and a host that is in the tree only while `authed`. */
function Harness({ authed, host }: { authed: boolean; host: ReactNode }) {
  useEffect(() => {
    if (!authed) clearLicensedClientCaches();
  }, [authed]);
  return authed ? host : null;
}

interface Writer {
  name: string;
  key: string;
  host: ReactNode;
  /** The write goes in flight: a request is pending, or a feed write queued. */
  expectPending: () => void;
  /** The reply lands, or the debounce window passes. */
  land: () => Promise<void>;
}

const WRITERS: readonly Writer[] = [
  {
    name: 'opening flow',
    key: 'openingFlowSignal.lastGood',
    host: <OpeningFlowHost />,
    expectPending: () =>
      expect(inFlight.map((r) => r.url)).toEqual(['/api/opening-flow-signal']),
    land: async () => {
      inFlight[0]?.reply(OPENING_FLOW_BODY);
      await settle();
    },
  },
  {
    name: '0DTE regime',
    key: 'regime0dte:lastgood',
    host: <RegimeHost />,
    expectPending: () =>
      expect(inFlight.map((r) => r.url)).toEqual(['/api/regime-0dte']),
    land: async () => {
      inFlight[0]?.reply(REGIME_BODY);
      await settle();
    },
  },
  {
    name: 'feed union',
    key: FEED_KEY,
    host: <FeedHost />,
    // The debounce holds the write: nothing is in storage yet.
    expectPending: () => expect(localStorage.getItem(FEED_KEY)).toBeNull(),
    land: async () => {
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
    },
  },
];

describe.each(WRITERS)('$name write in flight at a downgrade', (writer) => {
  beforeEach(() => {
    localStorage.clear();
    mode.current = 'owner';
    vi.useFakeTimers();
    // Friday 2026-11-20, 09:00 CT: inside the regime hook's polling window.
    vi.setSystemTime(new Date('2026-11-20T15:00:00Z'));
    stubFetch();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('control: writes its key when access holds', async () => {
    render(<Harness authed host={writer.host} />);
    await settle();
    writer.expectPending();

    await writer.land();

    expect(localStorage.getItem(writer.key)).not.toBeNull();
  });

  it('writes nothing after the purge when access drops first', async () => {
    const { rerender } = render(<Harness authed host={writer.host} />);
    await settle();
    writer.expectPending();

    mode.current = 'public';
    rerender(<Harness authed={false} host={writer.host} />);
    await writer.land();

    expect(localStorage.getItem(writer.key)).toBeNull();
  });
});
