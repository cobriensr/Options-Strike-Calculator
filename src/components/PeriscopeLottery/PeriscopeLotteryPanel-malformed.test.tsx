/**
 * PeriscopeLotteryPanel × malformed /api/periscope-lottery-feed payloads —
 * crash regression.
 *
 * Unlike PeriscopeLotteryPanel.test.tsx (which mocks usePeriscopeLotteryFeed),
 * this file renders the REAL panel + REAL hook with only `fetch` mocked,
 * because the production crash lived in the seam between them: a shapeless
 * response body (`{}`, an HTML error page parsed loosely, a 5xx JSON blob)
 * made the hook store `undefined` as `fires`, so the panel's
 * `fires.filter(...)` threw straight into the section ErrorBoundary.
 *
 * Contract under test: on a malformed payload the panel settles into its
 * normal error/empty state with ZERO console errors; malformed rows inside
 * a valid envelope are dropped while valid rows still render.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { MockInstance } from 'vitest';

import { PeriscopeLotteryPanel } from './PeriscopeLotteryPanel';
import type { PeriscopeLotteryFire } from './types';

function baseFire(
  overrides: Partial<PeriscopeLotteryFire> = {},
): PeriscopeLotteryFire {
  return {
    id: 1,
    fireType: 'call_lottery',
    fireTime: '2026-05-18T18:43:12Z',
    expiry: '2026-05-18',
    eventStrike: 7380,
    tradeStrike: 7430,
    spotAtEvent: 7362.14,
    strikeDist: 17.86,
    greekPost: -7403.4,
    greekDelta: -4513.3,
    greekLvlRank: 0.95,
    greekChgRank: 0.999,
    gexDollars: -974008661,
    callRatio: -3.58,
    qqqNetPremBalance30m: 0.6,
    entryPx: 0.1,
    vix: 18.31,
    v3StrictPass: true,
    v4Badge: true,
    peakPx: 25,
    peakPct: 250,
    peakTime: '2026-05-18T19:01:47Z',
    eodClosePx: 0.05,
    realizedRPeak: 249,
    realizedREod: -0.5,
    outcomeLocked: true,
    createdAt: '2026-05-18T18:43:50Z',
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('PeriscopeLotteryPanel — malformed payload crash regression', () => {
  let consoleErrorSpy: MockInstance;

  beforeEach(() => {
    consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('settles into the error state on a shapeless {} payload with zero console errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({})),
    );

    render(<PeriscopeLotteryPanel marketOpen={false} />);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /unexpected response shape/i,
      ),
    );
    // Both columns render their normal empty state — no throw, no boundary.
    expect(screen.getAllByText(/No fires today yet/)).toHaveLength(2);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('settles into the error state on a garbage (string) payload with zero console errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse('<!doctype html><h1>502</h1>')),
    );

    render(<PeriscopeLotteryPanel marketOpen={false} />);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /unexpected response shape/i,
      ),
    );
    expect(screen.getAllByText(/No fires today yet/)).toHaveLength(2);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('drops malformed fire rows while valid rows still render', async () => {
    const fires = [
      baseFire({ id: 1 }),
      'garbage-row',
      { ...baseFire({ id: 2, fireType: 'put_lottery' }), tradeStrike: 'x' },
    ] as unknown as PeriscopeLotteryFire[];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          date: '2026-05-18',
          fireType: 'both',
          count: fires.length,
          fires,
        }),
      ),
    );

    render(<PeriscopeLotteryPanel marketOpen={false} />);

    // The valid call fire renders...
    await waitFor(() => expect(screen.getByText('7430C')).toBeInTheDocument());
    // ...and the two malformed rows are dropped, not fatal.
    expect(screen.getAllByTestId('periscope-lottery-row')).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
