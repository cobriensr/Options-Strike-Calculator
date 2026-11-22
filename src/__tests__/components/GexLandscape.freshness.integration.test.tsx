/**
 * GexLandscape with the REAL useGexLandscapeData hook and only `fetch`
 * stubbed. `GexLandscape.test.tsx` mocks the hook file-wide, so it can't
 * see what the two do together. Three things only show up here:
 *
 *   1. The age on screen is the one the hook measured: the response's
 *      `ageSec` plus its `Age` header, then the 15 s tick.
 *   2. The panel settles. The hook once built new arrays and Maps on every
 *      render; the panel mirrors `timestamps` into state and feeds `strikes`
 *      to the Top 5 tracker, and both effects re-fired on the new identity,
 *      so it re-rendered in a loop (hundreds to thousands of commits a
 *      second). A `<Profiler>` commit count over a quiet interval is the
 *      regression guard.
 *   3. A scrub's age never reads as live, and a session edge refetches.
 */

import { Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import GexLandscape from '../../components/GexLandscape';
import { CollapseAllContext } from '../../components/collapse-context';
import type { CollapseSignal } from '../../components/collapse-context';

const NOW = Date.parse('2026-11-20T15:30:00.000Z'); // 9:30 AM CT, a Friday
const MIN = 60_000;
const collapseSignal: CollapseSignal = { version: 0, collapsed: false };
// The real panel renders a full strike table after each fetch; the default 1 s
// wait is not enough when several test files share the CPU.
const ASYNC = { timeout: 5_000 };

/**
 * Let React finish what a response started. The data lands outside `act`, so
 * the commit that shows the rows, its passive effects (the 15 s interval, the
 * mirrored capture minutes that enable the scrub buttons) and the re-render
 * they cause are separate tasks; `findBy*` can resolve between them. Without
 * this, a click on a still-disabled button or an advance of the fake clock
 * before the interval exists is a silent no-op.
 */
const flushReact = () =>
  act(async () => {
    await Promise.resolve();
  });

function row(strike: number, gamma: number) {
  return {
    strike,
    gamma,
    charm: gamma / 10,
    vanna: gamma / 20,
    gammaPrev5m: gamma * 0.9,
    gammaPrev15m: gamma * 0.8,
    gammaPrev30m: gamma * 0.7,
    charmPrev5m: null,
    charmPrev15m: null,
    charmPrev30m: null,
    vannaPrev5m: null,
    vannaPrev15m: null,
    vannaPrev30m: null,
  };
}

const STRIKES = [5980, 5985, 5990, 5995, 6000, 6005, 6010, 6015, 6020];

/** A /api/gex-landscape body with data; `over` replaces top-level fields. */
function body(over: Record<string, unknown> = {}, strikes = STRIKES) {
  return {
    marketOpen: true,
    asOf: new Date(NOW).toISOString(),
    data: {
      spot: 6000,
      strikes: strikes.map((k, i) => row(k, (i - 4) * 1000 + 500)),
    },
    ageSec: 5,
    availableMinutes: [
      new Date(NOW - 3 * MIN).toISOString(),
      new Date(NOW - 2 * MIN).toISOString(),
      new Date(NOW - MIN).toISOString(),
    ],
    ...over,
  };
}

/** A 200 response carrying an edge `Age` header, as Vercel's cache sends. */
function jsonResponse(payload: unknown, edgeAgeSec = 0): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json', Age: String(edgeAgeSec) },
  });
}

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const spy = vi.fn(async (input: RequestInfo | URL) => handler(String(input)));
  vi.stubGlobal('fetch', spy);
  return spy;
}

const tree = (marketOpen: boolean) => (
  <CollapseAllContext.Provider value={collapseSignal}>
    <GexLandscape marketOpen={marketOpen} />
  </CollapseAllContext.Provider>
);

describe('GexLandscape with the real data hook: the age on screen', () => {
  beforeEach(() => {
    // Only the interval and the clock are faked: fetch, Response.json and
    // React's scheduler run for real, and no poll fires unless advanced.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('ageSec 170 with Age 5 shows LIVE, and one 15 s tick later DELAYED 3m', async () => {
    stubFetch(() => jsonResponse(body({ ageSec: 170 }), 5));
    render(tree(true));
    await screen.findByRole('tab', { name: 'All strikes' }, ASYNC);
    await flushReact();

    // 170 s + 5 s at the edge = 175 s, under the 3-minute threshold.
    expect(screen.queryByText(/^DELAYED/)).toBeNull();
    expect(screen.getAllByText('LIVE').length).toBeGreaterThan(0);

    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    // 175 s + 15 s since receipt = 190 s: past 3 minutes, with no new response.
    expect(screen.getByText('DELAYED 3m')).toBeDefined();
  });

  it('leaving a scrub never shows the scrubbed response age, only the live one once it lands', async () => {
    let resolveLive: ((r: Response) => void) | undefined;
    let liveCalls = 0;
    const fetchSpy = stubFetch((url) => {
      // The scrubbed minute carries a 15-minute-old capture and one extra
      // strike (6025), so it is told apart from the live bodies on screen.
      if (url.includes('at=')) {
        return jsonResponse(body({ ageSec: 900 }, [...STRIKES, 6025]));
      }
      liveCalls += 1;
      if (liveCalls === 1) return jsonResponse(body({ ageSec: 5 }));
      return new Promise<Response>((resolve) => {
        resolveLive = resolve;
      });
    });
    render(tree(true));
    await screen.findByRole('tab', { name: 'All strikes' }, ASYNC);
    expect(screen.queryByText('6,025')).toBeNull();

    // Step back: the panel fetches the scrubbed minute and shows it. The
    // button enables once the capture minutes are mirrored, a commit after
    // the rows appear.
    await waitFor(
      () => expect(screen.getByLabelText('Previous snapshot')).toBeEnabled(),
      ASYNC,
    );
    await flushReact();
    fireEvent.click(screen.getByLabelText('Previous snapshot'));
    await screen.findAllByText('6,025', {}, ASYNC);
    expect(screen.getByText('SCRUBBED')).toBeDefined();
    expect(screen.queryByText(/^DELAYED/)).toBeNull();

    // Resume live: the live fetch is pending, and the stored response is
    // still the scrubbed one, 900 s old. Its age must not read as live.
    fireEvent.click(screen.getByLabelText('Resume live'));
    await waitFor(() => expect(resolveLive).toBeDefined(), ASYNC);
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.queryByText(/^DELAYED/)).toBeNull();
    expect(screen.getAllByText('LIVE').length).toBeGreaterThan(0);

    // The live response lands: still LIVE, now on its own age.
    await act(async () => {
      resolveLive?.(jsonResponse(body({ ageSec: 5 })));
    });
    await waitFor(() => expect(screen.queryByText('6,025')).toBeNull(), ASYNC);
    expect(screen.queryByText(/^DELAYED/)).toBeNull();
    expect(screen.getAllByText('LIVE').length).toBeGreaterThan(0);
  });

  it('refetches at once when the market opens, replacing the previous response, with no poll', async () => {
    // A panel left open with the market closed holds an old response. At the
    // open, `usePolling` doesn't fetch when its gate flips (and its interval
    // is fake here, so no poll fires): only the session-edge refetch can
    // replace it.
    let call = 0;
    const fetchSpy = stubFetch(() => {
      call += 1;
      return jsonResponse(body({ ageSec: call === 1 ? 20 : 5 }));
    });
    const view = render(tree(false));
    await screen.findByRole('tab', { name: 'All strikes' }, ASYNC);
    await flushReact();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/^DELAYED/)).toBeNull(); // closed: no badge

    // Half an hour passes, then the market opens.
    act(() => {
      vi.setSystemTime(NOW + 30 * MIN);
    });
    view.rerender(tree(true));
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // The stored response is now 30 minutes old; the fresh one replaces it.
    await waitFor(
      () => expect(screen.queryByText(/^DELAYED/)).toBeNull(),
      ASYNC,
    );
    expect(screen.getAllByText('LIVE').length).toBeGreaterThan(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

// The render-loop regression guard (C1). Real timers and no act(): a loop
// yields to the event loop between commits, so the waits below still end and
// the count shows it; inside act() a loop would never return. Each case
// mounts the real panel under a <Profiler> and counts commits over a quiet
// interval (no poll, no tick: both are far longer than the wait).
describe('GexLandscape with the real data hook: it settles', () => {
  type ActEnv = { IS_REACT_ACT_ENVIRONMENT?: boolean };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  it.each([
    ['with data', () => Promise.resolve(jsonResponse(body()))],
    ['with the fetch pending', () => new Promise<Response>(() => undefined)],
    [
      'after a 401',
      () => Promise.resolve(new Response('Unauthorized', { status: 401 })),
    ],
  ])('commits nothing over a quiet interval (%s)', async (_label, respond) => {
    stubFetch(respond);
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(String(args[0]));
    });
    const env = globalThis as ActEnv;
    const priorActEnv = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = false;

    let commits = 0;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      root.render(
        <Profiler
          id="gex-landscape"
          onRender={() => {
            commits += 1;
          }}
        >
          {tree(true)}
        </Profiler>,
      );

      // Settle: wait until a 250 ms window adds no commit, for at most 3 s.
      let seen = -1;
      const deadline = Date.now() + 3_000;
      while (commits !== seen && Date.now() < deadline) {
        seen = commits;
        await wait(250);
      }
      const atSettle = commits;
      expect(atSettle).toBeGreaterThan(0);

      await wait(750);
      expect(commits - atSettle).toBe(0);
      expect(errors.filter((e) => e.includes('Maximum update depth'))).toEqual(
        [],
      );
    } finally {
      root.unmount();
      container.remove();
      env.IS_REACT_ACT_ENVIRONMENT = priorActEnv;
    }
  });
});
