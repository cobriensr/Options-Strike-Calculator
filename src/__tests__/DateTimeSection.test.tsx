import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DateTimeSection from '../components/DateTimeSection';
import { lightTheme } from '../themes';
const th = lightTheme;

const INPUT_CLS = 'test-input';
const SELECT_CLS = 'test-select';
const CHEVRON_URL = 'url(test)';

function renderSection(
  overrides: Partial<Parameters<typeof DateTimeSection>[0]> = {},
) {
  const props = {
    th,
    inputCls: INPUT_CLS,
    selectCls: SELECT_CLS,
    chevronUrl: CHEVRON_URL,
    selectedDate: '2026-03-15',
    onDateChange: vi.fn(),
    vixDataLoaded: true,
    liveEvents: undefined,
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
  render(<DateTimeSection {...props} />);
  return props;
}

describe('DateTimeSection', () => {
  describe('section heading', () => {
    it('renders SectionBox with "Date & Time" label', () => {
      renderSection();
      expect(screen.getByText('Date & Time')).toBeInTheDocument();
    });
  });

  describe('date picker', () => {
    it('shows date picker when vixDataLoaded is true', () => {
      renderSection({ vixDataLoaded: true });
      expect(screen.getByLabelText('Date')).toBeInTheDocument();
    });

    it('hides date picker when vixDataLoaded is false', () => {
      renderSection({ vixDataLoaded: false });
      expect(screen.queryByLabelText('Date')).not.toBeInTheDocument();
    });

    it('renders input with type="date"', () => {
      renderSection({ vixDataLoaded: true });
      const input = screen.getByLabelText('Date') as HTMLInputElement;
      expect(input.type).toBe('date');
    });

    it('displays the selectedDate value', () => {
      renderSection({ vixDataLoaded: true, selectedDate: '2026-04-10' });
      const input = screen.getByLabelText('Date') as HTMLInputElement;
      expect(input.value).toBe('2026-04-10');
    });

    it('calls onDateChange when date changes', () => {
      const props = renderSection({ vixDataLoaded: true });
      fireEvent.change(screen.getByLabelText('Date'), {
        target: { value: '2026-05-01' },
      });
      expect(props.onDateChange).toHaveBeenCalledWith('2026-05-01');
    });

    it('applies inputCls to date input', () => {
      renderSection({ vixDataLoaded: true });
      const input = screen.getByLabelText('Date');
      expect(input.className).toContain(INPUT_CLS);
    });
  });

  describe('hour select', () => {
    it('renders hour select', () => {
      renderSection();
      expect(screen.getByLabelText('Hour')).toBeInTheDocument();
    });

    it('has 12 options (1-12)', () => {
      renderSection();
      const sel = screen.getByLabelText('Hour') as HTMLSelectElement;
      expect(sel.options).toHaveLength(12);
      expect(sel.options[0]!.textContent).toBe('01');
      expect(sel.options[11]!.textContent).toBe('12');
    });

    it('option values are numeric (1-12)', () => {
      renderSection();
      const sel = screen.getByLabelText('Hour') as HTMLSelectElement;
      expect(sel.options[0]!.value).toBe('1');
      expect(sel.options[5]!.value).toBe('6');
      expect(sel.options[11]!.value).toBe('12');
    });

    it('calls onHourChange when hour changes', () => {
      const props = renderSection();
      fireEvent.change(screen.getByLabelText('Hour'), {
        target: { value: '10' },
      });
      expect(props.onHourChange).toHaveBeenCalledWith('10');
    });

    it('applies selectCls to hour select', () => {
      renderSection();
      const sel = screen.getByLabelText('Hour');
      expect(sel.className).toContain(SELECT_CLS);
    });
  });

  describe('minute select', () => {
    it('renders minute select', () => {
      renderSection();
      expect(screen.getByLabelText('Minute')).toBeInTheDocument();
    });

    it('has 12 options (00-55 in 5-min increments)', () => {
      renderSection();
      const sel = screen.getByLabelText('Minute') as HTMLSelectElement;
      expect(sel.options).toHaveLength(12);
      expect(sel.options[0]!.textContent).toBe('00');
      expect(sel.options[1]!.textContent).toBe('05');
      expect(sel.options[5]!.textContent).toBe('25');
      expect(sel.options[11]!.textContent).toBe('55');
    });

    it('option values are zero-padded', () => {
      renderSection();
      const sel = screen.getByLabelText('Minute') as HTMLSelectElement;
      expect(sel.options[0]!.value).toBe('00');
      expect(sel.options[1]!.value).toBe('05');
      expect(sel.options[6]!.value).toBe('30');
    });

    it('calls onMinuteChange when minute changes', () => {
      const props = renderSection();
      fireEvent.change(screen.getByLabelText('Minute'), {
        target: { value: '45' },
      });
      expect(props.onMinuteChange).toHaveBeenCalledWith('45');
    });

    it('applies selectCls to minute select', () => {
      renderSection();
      const sel = screen.getByLabelText('Minute');
      expect(sel.className).toContain(SELECT_CLS);
    });
  });

  describe('AM/PM toggle', () => {
    it('renders AM and PM chips', () => {
      renderSection();
      expect(screen.getByRole('radio', { name: 'AM' })).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'PM' })).toBeInTheDocument();
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

    it('has accessible legend "AM or PM"', () => {
      renderSection();
      const legend = screen.getByText('AM or PM');
      expect(legend).toBeInTheDocument();
      expect(legend.tagName).toBe('LEGEND');
    });
  });

  describe('timezone toggle', () => {
    it('renders ET and CT chips', () => {
      renderSection();
      expect(screen.getByRole('radio', { name: 'ET' })).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'CT' })).toBeInTheDocument();
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

    it('shows CT chip active when timezone=CT', () => {
      renderSection({ timezone: 'CT' });
      expect(screen.getByRole('radio', { name: 'CT' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      expect(screen.getByRole('radio', { name: 'ET' })).toHaveAttribute(
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

    it('has accessible legend "Timezone"', () => {
      renderSection();
      const legend = screen.getByText('Timezone');
      expect(legend).toBeInTheDocument();
      expect(legend.tagName).toBe('LEGEND');
    });
  });

  describe('entry time section layout', () => {
    it('uses mt-auto class when vixDataLoaded is true', () => {
      const { container } = render(
        <DateTimeSection
          th={th}
          inputCls={INPUT_CLS}
          selectCls={SELECT_CLS}
          chevronUrl={CHEVRON_URL}
          selectedDate="2026-03-15"
          onDateChange={vi.fn()}
          vixDataLoaded={true}
          timeHour="9"
          onHourChange={vi.fn()}
          timeMinute="30"
          onMinuteChange={vi.fn()}
          timeAmPm="AM"
          onAmPmChange={vi.fn()}
          timezone="ET"
          onTimezoneChange={vi.fn()}
          errors={{}}
        />,
      );
      const entryDiv = container.querySelector('.mt-auto');
      expect(entryDiv).toBeInTheDocument();
    });

    it('does not use mt-auto class when vixDataLoaded is false', () => {
      const { container } = render(
        <DateTimeSection
          th={th}
          inputCls={INPUT_CLS}
          selectCls={SELECT_CLS}
          chevronUrl={CHEVRON_URL}
          selectedDate="2026-03-15"
          onDateChange={vi.fn()}
          vixDataLoaded={false}
          timeHour="9"
          onHourChange={vi.fn()}
          timeMinute="30"
          onMinuteChange={vi.fn()}
          timeAmPm="AM"
          onAmPmChange={vi.fn()}
          timezone="ET"
          onTimezoneChange={vi.fn()}
          errors={{}}
        />,
      );
      const entryDiv = container.querySelector('.mt-auto');
      expect(entryDiv).not.toBeInTheDocument();
    });
  });

  describe('time errors', () => {
    it('shows error when errors["time"] exists', () => {
      renderSection({ errors: { time: 'Invalid time' } });
      expect(screen.getByText('Invalid time')).toBeInTheDocument();
    });

    it('does not show error when no time error', () => {
      renderSection({ errors: {} });
      expect(screen.queryByText('Invalid time')).not.toBeInTheDocument();
    });

    it('error has role="alert"', () => {
      renderSection({
        errors: { time: 'Time out of range' },
        vixDataLoaded: false,
      });
      expect(screen.getByRole('alert')).toHaveTextContent('Time out of range');
    });
  });

  describe('EventDayWarning', () => {
    it('renders EventDayWarning component', () => {
      // EventDayWarning renders nothing when no events are scheduled
      // for the selected date, so we just verify no crash occurs
      renderSection({ selectedDate: '2026-03-15' });
      // The section should still render normally
      expect(screen.getByText('Date & Time')).toBeInTheDocument();
    });
  });
});
