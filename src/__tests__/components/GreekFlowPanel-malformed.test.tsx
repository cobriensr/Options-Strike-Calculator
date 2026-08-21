/**
 * GreekFlowPanel × malformed /api/greek-flow payload — crash regression
 * (client-shape-hardening-2026-08-20, follow-up sweep).
 *
 * Unlike GreekFlowPanel.test.tsx (which mocks `useGreekFlow` wholesale),
 * this file renders the REAL panel through the REAL hook with only
 * `fetch` stubbed, because the crash lives in the seam between them: the
 * hook's `(await res.json()) as GreekFlowResponse` identity cast let a
 * shapeless body reach the render pass, where `data.tickers.SPY.rows`
 * (index.tsx) and `computeVerdict(delta, vega)` (verdict-logic.ts)
 * dereference it unconditionally.
 *
 * Contract under test: a malformed envelope settles into the panel's
 * normal no-data/error state with ZERO console errors; a partially-valid
 * envelope keeps the good tickers/rows and drops only the bad ones.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { MockInstance } from 'vitest';

vi.mock('../../utils/auth', () => ({
  getAccessMode: vi.fn(() => 'owner'),
}));

vi.mock('../../utils/timezone', async () => {
  const actual = await vi.importActual<typeof import('../../utils/timezone')>(
    '../../utils/timezone',
  );
  return { ...actual, getETToday: () => '2026-08-20' };
});

import { GreekFlowPanel } from '../../components/GreekFlowPanel';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function rawResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html' },
  });
}

const FIELDS = [
  'dir_vega_flow',
  'total_vega_flow',
  'otm_dir_vega_flow',
  'otm_total_vega_flow',
  'dir_delta_flow',
  'total_delta_flow',
  'otm_dir_delta_flow',
  'otm_total_delta_flow',
] as const;

function metricsFixture(): Record<string, unknown> {
  return Object.fromEntries(
    FIELDS.map((f) => [
      f,
      {
        slope: { slope: 1.5, points: 15 },
        flip: {
          occurred: false,
          atTimestamp: null,
          magnitude: 0,
          currentSign: 0,
        },
        cliff: { magnitude: 0, atTimestamp: null },
      },
    ]),
  );
}

function divergenceFixture(): Record<string, unknown> {
  return Object.fromEntries(
    FIELDS.map((f) => [f, { spySign: 1, qqqSign: 1, diverging: false }]),
  );
}

function rowFixture(
  ticker: 'SPY' | 'QQQ',
  timestamp: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ticker,
    timestamp,
    transactions: 10,
    volume: 100,
    dir_vega_flow: 0,
    total_vega_flow: 0,
    otm_dir_vega_flow: 0,
    otm_total_vega_flow: 0,
    dir_delta_flow: 0,
    total_delta_flow: 0,
    otm_dir_delta_flow: 0,
    otm_total_delta_flow: 0,
    cum_dir_vega_flow: 0,
    cum_total_vega_flow: 0,
    cum_otm_dir_vega_flow: 1_000,
    cum_otm_total_vega_flow: 0,
    cum_dir_delta_flow: 0,
    cum_total_delta_flow: 0,
    cum_otm_dir_delta_flow: 2_000,
    cum_otm_total_delta_flow: 0,
    price: 645.5,
    ...overrides,
  };
}

describe('GreekFlowPanel — malformed payload crash regression', () => {
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

  it('renders the error state on a shapeless {} payload with zero console errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({})),
    );

    render(<GreekFlowPanel marketOpen />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /unexpected response shape/i,
    );
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('renders the error state on a JSON string body with zero console errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse('<!doctype html><html>oops</html>')),
    );

    render(<GreekFlowPanel marketOpen />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /unexpected response shape/i,
    );
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('renders the error state on an unparseable HTML body with zero console errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => rawResponse('<!doctype html><html>oops</html>')),
    );

    render(<GreekFlowPanel marketOpen />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('renders the error state when the envelope has a date but no tickers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          date: '2026-08-20',
          scope: '0dte',
          asOf: '2026-08-20T14:30:00.000Z',
        }),
      ),
    );

    render(<GreekFlowPanel marketOpen />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /unexpected response shape/i,
    );
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('renders the no-data state for the server empty-session envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          date: null,
          scope: '0dte',
          asOf: '2026-08-20T14:30:00.000Z',
          tickers: {
            SPY: { rows: [], metrics: metricsFixture() },
            QQQ: { rows: [], metrics: metricsFixture() },
          },
          divergence: divergenceFixture(),
        }),
      ),
    );

    render(<GreekFlowPanel marketOpen />);

    expect(
      await screen.findByText(/no greek flow data for the selected date/i),
    ).toBeInTheDocument();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('degrades a malformed metrics block to the neutral badges', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          date: '2026-08-20',
          scope: '0dte',
          asOf: '2026-08-20T14:30:00.000Z',
          tickers: {
            SPY: {
              rows: [rowFixture('SPY', '2026-08-20T14:30:00.000Z')],
              metrics: 'garbage',
            },
            QQQ: {
              rows: [rowFixture('QQQ', '2026-08-20T14:30:00.000Z')],
              metrics: { otm_dir_delta_flow: { slope: { slope: 'oops' } } },
            },
          },
          divergence: 'garbage',
        }),
      ),
    );

    render(<GreekFlowPanel marketOpen />);

    // Neutral verdict from the degraded divergence map — the same shape
    // the server sends for an empty session.
    const verdict = await screen.findByTestId('greek-flow-verdict');
    expect(verdict).toHaveAttribute('data-verdict-kind', 'no-trade');
    // Slope badges fall back to the "insufficient points" em dash.
    expect(
      screen.getAllByTitle(/insufficient points for slope/i).length,
    ).toBeGreaterThan(0);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('drops malformed rows/tickers but renders the valid ones', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          date: '2026-08-20',
          scope: '0dte',
          asOf: '2026-08-20T14:30:00.000Z',
          tickers: {
            SPY: {
              rows: [
                rowFixture('SPY', '2026-08-20T14:30:00.000Z'),
                // Malformed row — non-numeric cumulative. Dropped, not fatal.
                rowFixture('SPY', '2026-08-20T14:31:00.000Z', {
                  cum_otm_dir_delta_flow: 'oops',
                }),
              ],
              metrics: metricsFixture(),
            },
            // Malformed ticker entry — dropped; the panel degrades to the
            // "no rows" empty state rather than crashing.
            QQQ: 'garbage',
          },
          divergence: divergenceFixture(),
        }),
      ),
    );

    render(<GreekFlowPanel marketOpen />);

    // Verdict tile still renders from the valid divergence block.
    expect(await screen.findByTestId('greek-flow-verdict')).toBeInTheDocument();
    // Charts still render for the surviving ticker, and the dropped QQQ
    // bucket degrades to an empty chart instead of taking the panel down.
    expect(
      screen.getByLabelText(/SPY cumulative OTM Dir Delta/i),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/QQQ cumulative OTM Dir Delta/i),
    ).toBeInTheDocument();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
