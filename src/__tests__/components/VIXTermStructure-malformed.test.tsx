/**
 * VIXTermStructure × malformed /api/vix-snapshots-recent payload — crash
 * regression (client-shape-hardening-2026-08-20, follow-up sweep).
 *
 * Feeds the REAL panel + REAL useVixTrajectory hook shapeless bodies
 * with only `fetch` (and the owner probe) stubbed. The hook's `(await
 * res.json()) as { snapshots?: VixSnapshot[] }` identity cast hands the
 * array straight to `deriveTrajectory`, which iterates it and reads
 * `.vix` / `.vix1d` / `.entryTime` off every element.
 *
 * Contract under test: a malformed envelope leaves the panel in its
 * normal no-trajectory state with ZERO console errors, and a partially
 * valid envelope still computes the trajectory from the rows that ARE
 * well-formed instead of discarding the whole payload.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { MockInstance } from 'vitest';

vi.mock('../../utils/auth', () => ({
  checkIsOwner: vi.fn(() => true),
  getAccessMode: vi.fn(() => 'owner'),
}));

import VIXTermStructure from '../../components/VIXTermStructure';

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

/** A row shaped exactly like `getRecentVixSnapshots` in db-snapshots.ts. */
function snap(overrides: Record<string, unknown> = {}) {
  return {
    entryTime: '11:30 AM',
    vix: 17,
    vix1d: 14.45,
    vix9d: 16,
    spx: 6900,
    ...overrides,
  };
}

/**
 * The panel renders both ratio cards for these props; the trajectory
 * line is the only thing the hook contributes, so "no trajectory" is
 * the empty state under test.
 */
function renderPanel() {
  return render(<VIXTermStructure vix={17} marketOpen={false} />);
}

async function expectCardsWithoutTrajectory(): Promise<void> {
  await waitFor(() =>
    expect(screen.getByText('VIX1D / VIX')).toBeInTheDocument(),
  );
  expect(screen.getByText('VIX9D / VIX')).toBeInTheDocument();
  expect(screen.queryByLabelText(/15-minute change/i)).toBeNull();
}

describe('VIXTermStructure — malformed payload crash regression', () => {
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

  it('renders without a trajectory on a shapeless {} payload with zero console errors', async () => {
    stubFetch({});

    renderPanel();

    await expectCardsWithoutTrajectory();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('renders without a trajectory on an HTML-ish string body with zero console errors', async () => {
    stubFetch('<!doctype html><html><body>502 Bad Gateway</body></html>');

    renderPanel();

    await expectCardsWithoutTrajectory();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('renders without a trajectory when `snapshots` is a non-array object', async () => {
    stubFetch({ date: '2026-08-20', snapshots: { '0': snap() } });

    renderPanel();

    await expectCardsWithoutTrajectory();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('drops malformed snapshots but still computes the trajectory from the valid ones', async () => {
    stubFetch({
      date: '2026-08-20',
      snapshots: [
        snap({ entryTime: '11:30 AM', vix: 17, vix1d: 14.45 }), // ratio 0.85
        // Null row — `deriveTrajectory` previously died reading `.vix1d`.
        null,
        // Non-numeric vix — must not poison the series.
        snap({ entryTime: '11:38 AM', vix: 'oops', vix1d: 15 }),
        snap({ entryTime: '11:45 AM', vix: 17, vix1d: 16.15 }), // ratio 0.95
      ],
    });

    renderPanel();

    // Both valid rows survive → VIX1D/VIX climbs +0.10 over a 15-minute
    // span, and VIX9D/VIX (flat at 16/17 in both rows) reads ±0.00 over
    // the same span. Before the fix, the single null row discarded the
    // whole payload and neither line appeared.
    await waitFor(() =>
      expect(
        screen.getByLabelText(/15-minute change \+0\.10/),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByLabelText(/15-minute change ±0\.00/),
    ).toBeInTheDocument();
    expect(screen.getAllByText('/ 15m')).toHaveLength(2);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
