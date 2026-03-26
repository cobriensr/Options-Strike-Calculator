import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DateLookupSection from '../../components/DateLookupSection';
import { theme } from '../../themes';
import type { VIXDayData, OHLCField } from '../../types';

const th = theme;

function renderSection(
  overrides: Partial<{
    selectedDate: string;
    onDateChange: (d: string) => void;
    vixOHLC: VIXDayData | null;
    vixOHLCField: OHLCField;
    onOHLCFieldChange: (f: OHLCField) => void;
  }> = {},
) {
  return render(
    <DateLookupSection
      th={th}
      selectedDate={overrides.selectedDate ?? '2026-03-12'}
      onDateChange={overrides.onDateChange ?? vi.fn()}
      vixOHLC={overrides.vixOHLC ?? null}
      vixOHLCField={overrides.vixOHLCField ?? 'smart'}
      onOHLCFieldChange={overrides.onOHLCFieldChange ?? vi.fn()}
    />,
  );
}

describe('DateLookupSection', () => {
  it('renders section heading', () => {
    renderSection();
    expect(screen.getByText('Date Lookup')).toBeInTheDocument();
  });

  it('renders date picker', () => {
    renderSection();
    expect(screen.getByLabelText('Select date')).toBeInTheDocument();
  });

  it('calls onDateChange when date changes', () => {
    const onDateChange = vi.fn();
    renderSection({ onDateChange });
    fireEvent.change(screen.getByLabelText('Select date'), {
      target: { value: '2026-03-13' },
    });
    expect(onDateChange).toHaveBeenCalledWith('2026-03-13');
  });

  it('shows no data message when date set but no OHLC', () => {
    renderSection({ selectedDate: '2026-03-12', vixOHLC: null });
    expect(
      screen.getByText('No VIX data found for this date'),
    ).toBeInTheDocument();
  });

  it('shows OHLC values when vixOHLC is provided', () => {
    renderSection({
      vixOHLC: { open: 18.5, high: 20.1, low: 17.8, close: 19.3 },
    });
    expect(screen.getByText('18.50')).toBeInTheDocument();
    expect(screen.getByText('20.10')).toBeInTheDocument();
    expect(screen.getByText('17.80')).toBeInTheDocument();
    expect(screen.getByText('19.30')).toBeInTheDocument();
  });

  it('shows OHLC field labels', () => {
    renderSection({
      vixOHLC: { open: 18.5, high: 20.1, low: 17.8, close: 19.3 },
    });
    expect(screen.getByText('open')).toBeInTheDocument();
    expect(screen.getByText('high')).toBeInTheDocument();
    expect(screen.getByText('low')).toBeInTheDocument();
    expect(screen.getByText('close')).toBeInTheDocument();
  });

  it('shows OHLC field selector chips when data exists', () => {
    renderSection({
      vixOHLC: { open: 18.5, high: 20.1, low: 17.8, close: 19.3 },
    });
    expect(screen.getByText('Auto')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.getByText('Low')).toBeInTheDocument();
    expect(screen.getByText('Close')).toBeInTheDocument();
  });

  it('calls onOHLCFieldChange when chip clicked', async () => {
    const user = userEvent.setup();
    const onOHLCFieldChange = vi.fn();
    renderSection({
      vixOHLC: { open: 18.5, high: 20.1, low: 17.8, close: 19.3 },
      onOHLCFieldChange,
    });
    await user.click(screen.getByText('High'));
    expect(onOHLCFieldChange).toHaveBeenCalledWith('high');
  });

  it('shows auto hint when field is smart', () => {
    renderSection({
      vixOHLC: { open: 18.5, high: 20.1, low: 17.8, close: 19.3 },
      vixOHLCField: 'smart',
    });
    expect(
      screen.getByText(/Auto: uses Open for AM entries/),
    ).toBeInTheDocument();
  });

  it('shows field name hint when specific field selected', () => {
    renderSection({
      vixOHLC: { open: 18.5, high: 20.1, low: 17.8, close: 19.3 },
      vixOHLCField: 'high',
    });
    expect(screen.getByText(/Using VIX high value/)).toBeInTheDocument();
  });

  it('handles null OHLC values with dash', () => {
    renderSection({
      vixOHLC: { open: null, high: null, low: null, close: null },
    });
    const dashes = screen.getAllByText('\u2014');
    expect(dashes.length).toBe(4);
  });
});
