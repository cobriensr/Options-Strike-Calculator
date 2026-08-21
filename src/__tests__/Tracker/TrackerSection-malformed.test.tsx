/**
 * TrackerSection × malformed /api/tracker/* payloads — crash regression
 * (client-shape-hardening-2026-08-20 follow-up).
 *
 * Unlike TrackerSection.test.tsx (which mocks both data hooks), this file
 * renders the REAL section + REAL useTrackerContracts / useTrackerAlerts
 * with only `fetch` stubbed, because the crash lives in the seam between
 * them: each hook cast its body straight to its response interface, so a
 * shapeless body (`{}`, an HTML error page parsed loosely, a 5xx JSON
 * blob) put `undefined` into `data` — and the section died on
 * `active.data.filter(...)` / `contracts.length`.
 *
 * Contract under test: a malformed envelope settles into the normal
 * empty/error state with ZERO console errors; a partially-valid envelope
 * drops only the malformed rows.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MockInstance } from 'vitest';

import { TrackerSection } from '../../components/Tracker';
import { ToastProvider } from '../../components/Toast';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A row shaped exactly like GET /api/tracker/contracts returns one. */
function validContract(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    occ_symbol: 'AAPL260508C00200000',
    ticker: 'AAPL',
    expiry: '2026-05-08',
    strike: '200',
    side: 'C',
    direction: 'long',
    entry_price: '0.85',
    quantity: 5,
    notes: null,
    status: 'active',
    closed_at: null,
    closed_price: null,
    up_thresholds: null,
    down_thresholds: null,
    spot_alerts: null,
    created_at: '2026-05-08T14:31:00Z',
    updated_at: '2026-05-08T14:31:00Z',
    latest_last: '1.20',
    latest_bid: '1.15',
    latest_ask: '1.25',
    latest_underlying: '205.10',
    latest_fetched_at: '2026-05-08T15:00:00Z',
    ...overrides,
  };
}

/** A row shaped exactly like GET /api/tracker/alerts/unread returns one. */
function validAlert(overrides: Record<string, unknown> = {}) {
  return {
    id: 11,
    contract_id: 1,
    fired_at: '2026-05-08T15:00:00Z',
    alert_type: 'up_pct',
    threshold: '50',
    price_at_fire: '1.30',
    underlying_at_fire: '205.10',
    acknowledged: false,
    occ_symbol: 'AAPL260508C00200000',
    ticker: 'AAPL',
    expiry: '2026-05-08',
    strike: '200',
    side: 'C',
    direction: 'long',
    entry_price: '0.85',
    quantity: 5,
    contract_status: 'active',
    ...overrides,
  };
}

/**
 * Route the section's fetches by URL: contracts list, unread alerts.
 * Anything unrouted gets an empty-but-valid body.
 */
function stubFetchRouter(bodies: {
  contracts?: unknown;
  alerts?: unknown;
}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/api/tracker/alerts/unread')) {
        return jsonResponse(bodies.alerts ?? { alerts: [], count: 0 });
      }
      if (url.includes('/api/tracker/contracts')) {
        return jsonResponse(bodies.contracts ?? { contracts: [], count: 0 });
      }
      return jsonResponse({});
    }),
  );
}

async function renderExpanded() {
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <TrackerSection marketOpen={true} />
    </ToastProvider>,
  );
  // The section is defaultCollapsed — both hooks stay disabled until the
  // user expands it, so nothing fetches before this click.
  await user.click(
    screen.getByRole('button', { name: /toggle contract tracker/i }),
  );
}

describe('TrackerSection — malformed payload crash regression', () => {
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

  it('settles into the empty state on a shapeless {} contracts payload with zero console errors', async () => {
    stubFetchRouter({ contracts: {}, alerts: {} });

    await renderExpanded();

    await waitFor(() =>
      expect(screen.getByText(/no contracts\./i)).toBeInTheDocument(),
    );
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('settles into the empty state on an HTML-ish string body with zero console errors', async () => {
    stubFetchRouter({
      contracts: '<!doctype html><html>oops</html>',
      alerts: '<!doctype html><html>oops</html>',
    });

    await renderExpanded();

    await waitFor(() =>
      expect(screen.getByText(/no contracts\./i)).toBeInTheDocument(),
    );
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('settles into the empty state on a 5xx-style JSON error blob with zero console errors', async () => {
    stubFetchRouter({
      contracts: { error: 'Internal error' },
      alerts: { error: 'Internal error' },
    });

    await renderExpanded();

    await waitFor(() =>
      expect(screen.getByText(/no contracts\./i)).toBeInTheDocument(),
    );
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('drops malformed contract rows but renders the valid ones', async () => {
    stubFetchRouter({
      contracts: {
        contracts: [
          validContract(),
          // Missing `expiry` — would blow up dteFromExpiry's `.split('-')`.
          validContract({ id: 2, ticker: 'NVDA', expiry: undefined }),
          // Wholesale garbage row.
          'garbage',
          null,
        ],
        count: 4,
      },
      alerts: { alerts: [], count: 0 },
    });

    await renderExpanded();

    expect(await screen.findByText(/AAPL/)).toBeInTheDocument();
    expect(screen.queryByText(/NVDA/)).not.toBeInTheDocument();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('keeps the contract rows when the alerts envelope is shapeless', async () => {
    stubFetchRouter({
      contracts: { contracts: [validContract()], count: 1 },
      alerts: {},
    });

    await renderExpanded();

    expect(await screen.findByText(/AAPL/)).toBeInTheDocument();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('drops malformed alert rows but keeps the valid one', async () => {
    // Far-dated expiry so watchlist membership depends ONLY on the
    // unread alert — the count proves the valid alert survived its
    // malformed neighbors instead of the whole batch being discarded.
    stubFetchRouter({
      contracts: {
        contracts: [validContract({ expiry: '2030-01-01' })],
        count: 1,
      },
      alerts: {
        alerts: [validAlert(), { id: 'nope' }, 'garbage', null],
        count: 4,
      },
    });

    await renderExpanded();

    expect(await screen.findByText(/AAPL/)).toBeInTheDocument();
    const watchlistTab = await screen.findByRole('tab', {
      name: /watchlist/i,
    });
    await waitFor(() => {
      expect(watchlistTab).toHaveTextContent(/watchlist\s*1/i);
    });
    expect(watchlistTab.textContent).not.toMatch(/NaN|undefined/);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
