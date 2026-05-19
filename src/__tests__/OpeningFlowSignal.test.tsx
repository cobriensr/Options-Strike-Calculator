import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

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

  it('keeps today and historical cache slots independent (per-date keys)', async () => {
    // Per-date cache keys: today's last-good slot at
    // `openingFlowSignal.lastGood` is fully independent from any
    // historical slot like `openingFlowSignal.lastGood:2026-05-12`.
    // Picking yesterday must NOT clobber today's cache.
    getCTTimeMock.mockReturnValue({ hour: 0, minute: 32 });

    // Pre-seed today's slot with a live cached payload.
    const todayCached: OpeningFlowResponse = makeResponse({
      date: '2026-05-13',
    });
    localStorage.setItem(
      'openingFlowSignal.lastGood',
      JSON.stringify({
        data: todayCached,
        savedAt: '2026-05-13T20:00:00Z',
        date: '2026-05-13',
      }),
    );

    // Historical fetch for 2026-05-12 returns its own payload.
    const yesterdayPayload = makeResponse({
      date: '2026-05-12',
      tickers: {
        SPY: {
          slice1: {
            tickets: [makeTicket('put', 740, 2_100_000, 12_500, 0.95)],
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
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => yesterdayPayload,
    });

    render(<OpeningFlowSignal />);

    // Pick yesterday via the date input.
    const dateInput = screen.getByLabelText('Date') as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: '2026-05-12' } });

    // Wait until the historical slot has been written.
    await waitFor(() => {
      expect(
        localStorage.getItem('openingFlowSignal.lastGood:2026-05-12'),
      ).not.toBeNull();
    });

    // Today's slot must STILL hold the original payload — picking
    // yesterday wrote to its own slot, not today's.
    const todayRaw = localStorage.getItem('openingFlowSignal.lastGood');
    expect(todayRaw).not.toBeNull();
    const todayParsed = JSON.parse(todayRaw!) as {
      date: string;
      data: OpeningFlowResponse;
    };
    expect(todayParsed.date).toBe('2026-05-13');

    // Historical slot carries yesterday's date.
    const yRaw = localStorage.getItem('openingFlowSignal.lastGood:2026-05-12');
    const yParsed = JSON.parse(yRaw!) as {
      date: string;
      data: OpeningFlowResponse;
    };
    expect(yParsed.date).toBe('2026-05-12');

    // Fetch URL includes ?date=…
    const lastCall = fetchMock.mock.calls.at(-1);
    expect(lastCall?.[0]).toContain('?date=2026-05-12');
  });

  it('renders the date picker and Live button', () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeResponse({ windowStatus: 'before_open' }),
    });
    render(<OpeningFlowSignal />);
    expect(screen.getByLabelText('Date')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /live/i })).toBeInTheDocument();
  });

  it('passes ?date=… to the fetch URL when a historical date is picked', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeResponse({ date: '2026-05-12' }),
    });

    render(<OpeningFlowSignal />);

    const dateInput = screen.getByLabelText('Date') as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: '2026-05-12' } });

    await waitFor(() => {
      const calls = fetchMock.mock.calls;
      expect(
        calls.some(
          (c) =>
            typeof c[0] === 'string' &&
            (c[0] as string).includes('?date=2026-05-12'),
        ),
      ).toBe(true);
    });
  });

  it('shows "Data not captured" when historical response is empty/closed', async () => {
    // Empty-shell response: closed window, every ticker payload null.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () =>
        makeResponse({
          date: '2026-04-01',
          windowStatus: 'closed',
          tickers: {
            SPY: { slice1: null, slice2: null, signal: null },
            QQQ: { slice1: null, slice2: null, signal: null },
          },
        }),
    });

    render(<OpeningFlowSignal />);

    const dateInput = screen.getByLabelText('Date') as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: '2026-04-01' } });

    expect(
      await screen.findByText(/data not captured for this date/i),
    ).toBeInTheDocument();
  });

  it('Live button clears the selected date back to live mode', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeResponse({ date: '2026-05-12' }),
    });

    render(<OpeningFlowSignal />);

    const dateInput = screen.getByLabelText('Date') as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: '2026-05-12' } });
    expect(dateInput.value).toBe('2026-05-12');

    const liveBtn = screen.getByRole('button', { name: /live/i });
    fireEvent.click(liveBtn);
    expect(dateInput.value).toBe('');
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
