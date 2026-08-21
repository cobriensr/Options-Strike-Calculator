/**
 * StrikeBattleMap × malformed /api/gex-strike-expiry payload — crash
 * regression.
 *
 * Unlike StrikeBattleMap.test.tsx (which mocks useGexStrikeExpiry), this
 * file renders the REAL component + REAL hook with only `fetch` mocked,
 * because the production crash lived in the seam between them:
 *
 * The hook cast each per-ticker body straight to GexStrikeExpiryResponse,
 * so a shapeless body (`{}`, an HTML error page parsed loosely, a 5xx
 * JSON blob) put an object without `rows` into `data[ticker]` — and the
 * component died on `data[t]?.rows.length`.
 *
 * Contract under test: a malformed ticker entry is dropped (that ticker
 * shows its empty state) WITHOUT discarding the healthy tickers, and the
 * panel settles with ZERO console errors. Malformed rows inside a valid
 * envelope are dropped row-by-row.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { MockInstance } from 'vitest';
import { StrikeBattleMap } from '../../components/StrikeBattleMap';
import type { GexStrikeExpiryTicker } from '../../hooks/useGexStrikeExpiry';
import { getETToday } from '../../utils/timezone';

vi.mock('../../utils/auth', () => ({
  getAccessMode: () => 'owner',
  checkIsOwner: () => true,
}));

const TICKERS: readonly GexStrikeExpiryTicker[] = ['SPY', 'QQQ', 'SPX', 'NDX'];

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function validEnvelope(ticker: GexStrikeExpiryTicker, rows: unknown[]) {
  return {
    ticker,
    expiry: getETToday(),
    at: null,
    rows,
    timestamps: [],
    asOf: '2026-08-20T14:35:00.000Z',
  };
}

function validRow(
  ticker: GexStrikeExpiryTicker,
  strike: number,
  price: number,
) {
  return {
    ticker,
    expiry: getETToday(),
    strike,
    ts_minute: '2026-08-20T14:30:00.000Z',
    price,
    call_gamma_oi: strike > price ? 1000 : 0,
    put_gamma_oi: strike < price ? -800 : 0,
    call_gamma_ask_vol: 100,
    call_gamma_bid_vol: 0,
    put_gamma_ask_vol: 50,
    put_gamma_bid_vol: 0,
    // Remaining nullable numeric fields intentionally omitted — the
    // validator must coalesce absent fields to null (optional-props
    // policy), matching what the server sends as explicit nulls.
  };
}

/**
 * Route the hook's 4 parallel fetches by the `ticker=` query param.
 * Tickers without an entry get a valid empty envelope.
 */
function stubFetchRouter(
  bodies: Partial<Record<GexStrikeExpiryTicker, unknown>>,
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const ticker = TICKERS.find((t) => url.includes(`ticker=${t}`));
      if (ticker == null) throw new Error(`unknown ticker URL: ${url}`);
      const body = bodies[ticker] ?? validEnvelope(ticker, []);
      return jsonResponse(body);
    }),
  );
}

const EMPTY_STATE = /no strike-level gex yet/i;

describe('StrikeBattleMap — malformed payload crash regression', () => {
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

  it('settles into the empty state when every ticker returns a shapeless {} with zero console errors', async () => {
    stubFetchRouter({ SPY: {}, QQQ: {}, SPX: {}, NDX: {} });

    render(<StrikeBattleMap marketOpen={true} />);

    await waitFor(() =>
      expect(screen.getByText(EMPTY_STATE)).toBeInTheDocument(),
    );

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('settles into the empty state when every ticker returns a bare JSON string with zero console errors', async () => {
    const garbage = '<!doctype html><html>backend exploded</html>';
    stubFetchRouter({
      SPY: garbage,
      QQQ: garbage,
      SPX: garbage,
      NDX: garbage,
    });

    render(<StrikeBattleMap marketOpen={true} />);

    await waitFor(() =>
      expect(screen.getByText(EMPTY_STATE)).toBeInTheDocument(),
    );

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('drops a malformed ticker without discarding the healthy ticker, dropping bad rows row-by-row', async () => {
    const spot = 720.5;
    stubFetchRouter({
      // SPY: valid envelope with 4 valid rows + malformed rows mixed in.
      SPY: validEnvelope('SPY', [
        validRow('SPY', 719, spot),
        validRow('SPY', 720, spot),
        { strike: 'not-a-number' },
        42,
        // Valid strings but a garbage numeric field — dropped, so
        // strike 723 must NOT render.
        { ...validRow('SPY', 723, spot), call_gamma_oi: 'bad' },
        validRow('SPY', 721, spot),
        validRow('SPY', 722, spot),
      ]),
      // QQQ: malformed envelope — the whole ticker is dropped and shows
      // its own empty state.
      QQQ: { unexpected: true },
    });

    render(<StrikeBattleMap marketOpen={true} />);

    await waitFor(() =>
      expect(screen.getByTestId('battle-map-ticker-SPY')).toBeInTheDocument(),
    );

    // Valid SPY rows render.
    for (const strike of [719, 720, 721, 722]) {
      expect(screen.getByTestId(`strike-row-${strike}`)).toBeInTheDocument();
    }
    // The row with the garbage numeric field was dropped.
    expect(screen.queryByTestId('strike-row-723')).not.toBeInTheDocument();

    // QQQ shows its normal per-ticker empty state.
    expect(
      screen.getByText(/waiting for daemon to deliver qqq/i),
    ).toBeInTheDocument();

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
