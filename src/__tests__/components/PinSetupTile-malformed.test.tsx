/**
 * PinSetupTile × malformed /api/pin-setup-status payload — crash
 * regression (client-shape-hardening-2026-08-20, Phase A).
 *
 * Unlike PinSetupTile.test.tsx (which mocks usePinSetupStatus), this
 * file renders the REAL tile + REAL hook with only `fetch` mocked,
 * because the production crash lived in the seam between them: a `{}` /
 * loosely-parsed HTML / 5xx JSON body reached the render pass and died
 * at `data.state.replace` (`state` missing or non-string), remounting
 * the section ErrorBoundary.
 *
 * Contract under test: a malformed envelope settles into the normal
 * error state with ZERO console errors; a partially-valid envelope
 * drops only the malformed rows (trajectory points, trade-type chips).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { MockInstance } from 'vitest';

import PinSetupTile from '../../components/PinSetupTile';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('PinSetupTile — malformed payload crash regression', () => {
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

    render(<PinSetupTile marketOpen={false} />);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /unexpected response shape/i,
      ),
    );
    // Header still renders; the state badge (the crash site) does not.
    expect(screen.getByText(/0DTE Pin Setup/i)).toBeInTheDocument();
    expect(screen.queryByTestId('pin-setup-state-badge')).toBeNull();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('settles into the error state on a garbage payload with zero console errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ unexpected: true })),
    );

    render(<PinSetupTile marketOpen={false} />);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /unexpected response shape/i,
      ),
    );
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('settles into the error state on an HTML-ish string body with zero console errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse('<!doctype html><html>oops</html>')),
    );

    render(<PinSetupTile marketOpen={false} />);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /unexpected response shape/i,
      ),
    );
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('drops malformed rows but renders the valid ones', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          evaluatedAt: '2026-08-20T18:00:00Z',
          date: null,
          mode: 'live',
          snapshotTs: '2026-08-20T17:59:00Z',
          staleMinutes: 1,
          state: 'ARMED',
          conditions: {
            netGammaAtMagnetM: 41751,
            netGammaThresholdM: 20000,
            netGammaMet: true,
            magnetStrike: 7500,
            isRound50: true,
            distanceToMagnet: -0.9,
            distanceThreshold: 15,
            distanceMet: true,
          },
          spot: 7499.1,
          bias: 'full-pin',
          // Non-string entry dropped; the two valid chips render.
          recommendedTradeTypes: ['iron_condor', 42, 'iron_butterfly'],
          avoidedTradeTypes: ['directional_long_call'],
          trajectory: [
            { ts: '13:31', gammaDirM: 1000, spot: 7460 },
            // Malformed point — non-numeric gammaDirM. Dropped, not fatal.
            { ts: '13:45', gammaDirM: 'oops', spot: 7470 },
            { ts: '14:00', gammaDirM: 5000, spot: 7480 },
            { ts: '14:30', gammaDirM: 9000, spot: null },
          ],
          outcome: null,
          asOf: '2026-08-20T18:00:00Z',
        }),
      ),
    );

    render(<PinSetupTile marketOpen={false} />);

    await waitFor(() =>
      expect(screen.getByTestId('pin-setup-state-badge')).toHaveTextContent(
        'ARMED',
      ),
    );
    expect(screen.getByText('7500')).toBeInTheDocument();
    // Valid trade-type chips render; the numeric junk entry is dropped.
    expect(screen.getByText(/iron condor/)).toBeInTheDocument();
    expect(screen.getByText(/iron butterfly/)).toBeInTheDocument();
    expect(screen.queryByText('42')).toBeNull();
    // 3 valid trajectory points survive → the sparkline SVG renders.
    expect(
      screen.getByRole('img', { name: /gamma_dir intraday trajectory/i }),
    ).toBeInTheDocument();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
