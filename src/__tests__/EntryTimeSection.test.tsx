import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EntryTimeSection from '../components/EntryTimeSection';
import { theme } from '../themes';

const th = theme;

function renderSection(
  overrides: Partial<Parameters<typeof EntryTimeSection>[0]> = {},
) {
  const props = {
    th,
    selectCls: 'test-select',
    chevronUrl: 'url(test)',
    timeHour: '9',
    onHourChange: vi.fn(),
    timeMinute: '30',
    onMinuteChange: vi.fn(),
    timeAmPm: 'AM' as const,
    onAmPmChange: vi.fn(),
    timezone: 'ET' as const,
    onTimezoneChange: vi.fn(),
    errors: {} as Record<string, string>,
    ...overrides,
  };
  render(<EntryTimeSection {...props} />);
  return props;
}

describe('EntryTimeSection', () => {
  it('renders section heading', () => {
    renderSection();
    expect(screen.getByText('Entry Time')).toBeInTheDocument();
  });

  it('renders hour and minute selects', () => {
    renderSection();
    expect(screen.getByLabelText('Hour')).toBeInTheDocument();
    expect(screen.getByLabelText('Minute')).toBeInTheDocument();
  });

  it('hour select has 12 options (1-12)', () => {
    renderSection();
    const sel = screen.getByLabelText('Hour') as HTMLSelectElement;
    expect(sel.options).toHaveLength(12);
    expect(sel.options[0]!.textContent).toBe('01');
    expect(sel.options[11]!.textContent).toBe('12');
  });

  it('minute select has 12 options (00-55)', () => {
    renderSection();
    const sel = screen.getByLabelText('Minute') as HTMLSelectElement;
    expect(sel.options).toHaveLength(12);
    expect(sel.options[0]!.textContent).toBe('00');
    expect(sel.options[11]!.textContent).toBe('55');
  });

  it('calls onHourChange when hour changes', () => {
    const props = renderSection();
    fireEvent.change(screen.getByLabelText('Hour'), {
      target: { value: '10' },
    });
    expect(props.onHourChange).toHaveBeenCalledWith('10');
  });

  it('calls onMinuteChange when minute changes', () => {
    const props = renderSection();
    fireEvent.change(screen.getByLabelText('Minute'), {
      target: { value: '45' },
    });
    expect(props.onMinuteChange).toHaveBeenCalledWith('45');
  });

  it('shows AM chip as active when timeAmPm=AM', () => {
    renderSection({ timeAmPm: 'AM' });
    expect(screen.getByRole('radio', { name: 'AM' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: 'PM' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('shows PM chip as active when timeAmPm=PM', () => {
    renderSection({ timeAmPm: 'PM' });
    expect(screen.getByRole('radio', { name: 'PM' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: 'AM' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('calls onAmPmChange when AM/PM chip clicked', async () => {
    const user = userEvent.setup();
    const props = renderSection({ timeAmPm: 'AM' });
    await user.click(screen.getByRole('radio', { name: 'PM' }));
    expect(props.onAmPmChange).toHaveBeenCalledWith('PM');
  });

  it('shows ET chip active when timezone=ET', () => {
    renderSection({ timezone: 'ET' });
    expect(screen.getByRole('radio', { name: 'ET' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: 'CT' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('calls onTimezoneChange when timezone chip clicked', async () => {
    const user = userEvent.setup();
    const props = renderSection({ timezone: 'ET' });
    await user.click(screen.getByRole('radio', { name: 'CT' }));
    expect(props.onTimezoneChange).toHaveBeenCalledWith('CT');
  });

  it('shows error when errors[time] exists', () => {
    renderSection({ errors: { time: 'Invalid time' } });
    expect(screen.getByText('Invalid time')).toBeInTheDocument();
  });

  it('does not show error when no time error', () => {
    renderSection({ errors: {} });
    expect(screen.queryByText('Invalid time')).not.toBeInTheDocument();
  });
});
