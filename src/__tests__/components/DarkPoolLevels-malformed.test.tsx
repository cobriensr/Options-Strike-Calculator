/**
 * DarkPoolLevels × malformed /api/darkpool-levels payload — crash regression.
 *
 * Unlike DarkPoolLevels.test.tsx (which passes props directly), this file
 * renders the REAL component wired to the REAL useDarkPoolLevels hook the
 * same way App.tsx does, with only `fetch` mocked — because the production
 * crash lived in the seam between them:
 *
 * A shapeless response body (`{}`, an HTML error page parsed loosely, a
 * 5xx JSON blob) made the hook call `setLevels(data.levels)` with
 * `undefined`, so the component died on `levels.map` — and the hook itself
 * dereferenced `data.levels[0]` for the freshness timestamp fallback.
 *
 * Contract under test: on a malformed payload the panel settles into its
 * normal empty state (grace-counted, matching the non-ok failure path)
 * with ZERO console errors; malformed rows inside a valid envelope are
 * dropped without discarding the healthy rows.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { MockInstance } from 'vitest';
import DarkPoolLevels from '../../components/DarkPoolLevels';
import { useDarkPoolLevels } from '../../hooks/useDarkPoolLevels';

vi.mock('../../utils/auth', () => ({
  checkIsOwner: () => true,
  getAccessMode: () => 'owner',
}));

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Wire the real hook to the real component the way App.tsx does. */
function Harness() {
  const dp = useDarkPoolLevels(true);
  return (
    <DarkPoolLevels
      levels={dp.levels}
      loading={dp.loading}
      error={dp.error}
      fetchedAt={dp.fetchedAt}
      onRefresh={dp.refresh}
      selectedSymbol={dp.selectedSymbol}
      onSymbolChange={dp.setSelectedSymbol}
      selectedDate={dp.selectedDate}
      onDateChange={dp.setSelectedDate}
      scrubTime={dp.scrubTime}
      isLive={dp.isLive}
      isScrubbed={dp.isScrubbed}
      canScrubPrev={dp.canScrubPrev}
      canScrubNext={dp.canScrubNext}
      onScrubPrev={dp.scrubPrev}
      onScrubNext={dp.scrubNext}
      onScrubTo={dp.scrubTo}
      timeGrid={dp.timeGrid}
      onScrubLive={dp.scrubLive}
    />
  );
}

const EMPTY_STATE = /no dark pool levels available for this session/i;

describe('DarkPoolLevels — malformed payload crash regression', () => {
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

  it('settles into the empty state on a shapeless {} payload with zero console errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({})),
    );

    render(<Harness />);

    await waitFor(() =>
      expect(screen.getByText(EMPTY_STATE)).toBeInTheDocument(),
    );

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('settles into the empty state on a garbage object payload with zero console errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ unexpected: true })),
    );

    render(<Harness />);

    await waitFor(() =>
      expect(screen.getByText(EMPTY_STATE)).toBeInTheDocument(),
    );

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('settles into the empty state when the body is a bare JSON string with zero console errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse('<!doctype html><html>backend exploded</html>'),
      ),
    );

    render(<Harness />);

    await waitFor(() =>
      expect(screen.getByText(EMPTY_STATE)).toBeInTheDocument(),
    );

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('renders valid rows and drops malformed ones from a mixed payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          levels: [
            {
              level: 6575,
              totalPremium: 1_300_000_000,
              tradeCount: 13,
              totalShares: 2_000_000,
              latestTime: '2026-04-02T16:30:00Z',
              updatedAt: '2026-04-02T16:35:00Z',
            },
            // level arrives as a string — dropped.
            {
              level: '6590',
              totalPremium: 5_000_000,
              tradeCount: 2,
              totalShares: 10_000,
              latestTime: null,
              updatedAt: '2026-04-02T16:35:00Z',
            },
            null,
            42,
            {
              level: 6600,
              totalPremium: 900_000_000,
              tradeCount: 9,
              totalShares: 1_500_000,
              latestTime: null,
              updatedAt: '2026-04-02T16:36:00Z',
            },
          ],
          date: '2026-04-02',
          meta: { lastUpdated: '2026-04-02T16:36:00Z' },
        }),
      ),
    );

    render(<Harness />);

    await waitFor(() => expect(screen.getByText('6575')).toBeInTheDocument());
    expect(screen.getByText('6600')).toBeInTheDocument();
    expect(screen.queryByText('6590')).not.toBeInTheDocument();

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
