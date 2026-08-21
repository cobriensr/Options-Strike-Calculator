/**
 * OpeningFlowSignal × malformed /api/opening-flow-signal payload — crash
 * regression (client-shape-hardening-2026-08-20, Phase A).
 *
 * Unlike OpeningFlowSignal.test.tsx (happy paths), this file feeds the
 * REAL component + REAL useOpeningFlowSignal hook shapeless bodies with
 * only `fetch` mocked, because the production crash lived in the seam
 * between them: a `{}` / loosely-parsed HTML / 5xx JSON body reached the
 * render pass and died at `displayData.tickers[ticker]` (`tickers`
 * missing or non-object), remounting the section ErrorBoundary.
 *
 * Contract under test: a malformed envelope settles into the normal
 * error/empty state with ZERO console errors; a partially-valid envelope
 * drops only the malformed rows.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { MockInstance } from 'vitest';

const { getCTTimeMock } = vi.hoisted(() => ({
  // 10:00 CT — outside the 08:25–08:50 signal window, so live mode does
  // its single eager fetch and never polls mid-test.
  getCTTimeMock: vi.fn(() => ({ hour: 10, minute: 0 })),
}));

vi.mock('../../utils/timezone', async () => {
  const actual = await vi.importActual<typeof import('../../utils/timezone')>(
    '../../utils/timezone',
  );
  return { ...actual, getCTTime: getCTTimeMock };
});

import { OpeningFlowSignal } from '../../components/OpeningFlowSignal';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('OpeningFlowSignal — malformed payload crash regression', () => {
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

  it('settles into the error + empty state on a shapeless {} payload with zero console errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({})),
    );

    render(<OpeningFlowSignal />);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /unexpected response shape/i,
      ),
    );
    // The normal outside-window empty state still renders — no crash,
    // no ErrorBoundary remount.
    expect(screen.getByText(/outside the signal window/i)).toBeInTheDocument();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('settles into the error + empty state on a garbage payload with zero console errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ unexpected: true })),
    );

    render(<OpeningFlowSignal />);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /unexpected response shape/i,
      ),
    );
    expect(screen.getByText(/outside the signal window/i)).toBeInTheDocument();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('settles into the error + empty state on an HTML-ish string body with zero console errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse('<!doctype html><html>oops</html>')),
    );

    render(<OpeningFlowSignal />);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /unexpected response shape/i,
      ),
    );
    expect(screen.getByText(/outside the signal window/i)).toBeInTheDocument();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('drops malformed rows but renders the valid ones', async () => {
    const validTicket = {
      strike: 745,
      side: 'call',
      premium: 3_350_000,
      volume: 24_683,
      avgFill: 1.36,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          date: '2026-08-20',
          windowStatus: 'closed',
          openUtc: '2026-08-20T13:30:00Z',
          slice1EndUtc: '2026-08-20T13:35:00Z',
          slice2EndUtc: '2026-08-20T13:40:00Z',
          asOfUtc: '2026-08-20T14:30:00Z',
          stopPct: 0.3,
          exitMinutesFromEntry: 60,
          tickers: {
            SPY: {
              slice1: {
                tickets: [
                  validTicket,
                  // Malformed ticket — non-numeric strike. Dropped, not fatal.
                  { strike: 'oops', side: 'call', premium: 1, volume: 1 },
                ],
                callPremium: 3_350_000,
                putPremium: 0,
                biasSide: 'call',
                biasRatio: 1,
                top3SameSide: true,
              },
              slice2: null,
              signal: { fired: false, reason: 'window_not_complete' },
            },
            // Malformed ticker row — dropped; the card falls back to its
            // own "waiting" empty state instead of crashing.
            QQQ: 'garbage',
          },
        }),
      ),
    );

    render(<OpeningFlowSignal />);

    // SPY: only the ONE valid ticket survives the parse.
    expect(
      await screen.findByText(/slice 1 tickets \(1 qualifying\)/i),
    ).toBeInTheDocument();
    // QQQ: dropped row renders the per-card empty state.
    expect(
      screen.getByText(/waiting for the 08:30 CT slice to open/i),
    ).toBeInTheDocument();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
