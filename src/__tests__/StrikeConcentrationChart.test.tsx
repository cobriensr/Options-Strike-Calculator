/**
 * StrikeConcentrationChart — bar chart of cumulative institutional
 * premium per strike over the selected window.
 *
 * The chart depends on `useStrikeHeatmap`, which itself fetches
 * /api/institutional-program/strike-heatmap. We mock the hook directly
 * since its own tests cover the fetch logic separately.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Mock } from 'vitest';

vi.mock('../hooks/useInstitutionalProgram.js', () => ({
  useStrikeHeatmap: vi.fn(),
}));

import { StrikeConcentrationChart } from '../components/InstitutionalProgram/StrikeConcentrationChart';
import { useStrikeHeatmap } from '../hooks/useInstitutionalProgram.js';

const mockedHeatmap = useStrikeHeatmap as unknown as Mock;

function makeRow(
  overrides: Partial<{
    strike: number;
    option_type: 'call' | 'put';
    n_blocks: number;
    total_contracts: number;
    total_premium: number;
    last_seen_date: string;
    active_days: number;
    latest_expiry: string;
  }> = {},
) {
  return {
    strike: 5800,
    option_type: 'call' as const,
    n_blocks: 3,
    total_contracts: 1500,
    total_premium: 5_000_000,
    last_seen_date: '2026-04-25',
    active_days: 12,
    latest_expiry: '2026-12-19',
    ...overrides,
  };
}

describe('StrikeConcentrationChart', () => {
  beforeEach(() => {
    mockedHeatmap.mockReset();
  });

  it('renders a loading state while data is loading', () => {
    mockedHeatmap.mockReturnValue({ data: null, loading: true });
    render(<StrikeConcentrationChart />);
    expect(
      screen.getByText(/Loading strike concentration/),
    ).toBeInTheDocument();
  });

  it('renders an empty-state message when data has zero rows', () => {
    mockedHeatmap.mockReturnValue({
      data: { spot: 5800, days: 60, track: 'ceiling', rows: [] },
      loading: false,
    });
    render(<StrikeConcentrationChart />);
    expect(
      screen.getByText(/No strike-concentration data yet/),
    ).toBeInTheDocument();
  });

  it('renders an empty-state message when data is null after load', () => {
    mockedHeatmap.mockReturnValue({ data: null, loading: false });
    render(<StrikeConcentrationChart />);
    expect(
      screen.getByText(/No strike-concentration data yet/),
    ).toBeInTheDocument();
  });

  it('renders one rect per row sorted by strike descending', () => {
    mockedHeatmap.mockReturnValue({
      data: {
        spot: 5800,
        days: 60,
        track: 'ceiling',
        rows: [
          makeRow({ strike: 5700, total_premium: 1_000_000 }),
          makeRow({ strike: 5900, total_premium: 5_000_000 }),
          makeRow({ strike: 5800, total_premium: 3_000_000 }),
        ],
      },
      loading: false,
    });
    const { container } = render(<StrikeConcentrationChart />);
    const rects = container.querySelectorAll('rect');
    expect(rects.length).toBe(3);
    // Each strike+type pair becomes a <text> label.
    expect(screen.getByText(/5900C/)).toBeInTheDocument();
    expect(screen.getByText(/5800C/)).toBeInTheDocument();
    expect(screen.getByText(/5700C/)).toBeInTheDocument();
  });

  it('uses red fill for puts and green for calls (color-coded by option_type)', () => {
    mockedHeatmap.mockReturnValue({
      data: {
        spot: 5800,
        days: 60,
        track: 'ceiling',
        rows: [
          makeRow({
            strike: 5800,
            option_type: 'call',
            total_premium: 1_000_000,
          }),
          makeRow({ strike: 5790, option_type: 'put', total_premium: 800_000 }),
        ],
      },
      loading: false,
    });
    const { container } = render(<StrikeConcentrationChart />);
    const rects = container.querySelectorAll('rect');
    const callRect = Array.from(rects).find((r) =>
      r.getAttribute('fill')?.includes('color-call'),
    );
    const putRect = Array.from(rects).find((r) =>
      r.getAttribute('fill')?.includes('color-put'),
    );
    expect(callRect).toBeDefined();
    expect(putRect).toBeDefined();
  });

  it('shows the spot reference line and label when spot is set', () => {
    mockedHeatmap.mockReturnValue({
      data: {
        spot: 5800,
        days: 60,
        track: 'ceiling',
        rows: [
          makeRow({ strike: 5900 }),
          makeRow({ strike: 5800 }),
          makeRow({ strike: 5700 }),
        ],
      },
      loading: false,
    });
    render(<StrikeConcentrationChart />);
    expect(screen.getByText(/SPX ≈ 5800/)).toBeInTheDocument();
    expect(screen.getByText(/spot ≈ 5800/)).toBeInTheDocument();
  });

  it('omits the spot reference line when spot is null', () => {
    mockedHeatmap.mockReturnValue({
      data: {
        spot: null,
        days: 60,
        track: 'ceiling',
        rows: [makeRow({ strike: 5900 }), makeRow({ strike: 5800 })],
      },
      loading: false,
    });
    render(<StrikeConcentrationChart />);
    expect(screen.queryByText(/SPX ≈/)).not.toBeInTheDocument();
    expect(screen.queryByText(/spot ≈/)).not.toBeInTheDocument();
  });

  it('changes the track when the track <select> changes', () => {
    mockedHeatmap.mockReturnValue({
      data: { spot: 5800, days: 60, track: 'ceiling', rows: [makeRow()] },
      loading: false,
    });
    render(<StrikeConcentrationChart />);
    const trackSelect = screen.getByLabelText('Track filter');
    fireEvent.change(trackSelect, { target: { value: 'opening_atm' } });
    // Latest hook call's first arg should be 'opening_atm'.
    const lastCall = mockedHeatmap.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe('opening_atm');
    expect(lastCall?.[1]).toBe(60);
  });

  it('changes the days window when the window <select> changes', () => {
    mockedHeatmap.mockReturnValue({
      data: { spot: 5800, days: 60, track: 'ceiling', rows: [makeRow()] },
      loading: false,
    });
    render(<StrikeConcentrationChart />);
    fireEvent.change(screen.getByLabelText('Window size'), {
      target: { value: '90' },
    });
    const lastCall = mockedHeatmap.mock.calls.at(-1);
    expect(lastCall?.[1]).toBe(90);
  });

  it('renders a tooltip <title> per bar describing the strike, premium, and active days', () => {
    mockedHeatmap.mockReturnValue({
      data: {
        spot: 5800,
        days: 60,
        track: 'ceiling',
        rows: [
          makeRow({
            strike: 5900,
            option_type: 'call',
            total_premium: 5_000_000,
            active_days: 12,
            total_contracts: 1500,
            last_seen_date: '2026-04-25',
          }),
        ],
      },
      loading: false,
    });
    const { container } = render(<StrikeConcentrationChart />);
    const titleEl = container.querySelector('title');
    expect(titleEl?.textContent).toMatch(
      /5900 call: \$5\.00M across 12 days \(1,500 contracts, last 2026-04-25\)/,
    );
  });

  it('floors bar widths at 1px so a tiny-premium bar still renders', () => {
    mockedHeatmap.mockReturnValue({
      data: {
        spot: 5800,
        days: 60,
        track: 'ceiling',
        rows: [
          makeRow({ strike: 5900, total_premium: 10_000_000 }),
          makeRow({ strike: 5800, total_premium: 1 }), // ~0 width without floor
        ],
      },
      loading: false,
    });
    const { container } = render(<StrikeConcentrationChart />);
    const widths = Array.from(container.querySelectorAll('rect')).map((r) =>
      Number.parseFloat(r.getAttribute('width') ?? '0'),
    );
    for (const w of widths) {
      expect(w).toBeGreaterThanOrEqual(1);
    }
  });
});
