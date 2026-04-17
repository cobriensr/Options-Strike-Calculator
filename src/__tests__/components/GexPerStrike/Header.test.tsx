import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Header } from '../../../components/GexPerStrike/Header';

function defaultProps(overrides: Partial<Parameters<typeof Header>[0]> = {}) {
  return {
    timestamp: '2026-04-02T15:30:00Z',
    timestamps: [],
    selectedDate: '2026-04-02',
    onDateChange: vi.fn(),
    isLive: true,
    isToday: true,
    isScrubbed: false,
    canScrubPrev: false,
    canScrubNext: false,
    loading: false,
    onScrubPrev: vi.fn(),
    onScrubNext: vi.fn(),
    onScrubTo: vi.fn(),
    onScrubLive: vi.fn(),
    onRefresh: vi.fn(),
    visibleCount: 20,
    totalStrikes: 40,
    minVisible: 5,
    maxVisible: 40,
    onLess: vi.fn(),
    onMore: vi.fn(),
    ...overrides,
  };
}

describe('GexPerStrike/Header — badge states', () => {
  it('renders LIVE span (not button) when isLive is true', () => {
    render(<Header {...defaultProps({ isLive: true })} />);
    // Live state: only the static LIVE span should exist; no Resume button
    expect(
      screen.queryByRole('button', { name: /resume live snapshot/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('LIVE')).toBeInTheDocument();
  });

  it('renders BACKTEST badge when not live, not scrubbed, and past date', () => {
    render(
      <Header
        {...defaultProps({
          isLive: false,
          isScrubbed: false,
          isToday: false,
        })}
      />,
    );
    expect(screen.getByText('BACKTEST')).toBeInTheDocument();
    // Past date also triggers the Resume-LIVE button (so the user has a way
    // back to the present). No standalone green LIVE span is rendered though —
    // the pill is a clickable button, not a static label.
  });

  it('does not render BACKTEST badge when scrubbed on today', () => {
    render(
      <Header
        {...defaultProps({
          isLive: false,
          isScrubbed: true,
          isToday: true,
        })}
      />,
    );
    expect(screen.queryByText('BACKTEST')).not.toBeInTheDocument();
  });

  it('does not render BACKTEST badge when isLive is true', () => {
    render(
      <Header
        {...defaultProps({
          isLive: true,
          isScrubbed: false,
          isToday: true,
        })}
      />,
    );
    expect(screen.queryByText('BACKTEST')).not.toBeInTheDocument();
  });

  it('renders Resume-LIVE button when scrubbed and not live', () => {
    render(
      <Header
        {...defaultProps({
          isLive: false,
          isScrubbed: true,
          isToday: true,
        })}
      />,
    );
    expect(
      screen.getByRole('button', { name: /resume live snapshot/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText('BACKTEST')).not.toBeInTheDocument();
  });

  it('renders Resume-LIVE button when viewing past date (not today) and not live', () => {
    render(
      <Header
        {...defaultProps({
          isLive: false,
          isScrubbed: true,
          isToday: false,
        })}
      />,
    );
    expect(
      screen.getByRole('button', { name: /resume live snapshot/i }),
    ).toBeInTheDocument();
  });

  it('calls onScrubLive when Resume-LIVE button clicked', async () => {
    const user = userEvent.setup();
    const onScrubLive = vi.fn();
    render(
      <Header
        {...defaultProps({
          isLive: false,
          isScrubbed: true,
          isToday: true,
          onScrubLive,
        })}
      />,
    );
    await user.click(
      screen.getByRole('button', { name: /resume live snapshot/i }),
    );
    expect(onScrubLive).toHaveBeenCalledTimes(1);
  });
});

describe('GexPerStrike/Header — scrub controls', () => {
  it('calls onScrubPrev when prev button clicked', async () => {
    const user = userEvent.setup();
    const onScrubPrev = vi.fn();
    render(
      <Header
        {...defaultProps({
          canScrubPrev: true,
          onScrubPrev,
        })}
      />,
    );
    await user.click(
      screen.getByRole('button', { name: /previous snapshot/i }),
    );
    expect(onScrubPrev).toHaveBeenCalledTimes(1);
  });

  it('calls onScrubNext when next button clicked', async () => {
    const user = userEvent.setup();
    const onScrubNext = vi.fn();
    render(
      <Header
        {...defaultProps({
          canScrubNext: true,
          onScrubNext,
        })}
      />,
    );
    await user.click(screen.getByRole('button', { name: /next snapshot/i }));
    expect(onScrubNext).toHaveBeenCalledTimes(1);
  });

  it('disables prev button when canScrubPrev is false', () => {
    render(<Header {...defaultProps({ canScrubPrev: false })} />);
    expect(
      screen.getByRole('button', { name: /previous snapshot/i }),
    ).toBeDisabled();
  });

  it('disables next button when canScrubNext is false', () => {
    render(<Header {...defaultProps({ canScrubNext: false })} />);
    expect(
      screen.getByRole('button', { name: /next snapshot/i }),
    ).toBeDisabled();
  });

  it('disables prev and next buttons when loading', () => {
    render(
      <Header
        {...defaultProps({
          loading: true,
          canScrubPrev: true,
          canScrubNext: true,
        })}
      />,
    );
    expect(
      screen.getByRole('button', { name: /previous snapshot/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /next snapshot/i }),
    ).toBeDisabled();
  });

  it('renders snapshot <select> when timestamps length > 1', () => {
    const timestamps = [
      '2026-04-02T14:00:00Z',
      '2026-04-02T14:30:00Z',
      '2026-04-02T15:00:00Z',
    ];
    render(
      <Header
        {...defaultProps({
          timestamps,
          timestamp: timestamps[1],
        })}
      />,
    );
    expect(
      screen.getByRole('combobox', { name: /jump to snapshot time/i }),
    ).toBeInTheDocument();
  });

  it('calls onScrubTo when select option changes', () => {
    const onScrubTo = vi.fn();
    const timestamps = [
      '2026-04-02T14:00:00Z',
      '2026-04-02T14:30:00Z',
      '2026-04-02T15:00:00Z',
    ];
    render(
      <Header
        {...defaultProps({
          timestamps,
          timestamp: timestamps[1],
          onScrubTo,
        })}
      />,
    );
    fireEvent.change(
      screen.getByRole('combobox', { name: /jump to snapshot time/i }),
      { target: { value: timestamps[0] } },
    );
    expect(onScrubTo).toHaveBeenCalledWith(timestamps[0]);
  });

  it('does not render snapshot <select> when only one timestamp exists', () => {
    render(
      <Header
        {...defaultProps({
          timestamps: ['2026-04-02T15:00:00Z'],
          timestamp: '2026-04-02T15:00:00Z',
        })}
      />,
    );
    expect(
      screen.queryByRole('combobox', { name: /jump to snapshot time/i }),
    ).not.toBeInTheDocument();
  });
});

describe('GexPerStrike/Header — date picker', () => {
  it('calls onDateChange when date input changes', () => {
    const onDateChange = vi.fn();
    render(<Header {...defaultProps({ onDateChange })} />);
    const input = screen.getByLabelText(/gex per strike date/i);
    fireEvent.change(input, { target: { value: '2026-03-15' } });
    expect(onDateChange).toHaveBeenCalledWith('2026-03-15');
  });

  it('reflects selectedDate in the date input', () => {
    render(<Header {...defaultProps({ selectedDate: '2026-01-10' })} />);
    expect(screen.getByLabelText(/gex per strike date/i)).toHaveValue(
      '2026-01-10',
    );
  });
});

describe('GexPerStrike/Header — refresh button', () => {
  it('calls onRefresh when refresh button clicked', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    render(<Header {...defaultProps({ onRefresh })} />);
    await user.click(screen.getByRole('button', { name: /refresh gex data/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('disables refresh button when loading', () => {
    render(<Header {...defaultProps({ loading: true })} />);
    expect(
      screen.getByRole('button', { name: /refresh gex data/i }),
    ).toBeDisabled();
  });
});

describe('GexPerStrike/Header — visible-count stepper', () => {
  it('calls onLess when minus clicked', async () => {
    const user = userEvent.setup();
    const onLess = vi.fn();
    render(
      <Header
        {...defaultProps({
          visibleCount: 20,
          minVisible: 5,
          onLess,
        })}
      />,
    );
    await user.click(
      screen.getByRole('button', { name: /show fewer strikes/i }),
    );
    expect(onLess).toHaveBeenCalledTimes(1);
  });

  it('calls onMore when plus clicked', async () => {
    const user = userEvent.setup();
    const onMore = vi.fn();
    render(
      <Header
        {...defaultProps({
          visibleCount: 20,
          maxVisible: 40,
          totalStrikes: 40,
          onMore,
        })}
      />,
    );
    await user.click(
      screen.getByRole('button', { name: /show more strikes/i }),
    );
    expect(onMore).toHaveBeenCalledTimes(1);
  });

  it('disables minus button when visibleCount is at minVisible', () => {
    render(
      <Header
        {...defaultProps({
          visibleCount: 5,
          minVisible: 5,
        })}
      />,
    );
    expect(
      screen.getByRole('button', { name: /show fewer strikes/i }),
    ).toBeDisabled();
  });

  it('disables plus button when visibleCount is at maxVisible', () => {
    render(
      <Header
        {...defaultProps({
          visibleCount: 40,
          maxVisible: 40,
          totalStrikes: 60,
        })}
      />,
    );
    expect(
      screen.getByRole('button', { name: /show more strikes/i }),
    ).toBeDisabled();
  });

  it('disables plus button when visibleCount >= totalStrikes', () => {
    render(
      <Header
        {...defaultProps({
          visibleCount: 10,
          maxVisible: 40,
          totalStrikes: 10,
        })}
      />,
    );
    expect(
      screen.getByRole('button', { name: /show more strikes/i }),
    ).toBeDisabled();
  });

  it('shows current visibleCount value', () => {
    render(<Header {...defaultProps({ visibleCount: 17 })} />);
    expect(screen.getByText('17')).toBeInTheDocument();
  });
});
