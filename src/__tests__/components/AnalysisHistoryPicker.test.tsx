import type { ComponentProps } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AnalysisHistoryPicker from '../../components/ChartAnalysis/AnalysisHistoryPicker';
import type { AnalysisEntry } from '../../components/ChartAnalysis/types';

// The picker is pure presentation: every choice arrives as a prop and leaves
// as a callback, so these tests hand it props and read the buttons back.

type Props = ComponentProps<typeof AnalysisHistoryPicker>;

function run(id: number, mode: AnalysisEntry['mode']): AnalysisEntry {
  return {
    id,
    entryTime: '10:00 AM',
    mode,
    structure: 'IRON CONDOR',
    confidence: 'HIGH',
    suggestedDelta: 8,
    spx: null,
    vix: null,
    vix1d: null,
    hedge: null,
    analysis: {} as AnalysisEntry['analysis'],
    createdAt: `2025-03-01T1${id}:00:00Z`,
  };
}

function renderPicker(overrides: Partial<Props> = {}) {
  const props: Props = {
    modeFilter: 'all',
    onModeFilterChange: vi.fn(),
    fetchError: null,
    filteredDates: [],
    selectedDate: '2025-03-01',
    onDateChange: vi.fn(),
    availableTimes: ['10:00 AM'],
    selectedTime: '10:00 AM',
    onTimeChange: vi.fn(),
    availableModes: ['entry', 'midday'],
    selectedMode: 'entry',
    onModeChange: vi.fn(),
    runsAtTimeMode: [],
    selectedRunIndex: 0,
    onRunIndexChange: vi.fn(),
    selectedAnalysis: null,
    loading: false,
    analysesError: null,
    filteredAnalysesCount: 0,
    ...overrides,
  };
  render(<AnalysisHistoryPicker {...props} />);
  return { props, user: userEvent.setup() };
}

// The filter, Type and Run buttons mark the chosen one with a tint and colour
// alone, so a screen reader heard a row of identical buttons. Each is a toggle
// (aria-pressed), the way the Chip control is, not a tab.
describe('AnalysisHistoryPicker: which button is chosen, for a screen reader', () => {
  it.each([
    ['all', 'All'],
    ['entry', 'Pre-Trade'],
    ['midday', 'Mid-Day'],
    ['review', 'Review'],
  ] as const)(
    'marks only the %s mode filter pressed',
    (modeFilter, chosenName) => {
      // No date, so the Type tabs of the same names are not on the page
      renderPicker({
        modeFilter,
        selectedDate: '',
        availableTimes: [],
        selectedTime: '',
        availableModes: [],
        selectedMode: '',
      });

      expect(
        screen.getByRole('button', { name: chosenName, pressed: true }),
      ).toBeInTheDocument();
      expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(1);
      expect(screen.getAllByRole('button', { pressed: false })).toHaveLength(3);
    },
  );

  it('calls back with the filter that was clicked', async () => {
    const { props, user } = renderPicker({
      selectedDate: '',
      availableTimes: [],
      selectedTime: '',
      availableModes: [],
      selectedMode: '',
    });

    await user.click(screen.getByRole('button', { name: 'Review' }));

    expect(props.onModeFilterChange).toHaveBeenCalledWith('review');
  });

  it('marks only the chosen Type tab pressed', () => {
    renderPicker({ selectedMode: 'midday' });

    const types = within(screen.getByRole('group', { name: 'Type' }));
    expect(
      types.getByRole('button', { name: 'Mid-Day', pressed: true }),
    ).toBeInTheDocument();
    expect(
      types.getByRole('button', { name: 'Pre-Trade', pressed: false }),
    ).toBeInTheDocument();
  });

  it('calls back with the Type tab that was clicked, and the first run', async () => {
    const { props, user } = renderPicker();

    const types = within(screen.getByRole('group', { name: 'Type' }));
    await user.click(types.getByRole('button', { name: 'Mid-Day' }));

    expect(props.onModeChange).toHaveBeenCalledWith('midday');
    expect(props.onRunIndexChange).toHaveBeenCalledWith(0);
  });

  it('marks only the shown run pressed', () => {
    renderPicker({
      runsAtTimeMode: [run(1, 'entry'), run(2, 'entry'), run(3, 'entry')],
      selectedRunIndex: 1,
    });

    const runs = within(screen.getByRole('group', { name: 'Run' }));
    expect(
      runs.getByRole('button', { name: '2', pressed: true }),
    ).toBeInTheDocument();
    for (const name of ['1', '3']) {
      expect(
        runs.getByRole('button', { name, pressed: false }),
      ).toBeInTheDocument();
    }
  });

  it('calls back with the run that was clicked', async () => {
    const { props, user } = renderPicker({
      runsAtTimeMode: [run(1, 'entry'), run(2, 'entry')],
    });

    const runs = within(screen.getByRole('group', { name: 'Run' }));
    await user.click(runs.getByRole('button', { name: '2' }));

    expect(props.onRunIndexChange).toHaveBeenCalledWith(1);
  });
});
