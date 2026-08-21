/**
 * PeriscopePanel × malformed /api/periscope-map payload — crash
 * regression (client-shape-hardening-2026-08-20, follow-up sweep).
 *
 * PeriscopePanel.test.tsx renders the panel from hand-built props; this
 * file wires the REAL `usePeriscopeExposure` hook to the REAL panel the
 * same way App.tsx does, with only `fetch` stubbed, because the crash
 * lives in the seam: the hook's `(await res.json()) as
 * PeriscopeExposureResponse` identity cast let a shapeless body reach
 * `computeTradePlan(view)` (`breaches.find`, `gamma.ceiling`) and
 * `view.spot.toFixed(2)` / `isoToCtDate(view.capturedAt)` in the render
 * pass.
 *
 * Contract under test: a malformed envelope settles into the panel's
 * normal empty/error state with ZERO console errors; a partially-valid
 * view keeps the readable structure and drops only the bad rows.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import type { MockInstance } from 'vitest';

vi.mock('../../utils/auth', () => ({
  getAccessMode: vi.fn(() => 'owner'),
}));

import { usePeriscopeExposure } from '../../hooks/usePeriscopeExposure';
import type { PeriscopeSelectedSlot } from '../../hooks/usePeriscopeExposure';
import { PeriscopePanel } from '../../components/Periscope/PeriscopePanel';

/** Mirrors the App.tsx wiring of hook → panel. */
function Harness() {
  const [slot, setSlot] = useState<PeriscopeSelectedSlot | null>(null);
  const periscope = usePeriscopeExposure({
    marketOpen: true,
    spotHint: null,
    selectedSlot: slot,
  });
  return (
    <PeriscopePanel
      view={periscope.view}
      emptyReason={periscope.emptyReason}
      asOf={periscope.asOf}
      loading={periscope.loading}
      error={periscope.error}
      onRefresh={periscope.refresh}
      availableSlots={periscope.availableSlots}
      selectedSlot={slot}
      onSelectSlot={setSlot}
    />
  );
}

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

describe('PeriscopePanel — malformed payload crash regression', () => {
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

  it('renders the empty state on a shapeless {} payload with zero console errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({})),
    );

    render(<Harness />);

    expect(
      await screen.findByText(/no gexbot capture for today yet/i),
    ).toBeInTheDocument();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('renders the error state on a JSON string body with zero console errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse('<!doctype html><html>oops</html>')),
    );

    render(<Harness />);

    expect(
      await screen.findByText(/unexpected response shape/i),
    ).toBeInTheDocument();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('renders the error state on an unparseable HTML body with zero console errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => rawResponse('<!doctype html><html>oops</html>')),
    );

    render(<Harness />);

    await waitFor(() =>
      expect(
        screen.queryByText(/no gexbot capture for today yet/i),
      ).not.toBeInTheDocument(),
    );
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('renders the error state when `data` is a garbage scalar', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          marketOpen: true,
          asOf: '2026-08-20T14:30:00.000Z',
          data: 'garbage',
          availableSlots: [],
        }),
      ),
    );

    render(<Harness />);

    expect(
      await screen.findByText(/unexpected response shape/i),
    ).toBeInTheDocument();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('renders the empty state on the server no_slot envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          marketOpen: true,
          asOf: '2026-08-20T14:30:00.000Z',
          data: null,
          reason: 'no_spot',
          availableSlots: [],
        }),
      ),
    );

    render(<Harness />);

    expect(
      await screen.findByText(/waiting for spx spot/i),
    ).toBeInTheDocument();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('renders the error state when the view is missing whole sub-objects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          marketOpen: true,
          asOf: '2026-08-20T14:30:00.000Z',
          data: {
            capturedAt: '2026-08-20T14:30:00.000Z',
            expiry: '2026-08-20',
            spot: 5800,
            gamma: {
              ceiling: null,
              floor: null,
              accelTop: [],
              topByAbsNear: [],
            },
            // charm / vanna / signFlips / cone / breaches all absent.
          },
          availableSlots: [],
        }),
      ),
    );

    render(<Harness />);

    expect(
      await screen.findByText(/unexpected response shape/i),
    ).toBeInTheDocument();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('drops unparseable availableSlots entries instead of throwing in the picker', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          marketOpen: true,
          asOf: '2026-08-20T14:30:00.000Z',
          data: null,
          reason: 'no_slot',
          availableSlots: ['2026-08-20T14:30:00.000Z', 'not-a-date', 42],
        }),
      ),
    );

    render(<Harness />);

    await waitFor(() =>
      expect(
        screen.getByRole('combobox', { name: /periscope slot time/i }),
      ).toBeEnabled(),
    );
    expect(screen.getAllByRole('option')).toHaveLength(2); // placeholder + 1
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('drops malformed ranked rows but renders the valid view', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          marketOpen: true,
          asOf: '2026-08-20T14:30:00.000Z',
          data: {
            capturedAt: '2026-08-20T14:30:00.000Z',
            priorCapturedAt: null,
            expiry: '2026-08-20',
            spot: 5800,
            gamma: {
              ceiling: { strike: 5850, value: 5_000_000, ptsFromSpot: 50 },
              floor: { strike: 5750, value: 4_000_000, ptsFromSpot: -50 },
              accelTop: [
                { strike: 5740, value: -3_000_000, ptsFromSpot: -60 },
                // Malformed — non-numeric strike. Dropped, not fatal.
                { strike: 'oops', value: -1, ptsFromSpot: 0 },
              ],
              topByAbsNear: [{ strike: 5800, value: 1_000_000 }, 'garbage'],
            },
            charm: {
              tallyNear50: 0,
              tallyWide100: 0,
              topByAbs: [{ strike: 5800, value: 500_000 }],
              charmZeroStrike: null,
            },
            vanna: { topByAbs: [{ strike: 5800, value: 400_000 }] },
            // Malformed flip entry — dropped.
            signFlips: [{ strike: 5790, from: -1, to: 1 }, null],
            cone: null,
            breaches: [],
          },
          availableSlots: ['2026-08-20T14:30:00.000Z'],
        }),
      ),
    );

    render(<Harness />);

    // Header slot line + spot render from the surviving view.
    expect(await screen.findByText(/spot 5800\.00/i)).toBeInTheDocument();
    expect(screen.getByText(/MM Exposure Map/i)).toBeInTheDocument();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
