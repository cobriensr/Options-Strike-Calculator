/**
 * DealerRegimeTile × malformed /api/dealer-regime payload — crash
 * regression (client-shape-hardening-2026-08-20, follow-up sweep).
 *
 * Unlike DealerRegimeTile.test.tsx (which mocks the hook), this file
 * feeds the REAL component + REAL useDealerRegime hook shapeless bodies
 * with only `fetch` (and the auth-mode probe) stubbed, because the crash
 * class lives in the seam between them: the hook's `(await res.json())
 * as DealerRegimeResponse` identity cast let a `{}` / loosely-parsed
 * HTML / partially-malformed envelope reach the tile's `for (const r of
 * data.rows)` classification loop.
 *
 * Contract under test: a malformed envelope settles into the hook's
 * normal error state with ZERO console errors; a partially valid
 * envelope drops only the malformed rows and classifies the rest.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import type { MockInstance } from 'vitest';

vi.mock('../../utils/auth', () => ({
  getAccessMode: vi.fn(() => 'owner'),
}));

import { DealerRegimeTile } from '../../components/DealerRegimeTile';

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

/** A row shaped exactly like `mapRow` in api/_lib/db-dealer-regime.ts. */
function validRow(ticker: 'SPX' | 'SPY' | 'QQQ') {
  return {
    ticker,
    ts: new Date().toISOString(),
    spot: 7230,
    zeroGamma: 7187.47,
    confidence: 0.392,
    netGammaAtSpot: 3_500_000_000,
  };
}

/**
 * With no prior good payload to fall back on, the tile's Body renders
 * its error branch instead of the cell grid — the same branch a non-2xx
 * response produces. The point is that it renders SOMETHING stable
 * rather than remounting the section ErrorBoundary.
 */
async function expectShapeErrorState(): Promise<void> {
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent(
      /unexpected response shape/i,
    ),
  );
  expect(screen.queryByTestId('dealer-regime-cell-SPX')).toBeNull();
}

describe('DealerRegimeTile — malformed payload crash regression', () => {
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

    render(<DealerRegimeTile marketOpen={false} />);

    await expectShapeErrorState();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('settles into the error state on an HTML-ish string body with zero console errors', async () => {
    stubFetch('<!doctype html><html><body>502 Bad Gateway</body></html>');

    render(<DealerRegimeTile marketOpen={false} />);

    await expectShapeErrorState();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('settles into the error state when `rows` is a non-array object', async () => {
    stubFetch({
      date: null,
      at: null,
      rows: { SPX: validRow('SPX') },
      asOf: '2026-08-20T14:30:00.000Z',
    });

    render(<DealerRegimeTile marketOpen={false} />);

    await expectShapeErrorState();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('drops malformed rows but classifies the valid ones', async () => {
    stubFetch({
      date: null,
      at: null,
      rows: [
        validRow('SPX'),
        // Null row — the classification loop previously died on
        // `r.ticker` here.
        null,
        // Non-numeric spot — dropped, never rendered as NaN.
        { ...validRow('SPY'), spot: 'oops' },
        // Unknown ticker — harmless, but must not displace a real cell.
        { ...validRow('SPX'), ticker: 'IWM' },
      ],
      asOf: '2026-08-20T14:30:00.000Z',
    });

    render(<DealerRegimeTile marketOpen={false} />);

    // SPX: the one valid row survives and classifies as long-γ
    // (netGammaAtSpot > 0, conf above the 0.05 gate, fresh ts).
    await waitFor(() =>
      expect(
        within(screen.getByTestId('dealer-regime-cell-SPX')).getByText(
          'long-γ',
        ),
      ).toBeInTheDocument(),
    );
    // SPY (bad spot) and QQQ (absent) both fall back to the no-data cell.
    for (const ticker of ['SPY', 'QQQ'] as const) {
      expect(
        within(screen.getByTestId(`dealer-regime-cell-${ticker}`)).getByText(
          /uncertain · no data/i,
        ),
      ).toBeInTheDocument();
    }
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
