/**
 * Regime0dte × malformed /api/regime-0dte payload — crash regression
 * (client-shape-hardening-2026-08-20, final straggler).
 *
 * Unlike Regime0dte.test.tsx (happy paths with the hook mocked), this
 * file feeds the REAL panel + REAL useRegime0dte hook shapeless bodies
 * with only `fetch` mocked, because the vulnerability lived in the seam
 * between them: `usePolledWindowSignal` identity-cast `res.json()` (and
 * the localStorage last-good read), so a `{}` / loosely-parsed HTML /
 * 5xx JSON body reached the render pass as-is.
 *
 * Contract under test: a malformed envelope settles into the normal
 * error + waiting state with ZERO console errors; a partially-valid
 * envelope drops only the malformed series rows and degrades bad
 * optional fields to the sub-viz placeholders.
 *
 * Modeled on OpeningFlowSignal-malformed.test.tsx.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { MockInstance } from 'vitest';

const { getCTTimeMock } = vi.hoisted(() => ({
  // 10:00 CT — inside the 08:30–15:00 session window, so the hook's
  // eager mount fetch fires. Real timers; the 45s poll never ticks
  // mid-test.
  getCTTimeMock: vi.fn(() => ({ hour: 10, minute: 0 })),
}));

vi.mock('../../utils/timezone', async () => {
  const actual = await vi.importActual<typeof import('../../utils/timezone')>(
    '../../utils/timezone',
  );
  return { ...actual, getCTTime: getCTTimeMock };
});

import Regime0dte from '../../components/Regime0dte';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A well-formed envelope (graded scalars + triggers) to corrupt per-test. */
function validEnvelope() {
  return {
    date: '2026-08-20',
    asOfCtMin: 600,
    gate: 'lean_down',
    gexNearSpot: -2.1e10,
    gexAtOpen: -1.8e10,
    flipStrike: 5900,
    flipMinusOpenPct: -0.4,
    triggers: {
      mostlyRed: { fired: true, atCtMin: 660, green: 1, red: 4 },
      ivBreak: { fired: false, atCtMin: null, magPct: null, refHi: 0.31 },
      middayDeepNeg: { fired: false, atCtMin: null, gexMid: null },
    },
    note: 'deep negative gamma — downside lean',
  };
}

describe('Regime0dte — malformed payload crash regression', () => {
  let consoleErrorSpy: MockInstance;

  beforeEach(() => {
    localStorage.clear();
    getCTTimeMock.mockReturnValue({ hour: 10, minute: 0 });
    consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('settles into the error + waiting state on a shapeless {} payload with zero console errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({})),
    );

    render(<Regime0dte />);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /unexpected response shape/i,
      ),
    );
    // The normal no-data placeholder still renders — no crash, no
    // ErrorBoundary remount.
    expect(screen.getByText(/waiting for the open/i)).toBeInTheDocument();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('settles into the error + waiting state on an HTML-ish string body with zero console errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse('<!doctype html><html>oops</html>')),
    );

    render(<Regime0dte />);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /unexpected response shape/i,
      ),
    );
    expect(screen.getByText(/waiting for the open/i)).toBeInTheDocument();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('drops malformed series rows but renders the panel from the valid remainder', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          ...validEnvelope(),
          // One valid row survives; the bad-typed row drops.
          gexStrikes: [
            { strike: 5900, netGex: -2.1e10 },
            { strike: 'oops', netGex: -1 },
          ],
          // Every row malformed → empty series → sub-viz placeholder.
          putIv: [{ ctMin: 'x', iv: 0.3 }, 'garbage'],
          // Present-but-malformed optional field → degraded, not fatal.
          candles30: 'nope',
        }),
      ),
    );

    render(<Regime0dte />);

    // The graded gate chip renders from the valid scalars. (Matched via
    // its aria-label — the plain text also appears in the SectionBox badge.)
    expect(
      await screen.findByLabelText(/gamma gate: lean down/i),
    ).toBeInTheDocument();
    // The surviving gamma row draws the profile viz.
    expect(
      screen.getByRole('img', { name: /net gamma exposure by strike/i }),
    ).toBeInTheDocument();
    // All-dropped putIv rows and the degraded candles30 fall back to the
    // sub-viz empty placeholders instead of crashing.
    expect(
      screen.getByRole('img', { name: /put-iv series unavailable/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /candle strip unavailable/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
