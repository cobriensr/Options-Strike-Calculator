/**
 * InstitutionalProgramSection — section-level orchestration tests.
 *
 * Mocks the data hook and the children to keep the surface tight.
 * Children get their own focused tests (RegimeBanner.test.tsx,
 * CeilingChart.test.tsx, etc.) so we don't re-test their internals here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Mock } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────
// All children mocked to small marker components so we can assert what
// gets rendered without fighting their internals.
vi.mock('../components/InstitutionalProgram/RegimeBanner', () => ({
  RegimeBanner: () => <div data-testid="regime-banner" />,
}));
vi.mock('../components/InstitutionalProgram/CeilingChart', () => ({
  CeilingChart: () => <div data-testid="ceiling-chart" />,
}));
vi.mock('../components/InstitutionalProgram/OpeningBlocksCard', () => ({
  OpeningBlocksCard: () => <div data-testid="opening-blocks-card" />,
}));
vi.mock('../components/InstitutionalProgram/StrikeConcentrationChart', () => ({
  StrikeConcentrationChart: () => (
    <div data-testid="strike-concentration-chart" />
  ),
}));
vi.mock('../components/InstitutionalProgram/TodayProgramCard', () => ({
  TodayProgramCard: () => <div data-testid="today-program-card" />,
}));

vi.mock('../hooks/useInstitutionalProgram.js', () => ({
  useInstitutionalProgram: vi.fn(),
}));

// `getETToday` is imported and used as the `max` attribute on the date
// input. Stub a stable value so tests don't depend on real time.
vi.mock('../utils/timezone.js', () => ({
  getETToday: () => '2026-04-27',
}));

import { InstitutionalProgramSection } from '../components/InstitutionalProgram/InstitutionalProgramSection';
import { useInstitutionalProgram } from '../hooks/useInstitutionalProgram.js';

const mockedUseHook = useInstitutionalProgram as unknown as Mock;

// ── Factories ────────────────────────────────────────────────

function makeDay(date: string) {
  return {
    date,
    dominant_pair: null,
    avg_spot: 5800,
    ceiling_pct_above_spot: 0.012,
    n_blocks: 5,
    n_call_blocks: 3,
    n_put_blocks: 2,
  };
}

function makeData() {
  return {
    days: [makeDay('2026-04-25'), makeDay('2026-04-26')],
    today: { blocks: [], date: '2026-04-26' },
  };
}

// ── Tests ────────────────────────────────────────────────────

describe('InstitutionalProgramSection', () => {
  beforeEach(() => {
    mockedUseHook.mockReset();
  });

  it('renders the loading state while data is loading', () => {
    mockedUseHook.mockReturnValue({ data: null, loading: true, error: null });
    render(<InstitutionalProgramSection />);
    expect(
      screen.getByText(/Loading institutional program/),
    ).toBeInTheDocument();
  });

  it('renders the error state when the hook surfaces an error', () => {
    mockedUseHook.mockReturnValue({
      data: null,
      loading: false,
      error: new Error('boom'),
    });
    render(<InstitutionalProgramSection />);
    expect(screen.getByText(/Program tracker unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/\(boom\)/)).toBeInTheDocument();
  });

  it('renders the unavailable message even with no error when data is null', () => {
    mockedUseHook.mockReturnValue({
      data: null,
      loading: false,
      error: null,
    });
    render(<InstitutionalProgramSection />);
    expect(screen.getByText(/Program tracker unavailable/)).toBeInTheDocument();
  });

  it('renders all five children when data is loaded', () => {
    mockedUseHook.mockReturnValue({
      data: makeData(),
      loading: false,
      error: null,
    });
    render(<InstitutionalProgramSection />);
    expect(screen.getByTestId('regime-banner')).toBeInTheDocument();
    expect(screen.getByTestId('today-program-card')).toBeInTheDocument();
    expect(screen.getByTestId('opening-blocks-card')).toBeInTheDocument();
    expect(screen.getByTestId('ceiling-chart')).toBeInTheDocument();
    expect(
      screen.getByTestId('strike-concentration-chart'),
    ).toBeInTheDocument();
  });

  it('shows the latest day in the header right slot', () => {
    mockedUseHook.mockReturnValue({
      data: makeData(),
      loading: false,
      error: null,
    });
    render(<InstitutionalProgramSection />);
    expect(screen.getByText(/last day 2026-04-26/)).toBeInTheDocument();
  });

  it('does NOT show the HISTORICAL badge when no filters are set', () => {
    mockedUseHook.mockReturnValue({
      data: makeData(),
      loading: false,
      error: null,
    });
    render(<InstitutionalProgramSection />);
    expect(screen.queryByText('HISTORICAL')).not.toBeInTheDocument();
    // Reset button should also be hidden when no filters active.
    expect(
      screen.queryByRole('button', { name: 'reset' }),
    ).not.toBeInTheDocument();
  });

  it('shows the HISTORICAL badge and reset button when a backtest date is set', () => {
    mockedUseHook.mockReturnValue({
      data: makeData(),
      loading: false,
      error: null,
    });
    render(<InstitutionalProgramSection />);
    const dateInput = screen.getByLabelText('Backtest date');
    fireEvent.change(dateInput, { target: { value: '2026-04-20' } });
    expect(screen.getByText('HISTORICAL')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'reset' })).toBeInTheDocument();
  });

  it('passes filter values through to the hook on change', () => {
    mockedUseHook.mockReturnValue({
      data: makeData(),
      loading: false,
      error: null,
    });
    render(<InstitutionalProgramSection />);
    const startInput = screen.getByLabelText('Start time (Central Time)');
    fireEvent.change(startInput, { target: { value: '09:30' } });
    // Latest call should include the new startTimeCt.
    const lastCall = mockedUseHook.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe(60);
    expect(lastCall?.[1]).toMatchObject({ startTimeCt: '09:30' });
  });

  it('reset button clears all three filter inputs', () => {
    mockedUseHook.mockReturnValue({
      data: makeData(),
      loading: false,
      error: null,
    });
    render(<InstitutionalProgramSection />);
    fireEvent.change(screen.getByLabelText('Backtest date'), {
      target: { value: '2026-04-20' },
    });
    fireEvent.change(screen.getByLabelText('Start time (Central Time)'), {
      target: { value: '09:30' },
    });
    fireEvent.change(screen.getByLabelText('End time (Central Time)'), {
      target: { value: '15:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'reset' }));
    expect(screen.queryByText('HISTORICAL')).not.toBeInTheDocument();
    const lastCall = mockedUseHook.mock.calls.at(-1);
    expect(lastCall?.[1]).toEqual({
      selectedDate: undefined,
      startTimeCt: undefined,
      endTimeCt: undefined,
    });
  });
});
