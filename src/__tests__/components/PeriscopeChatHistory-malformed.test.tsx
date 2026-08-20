/**
 * PeriscopeChatHistory × malformed /api/periscope-chat-list payloads —
 * crash regression.
 *
 * Unlike PeriscopeChatHistory.test.tsx (happy paths), this file feeds the
 * REAL component shapeless/garbage bodies through a mocked `fetch`,
 * because the production crash lived at the parse seam:
 *
 *   const data = (await res.json()) as { dates: DateEntry[] };
 *   setDates(data.dates); // {} → undefined → dates.length throws
 *
 * A `{}` body (5xx JSON blob, loosely-parsed HTML error page) put
 * `undefined` into `dates` / `items` state, and the next render threw
 * straight into the section ErrorBoundary.
 *
 * Contract under test: on a malformed payload the panel settles into its
 * normal empty state with ZERO console errors; malformed rows inside a
 * valid envelope are dropped, never fatal.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MockInstance } from 'vitest';
import type { ReactNode } from 'react';

// Stub SectionBox so its `defaultCollapsed` doesn't hide our content
// from the tests (same stub as PeriscopeChatHistory.test.tsx).
vi.mock('../../components/ui/SectionBox', () => ({
  SectionBox: ({ children }: { children: ReactNode }) => (
    <section>{children}</section>
  ),
}));

import PeriscopeChatHistory from '../../components/PeriscopeChat/PeriscopeChatHistory';

// ============================================================
// Fixtures + helpers
// ============================================================

const validDateEntry = {
  date: '2026-04-30',
  total: 2,
  reads: 1,
  pre_trades: 1,
  intradays: 0,
  debriefs: 1,
};

const validSummary = {
  id: 5,
  trading_date: '2026-04-30',
  captured_at: '2026-04-30T13:30:00Z',
  mode: 'intraday',
  parent_id: null,
  spot: 7120,
  long_trigger: 7125,
  short_trigger: 7115,
  regime_tag: null,
  calibration_quality: null,
  prose_excerpt: 'Valid surviving row.',
  duration_ms: 4500,
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Route the two list queries: `?dates=true` vs `?date=YYYY-MM-DD`. */
function stubRoutes(datesBody: unknown, itemsBody: unknown = { items: [] }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo) => {
      const u = typeof url === 'string' ? url : (url as Request).url;
      if (u.includes('dates=true')) return jsonResponse(datesBody);
      return jsonResponse(itemsBody);
    }),
  );
}

describe('<PeriscopeChatHistory /> — malformed payloads', () => {
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

  it('settles into the empty state on a shapeless {} dates payload', async () => {
    stubRoutes({});

    render(<PeriscopeChatHistory />);

    await waitFor(() => {
      expect(screen.getByText(/no saved analyses yet/i)).toBeInTheDocument();
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('settles into the empty state on a garbage string dates payload', async () => {
    stubRoutes('<html>Internal Server Error</html>');

    render(<PeriscopeChatHistory />);

    await waitFor(() => {
      expect(screen.getByText(/no saved analyses yet/i)).toBeInTheDocument();
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('drops malformed date entries and keeps the valid ones', async () => {
    stubRoutes({
      dates: [
        validDateEntry,
        null,
        'garbage',
        { date: 42, total: 1, reads: 1, debriefs: 0 },
        { date: '2026-04-29' }, // missing counts
        { ...validDateEntry, total: 'many' }, // non-numeric count
      ],
    });

    render(<PeriscopeChatHistory />);

    await waitFor(() => {
      expect(
        screen.getByRole('option', { name: /Apr 30, 2026/ }),
      ).toBeInTheDocument();
    });
    // Only the sentinel + the single surviving date remain.
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('settles into the no-rows state on a shapeless {} items payload', async () => {
    stubRoutes({ dates: [validDateEntry] }, {});
    const user = userEvent.setup();

    render(<PeriscopeChatHistory />);

    await waitFor(() => {
      expect(
        screen.getByRole('option', { name: /Apr 30, 2026/ }),
      ).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByLabelText('Date'), '2026-04-30');

    await waitFor(() => {
      expect(screen.getByText(/no rows for/i)).toBeInTheDocument();
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('drops malformed item rows and renders the valid ones', async () => {
    stubRoutes(
      { dates: [validDateEntry] },
      {
        items: [
          validSummary,
          null,
          'junk',
          { id: 6 }, // missing everything else
          { ...validSummary, id: 7, mode: 'weird' }, // unknown mode
          { ...validSummary, id: 8, spot: 'high' }, // non-numeric spot
        ],
      },
    );
    const user = userEvent.setup();

    render(<PeriscopeChatHistory />);

    await waitFor(() => {
      expect(
        screen.getByRole('option', { name: /Apr 30, 2026/ }),
      ).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByLabelText('Date'), '2026-04-30');

    await waitFor(() => {
      expect(screen.getByText('Valid surviving row.')).toBeInTheDocument();
    });
    // Row-count label reflects the single survivor.
    expect(screen.getByText(/1 rows/)).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
