/**
 * ZeroGammaPanel × malformed /api/zero-gamma payload — crash regression
 * (client-shape-hardening-2026-08-20, follow-up sweep).
 *
 * Unlike ZeroGammaPanel.test.tsx (which mocks the hook), this file feeds
 * the REAL panel + REAL useZeroGamma hook shapeless bodies with only
 * `fetch` (and the auth-mode probe) stubbed, because the crash class
 * lives in the seam between them: the hook's `(await res.json()) as
 * ApiResponse` identity cast handed `latest` / `history` straight to
 * TickerCard, which does `latest.spot.toLocaleString()` and
 * `[...history].sort((a, b) => a.ts.localeCompare(b.ts))`.
 *
 * Contract under test: a malformed envelope settles into the hook's
 * normal error state, a malformed `latest` degrades to the "No data yet"
 * card, and a partially valid envelope drops only the malformed history
 * rows — all with ZERO console errors.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { MockInstance } from 'vitest';

vi.mock('../../utils/auth', () => ({
  getAccessMode: vi.fn(() => 'owner'),
}));

import { ZeroGammaPanel } from '../../components/ZeroGammaPanel';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(payload: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse(payload)),
  );
}

/** A row shaped exactly like `mapRow` in api/zero-gamma.ts. */
function validRow(overrides: Record<string, unknown> = {}) {
  return {
    ticker: 'SPX',
    spot: 7135.5,
    zeroGamma: 7150.25,
    confidence: 0.72,
    netGammaAtSpot: -1.2e9,
    gammaCurve: null,
    ts: '2026-08-20T20:10:00.000Z',
    ...overrides,
  };
}

/**
 * With no prior good payload to fall back on, each card renders its
 * error branch — the same branch a non-2xx response produces.
 */
async function expectAllCardsErrored(): Promise<void> {
  await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(3));
  expect(
    screen.getAllByText(/failed to load: failed to load zero-gamma data/i),
  ).toHaveLength(3);
}

describe('ZeroGammaPanel — malformed payload crash regression', () => {
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
    stubFetch({});

    render(<ZeroGammaPanel marketOpen={false} />);

    await expectAllCardsErrored();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('settles into the error state on an HTML-ish string body with zero console errors', async () => {
    stubFetch('<!doctype html><html><body>502 Bad Gateway</body></html>');

    render(<ZeroGammaPanel marketOpen={false} />);

    await expectAllCardsErrored();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('settles into the error state when `history` is not an array', async () => {
    stubFetch({ latest: validRow(), history: { '0': validRow() } });

    render(<ZeroGammaPanel marketOpen={false} />);

    await expectAllCardsErrored();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('degrades a shapeless `latest` to the no-data card', async () => {
    // `latest: null` is a legitimate server state (no rows yet), so a
    // malformed `latest` degrades rather than failing the envelope.
    stubFetch({ latest: {}, history: [] });

    render(<ZeroGammaPanel marketOpen={false} />);

    await waitFor(() =>
      expect(screen.getAllByText('No data yet')).toHaveLength(3),
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('drops malformed history rows but renders the valid latest row', async () => {
    stubFetch({
      latest: validRow(),
      history: [
        validRow(),
        // Null row — the sparkline sort previously died on `a.ts`.
        null,
        // Non-string ts — `.localeCompare` is not a function.
        validRow({ ts: 1_755_000_000_000 }),
        // Non-numeric spot — would plot as NaN in the sparkline.
        validRow({ spot: 'oops', ts: '2026-08-20T20:15:00.000Z' }),
        // Valid second row, so the sparkline has its >= 2 points.
        validRow({ spot: 7140.25, ts: '2026-08-20T20:20:00.000Z' }),
      ],
    });

    render(<ZeroGammaPanel marketOpen={false} />);

    // The valid `latest` renders its spot + regime, once per ticker card.
    await waitFor(() =>
      expect(screen.getAllByText('7,135.50')).toHaveLength(3),
    );
    expect(screen.getAllByText('KNIFE EDGE')).toHaveLength(3);
    // Exactly the two well-formed history rows survive, so the sparkline
    // renders instead of falling back to "waiting for >= 2 snapshots".
    // Its axis labels span those rows' spots and zero-gamma levels only
    // (min 7135.50 = the earlier spot, max 7150.25 = the ZG line) — no
    // NaN leaking in from the dropped `spot: 'oops'` row.
    expect(screen.getAllByRole('img')).toHaveLength(3);
    expect(screen.queryByText(/waiting for/i)).toBeNull();
    expect(screen.getAllByText('7135.50')).toHaveLength(3);
    expect(screen.getAllByText('7150.25')).toHaveLength(3);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
