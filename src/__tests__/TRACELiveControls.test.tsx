import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import TRACELiveControls from '../components/TRACELive/TRACELiveControls';
import type { TraceLiveSummary } from '../components/TRACELive/types';

function makeSummary(
  overrides: Partial<TraceLiveSummary> = {},
): TraceLiveSummary {
  return {
    id: 1,
    capturedAt: '2026-04-27T18:00:00Z',
    spot: 5800,
    stabilityPct: null,
    regime: 'range_bound_positive_gamma',
    predictedClose: null,
    confidence: null,
    overrideApplied: false,
    headline: null,
    hasImages: true,
    ...overrides,
  };
}

describe('TRACELiveControls', () => {
  it('renders the date input with the given selectedDate', () => {
    render(
      <TRACELiveControls
        list={[]}
        listLoading={false}
        listError={null}
        selectedDate="2026-04-25"
        onDateChange={vi.fn()}
        selectedId={null}
        onSelectId={vi.fn()}
        isLive={false}
      />,
    );
    expect(screen.getByLabelText('Trading day')).toHaveValue('2026-04-25');
  });

  it('disables the timestamp dropdown when the list is empty', () => {
    render(
      <TRACELiveControls
        list={[]}
        listLoading={false}
        listError={null}
        selectedDate="2026-04-25"
        onDateChange={vi.fn()}
        selectedId={null}
        onSelectId={vi.fn()}
        isLive={false}
      />,
    );
    expect(screen.getByLabelText('Select capture timestamp')).toBeDisabled();
    expect(
      screen.getByText('No captures recorded for this date'),
    ).toBeInTheDocument();
  });

  it('shows "Latest (live)" placeholder when isLive is true', () => {
    render(
      <TRACELiveControls
        list={[makeSummary()]}
        listLoading={false}
        listError={null}
        selectedDate="2026-04-27"
        onDateChange={vi.fn()}
        selectedId={null}
        onSelectId={vi.fn()}
        isLive
      />,
    );
    expect(
      screen.getByRole('option', { name: 'Latest (live)' }),
    ).toBeInTheDocument();
  });

  it('shows "Pick a timestamp" placeholder when not live', () => {
    render(
      <TRACELiveControls
        list={[makeSummary()]}
        listLoading={false}
        listError={null}
        selectedDate="2026-04-27"
        onDateChange={vi.fn()}
        selectedId={null}
        onSelectId={vi.fn()}
        isLive={false}
      />,
    );
    expect(
      screen.getByRole('option', { name: 'Pick a timestamp' }),
    ).toBeInTheDocument();
  });

  it('sorts the dropdown options newest-first by capturedAt', () => {
    const list = [
      makeSummary({ id: 1, capturedAt: '2026-04-27T13:00:00Z' }),
      makeSummary({ id: 2, capturedAt: '2026-04-27T15:30:00Z' }),
      makeSummary({ id: 3, capturedAt: '2026-04-27T14:00:00Z' }),
    ];
    render(
      <TRACELiveControls
        list={list}
        listLoading={false}
        listError={null}
        selectedDate="2026-04-27"
        onDateChange={vi.fn()}
        selectedId={null}
        onSelectId={vi.fn()}
        isLive
      />,
    );
    const select = screen.getByLabelText('Select capture timestamp');
    const options = within(select).getAllByRole('option');
    // Index 0 is the placeholder; subsequent options should be 2 (15:30), 3 (14:00), 1 (13:00).
    expect(options[1]).toHaveValue('2');
    expect(options[2]).toHaveValue('3');
    expect(options[3]).toHaveValue('1');
  });

  it('appends "• override" suffix when summary.overrideApplied is true', () => {
    const list = [makeSummary({ id: 5, overrideApplied: true })];
    render(
      <TRACELiveControls
        list={list}
        listLoading={false}
        listError={null}
        selectedDate="2026-04-27"
        onDateChange={vi.fn()}
        selectedId={null}
        onSelectId={vi.fn()}
        isLive={false}
      />,
    );
    expect(
      screen.getByRole('option', { name: /• override/ }),
    ).toBeInTheDocument();
  });

  it('renders "n/a" in the option label when regime is null', () => {
    const list = [makeSummary({ id: 5, regime: null })];
    render(
      <TRACELiveControls
        list={list}
        listLoading={false}
        listError={null}
        selectedDate="2026-04-27"
        onDateChange={vi.fn()}
        selectedId={null}
        onSelectId={vi.fn()}
        isLive={false}
      />,
    );
    expect(screen.getByRole('option', { name: /— n\/a$/ })).toBeInTheDocument();
  });

  it('invokes onSelectId(null) when the user picks the placeholder', () => {
    const onSelectId = vi.fn();
    const list = [makeSummary({ id: 5 })];
    render(
      <TRACELiveControls
        list={list}
        listLoading={false}
        listError={null}
        selectedDate="2026-04-27"
        onDateChange={vi.fn()}
        selectedId={5}
        onSelectId={onSelectId}
        isLive={false}
      />,
    );
    fireEvent.change(screen.getByLabelText('Select capture timestamp'), {
      target: { value: '' },
    });
    expect(onSelectId).toHaveBeenCalledWith(null);
  });

  it('invokes onSelectId with the numeric id when a real option is picked', () => {
    const onSelectId = vi.fn();
    const list = [makeSummary({ id: 7 })];
    render(
      <TRACELiveControls
        list={list}
        listLoading={false}
        listError={null}
        selectedDate="2026-04-27"
        onDateChange={vi.fn()}
        selectedId={null}
        onSelectId={onSelectId}
        isLive
      />,
    );
    fireEvent.change(screen.getByLabelText('Select capture timestamp'), {
      target: { value: '7' },
    });
    expect(onSelectId).toHaveBeenCalledWith(7);
  });

  it('renders the loading indicator when listLoading is true', () => {
    render(
      <TRACELiveControls
        list={[]}
        listLoading
        listError={null}
        selectedDate="2026-04-27"
        onDateChange={vi.fn()}
        selectedId={null}
        onSelectId={vi.fn()}
        isLive
      />,
    );
    expect(screen.getByText(/loading list/)).toBeInTheDocument();
  });

  it('renders the error message via role=alert when listError is set', () => {
    render(
      <TRACELiveControls
        list={[]}
        listLoading={false}
        listError="connection refused"
        selectedDate="2026-04-27"
        onDateChange={vi.fn()}
        selectedId={null}
        onSelectId={vi.fn()}
        isLive
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('connection refused');
  });
});
