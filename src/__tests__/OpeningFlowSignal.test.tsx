import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { getCTTimeMock, getCTDateStrMock } = vi.hoisted(() => ({
  getCTTimeMock: vi.fn(() => ({ hour: 8, minute: 30 })),
  getCTDateStrMock: vi.fn(() => '2026-05-13'),
}));

vi.mock('../utils/timezone', async () => {
  const actual =
    await vi.importActual<typeof import('../utils/timezone')>(
      '../utils/timezone',
    );
  return {
    ...actual,
    getCTTime: getCTTimeMock,
    getCTDateStr: getCTDateStrMock,
  };
});

import { OpeningFlowSignal } from '../components/OpeningFlowSignal';
import { buildOcc } from '../components/OpeningFlowSignal/buildOcc';
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
    getCTDateStrMock.mockReset();
    getCTDateStrMock.mockReturnValue('2026-05-13');
    localStorage.clear();
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

  it('shows "Outside the signal window" message when not in window and no cache', () => {
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

  it('persists last-good payload to localStorage after a successful fetch', async () => {
    const contract = makeTicket('call', 745, 3_350_000, 24_683, 1.36);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () =>
        makeResponse({
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
              slice2: null,
              signal: { fired: false, reason: 'window_not_complete' },
            },
            QQQ: { slice1: null, slice2: null, signal: null },
          },
        }),
    });
    render(<OpeningFlowSignal />);
    // Wait for the slice1 tickets section to render — that proves the
    // fetch resolved and state has been written.
    await screen.findByText(/Slice 1 tickets/i);
    const raw = localStorage.getItem('openingFlowSignal.lastGood');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as {
      date: string;
      data: OpeningFlowResponse;
    };
    expect(parsed.date).toBe('2026-05-13');
    expect(parsed.data.tickers.SPY?.slice1?.tickets[0]?.strike).toBe(745);
  });

  it('rehydrates from cache on mount when same CT date — even outside window', () => {
    // Outside polling window — ensures we'd otherwise see the
    // "Outside the signal window" message.
    getCTTimeMock.mockReturnValue({ hour: 12, minute: 0 });
    const contract = makeTicket('put', 740, 2_100_000, 12_500, 0.95);
    const cached: OpeningFlowResponse = makeResponse({
      tickers: {
        SPY: {
          slice1: {
            tickets: [contract],
            callPremium: 0,
            putPremium: 2_100_000,
            biasSide: 'put',
            biasRatio: 1,
            top3SameSide: true,
          },
          slice2: null,
          signal: { fired: false, reason: 'window_not_complete' },
        },
        QQQ: { slice1: null, slice2: null, signal: null },
      },
    });
    localStorage.setItem(
      'openingFlowSignal.lastGood',
      JSON.stringify({
        data: cached,
        savedAt: new Date().toISOString(),
        date: '2026-05-13',
      }),
    );

    render(<OpeningFlowSignal />);

    // Cached payload should drive the UI even though no fetch ran.
    expect(screen.getByText(/Slice 1 tickets/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/outside the signal window/i),
    ).not.toBeInTheDocument();
  });

  it('preserves cross-day cache on mount (last-good semantics)', () => {
    // Pin the bug Wonce reported: at 12:32 AM CT Tuesday, the panel
    // was showing the empty "Outside the signal window" state because
    // the prior eviction rule wiped the cache the moment CT date
    // rolled over. New rule: the cache survives across CT dates and
    // only gets overwritten when a fresh fetch lands. Revisiting the
    // panel after midnight still shows the previous session's tickets
    // until the next morning's slice-1 data arrives.
    getCTTimeMock.mockReturnValue({ hour: 0, minute: 32 });
    const cached: OpeningFlowResponse = makeResponse({ date: '2026-05-13' });
    localStorage.setItem(
      'openingFlowSignal.lastGood',
      JSON.stringify({
        data: cached,
        savedAt: '2026-05-13T20:00:00Z',
        date: '2026-05-13',
      }),
    );

    render(<OpeningFlowSignal />);

    // Cache must NOT be wiped — the row data is the user's only
    // record of the previous session's signal until the next fetch.
    expect(localStorage.getItem('openingFlowSignal.lastGood')).not.toBeNull();
    // Tickets render from cache; empty-state message must NOT appear.
    expect(
      screen.queryByText(/outside the signal window/i),
    ).not.toBeInTheDocument();
  });

  it('renders call ticket with emerald chip and a UW anchor with correct OCC', async () => {
    const callT = makeTicket('call', 745, 3_350_000, 24_683, 1.36);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () =>
        makeResponse({
          windowStatus: 'closed',
          tickers: {
            SPY: {
              slice1: {
                tickets: [callT],
                callPremium: 3_350_000,
                putPremium: 0,
                biasSide: 'call',
                biasRatio: 1,
                top3SameSide: true,
              },
              slice2: null,
              signal: { fired: false, reason: 'window_not_complete' },
            },
            QQQ: { slice1: null, slice2: null, signal: null },
          },
        }),
    });
    render(<OpeningFlowSignal />);
    await screen.findByText(/Slice 1 tickets/i);
    const occ = buildOcc('SPY', '2026-05-13', 'call', 745);
    expect(occ).toBe('SPY260513C00745000');
    const anchor = screen.getByTitle(`Open ${occ} on Unusual Whales`);
    expect(anchor).toHaveAttribute(
      'href',
      `https://unusualwhales.com/flow/option_chains?chain=${occ}`,
    );
    expect(anchor).toHaveAttribute('target', '_blank');
    // Chip carries the emerald palette class.
    const chip = anchor.querySelector('span');
    expect(chip?.className).toMatch(/emerald/);
    expect(chip?.className).not.toMatch(/red/);
  });

  it('renders put ticket with red chip', async () => {
    const putT = makeTicket('put', 740, 2_100_000, 12_500, 0.95);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () =>
        makeResponse({
          windowStatus: 'closed',
          tickers: {
            SPY: {
              slice1: {
                tickets: [putT],
                callPremium: 0,
                putPremium: 2_100_000,
                biasSide: 'put',
                biasRatio: 1,
                top3SameSide: true,
              },
              slice2: null,
              signal: { fired: false, reason: 'window_not_complete' },
            },
            QQQ: { slice1: null, slice2: null, signal: null },
          },
        }),
    });
    render(<OpeningFlowSignal />);
    await screen.findByText(/Slice 1 tickets/i);
    const occ = buildOcc('SPY', '2026-05-13', 'put', 740);
    const anchor = screen.getByTitle(`Open ${occ} on Unusual Whales`);
    const chip = anchor.querySelector('span');
    expect(chip?.className).toMatch(/red/);
    expect(chip?.className).not.toMatch(/emerald/);
  });
});

describe('buildOcc', () => {
  it('produces the canonical OCC body for whole-dollar strikes', () => {
    expect(buildOcc('SPY', '2026-05-19', 'put', 500)).toBe(
      'SPY260519P00500000',
    );
    expect(buildOcc('QQQ', '2026-05-13', 'call', 500)).toBe(
      'QQQ260513C00500000',
    );
  });

  it('handles fractional strikes via the ×1000 scaling rule', () => {
    expect(buildOcc('SPY', '2026-05-19', 'call', 397.5)).toBe(
      'SPY260519C00397500',
    );
  });

  it('upper-cases the ticker', () => {
    expect(buildOcc('spy', '2026-05-19', 'put', 500)).toBe(
      'SPY260519P00500000',
    );
  });
});
