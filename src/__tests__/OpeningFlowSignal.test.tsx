import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { getCTTimeMock } = vi.hoisted(() => ({
  getCTTimeMock: vi.fn(() => ({ hour: 8, minute: 30 })),
}));

vi.mock('../utils/timezone', async () => {
  const actual =
    await vi.importActual<typeof import('../utils/timezone')>(
      '../utils/timezone',
    );
  return { ...actual, getCTTime: getCTTimeMock };
});

import { OpeningFlowSignal } from '../components/OpeningFlowSignal';
import type {
  OpeningFlowResponse,
  OpeningFlowTicket,
} from '../hooks/useOpeningFlowSignal';

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

function makeTicket(
  side: 'call' | 'put',
  strike: number,
  premium: number,
  volume: number,
  avgFill: number,
): OpeningFlowTicket {
  return { strike, side, premium, volume, avgFill };
}

function makeResponse(
  overrides: Partial<OpeningFlowResponse> = {},
): OpeningFlowResponse {
  return {
    date: '2026-05-13',
    windowStatus: 'closed',
    openUtc: '2026-05-13T13:30:00Z',
    slice1EndUtc: '2026-05-13T13:35:00Z',
    slice2EndUtc: '2026-05-13T13:40:00Z',
    asOfUtc: '2026-05-13T14:30:00Z',
    stopPct: 0.3,
    exitMinutesFromEntry: 60,
    tickers: {
      SPY: { slice1: null, slice2: null, signal: null },
      QQQ: { slice1: null, slice2: null, signal: null },
    },
    ...overrides,
  };
}

describe('OpeningFlowSignal', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    getCTTimeMock.mockReset();
    getCTTimeMock.mockReturnValue({ hour: 8, minute: 30 });
  });

  it('renders the section header', () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeResponse({ windowStatus: 'before_open' }),
    });
    render(<OpeningFlowSignal />);
    expect(
      screen.getByRole('heading', { name: /opening flow signal/i }),
    ).toBeInTheDocument();
  });

  it('shows "Outside the signal window" message when not in window', () => {
    getCTTimeMock.mockReturnValue({ hour: 10, minute: 0 });
    render(<OpeningFlowSignal />);
    expect(screen.getByText(/outside the signal window/i)).toBeInTheDocument();
  });

  it('renders SPY signal card with BUY action when rule fires', async () => {
    const contract = makeTicket('call', 745, 3_350_000, 24_683, 1.36);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () =>
        makeResponse({
          windowStatus: 'closed',
          tickers: {
            SPY: {
              slice1: {
                tickets: [contract],
                callPremium: 3_350_000,
                putPremium: 0,
                biasSide: 'call',
                biasRatio: 1,
                top3SameSide: true,
              },
              slice2: {
                totalPremium: 12_710_000,
                biasPremium: 9_910_000,
                biasShare: 0.78,
                confirms: true,
              },
              signal: {
                fired: true,
                side: 'call',
                contract,
                entryPrice: 1.36,
              },
            },
            QQQ: { slice1: null, slice2: null, signal: null },
          },
        }),
    });
    render(<OpeningFlowSignal />);
    expect(await screen.findByText(/BUY 745C 0DTE/i)).toBeInTheDocument();
    expect(screen.getByText(/24,683 contracts/i)).toBeInTheDocument();
  });

  it('shows the blocking reason when rule does not fire', async () => {
    const c1 = makeTicket('call', 745, 3_350_000, 24_683, 1.36);
    const c2 = makeTicket('put', 743, 1_170_000, 11_223, 1.05);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () =>
        makeResponse({
          windowStatus: 'closed',
          tickers: {
            SPY: {
              slice1: {
                tickets: [c1, c2],
                callPremium: 3_350_000,
                putPremium: 1_170_000,
                biasSide: 'call',
                biasRatio: 0.74,
                top3SameSide: false,
              },
              slice2: {
                totalPremium: 0,
                biasPremium: 0,
                biasShare: 0.55,
                confirms: false,
              },
              signal: { fired: false, reason: 'top3_mixed' },
            },
            QQQ: { slice1: null, slice2: null, signal: null },
          },
        }),
    });
    render(<OpeningFlowSignal />);
    expect(
      await screen.findByText(/top-3 tickets split across both sides/i),
    ).toBeInTheDocument();
  });
});
