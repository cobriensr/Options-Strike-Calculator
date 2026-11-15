import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DateInput } from '../../../components/ui/DateInput';

describe('DateInput', () => {
  it('renders with the label as the aria-label', () => {
    render(
      <DateInput label="Trading day" value="2026-04-17" onChange={() => {}} />,
    );
    const input = screen.getByLabelText('Trading day');
    expect(input).toBeInTheDocument();
    expect((input as HTMLInputElement).type).toBe('date');
  });

  it('forwards the controlled value', () => {
    render(<DateInput label="d" value="2026-04-17" onChange={() => {}} />);
    const input = screen.getByLabelText('d') as HTMLInputElement;
    expect(input.value).toBe('2026-04-17');
  });

  it('calls onChange with the new value', () => {
    const onChange = vi.fn();
    render(<DateInput label="d" value="" onChange={onChange} />);
    const input = screen.getByLabelText('d');
    fireEvent.change(input, { target: { value: '2026-04-23' } });
    expect(onChange).toHaveBeenCalledWith('2026-04-23');
  });

  it('passes min/max to the underlying input', () => {
    render(
      <DateInput
        label="d"
        value=""
        onChange={() => {}}
        min="2026-01-01"
        max="2026-12-31"
      />,
    );
    const input = screen.getByLabelText('d') as HTMLInputElement;
    expect(input.min).toBe('2026-01-01');
    expect(input.max).toBe('2026-12-31');
  });

  it('passes list attribute through for datalist hints', () => {
    render(
      <DateInput
        label="d"
        value=""
        onChange={() => {}}
        list="my-available-dates"
      />,
    );
    const input = screen.getByLabelText('d') as HTMLInputElement;
    expect(input.getAttribute('list')).toBe('my-available-dates');
  });

  it('hides the visual label but keeps the accessible name when labelVisible=false', () => {
    render(
      <DateInput
        label="Hidden"
        value=""
        onChange={() => {}}
        labelVisible={false}
      />,
    );
    expect(screen.getByLabelText('Hidden')).toBeInTheDocument();
    const labels = screen.getAllByText('Hidden');
    expect(labels[0]?.className).toContain('sr-only');
  });
});

// ============================================================
// AN EMPTIED FIELD
//
// A native date input fires `input` with '' whenever its value goes invalid:
// the first "0" of a zero-padded month or day does it, as does a cleared
// segment. If that '' is forwarded and the parent turns it into a date (a
// panel that follows today does), the controlled field is rewritten to that
// date and the segments typed so far are lost: typing 04092026 over
// 2026-11-15 ended at 2026-11-09, not 2026-04-09. So the field keeps an
// emptied draft locally, tells the parent nothing until a date is complete,
// and forwards '' only when the field is left empty.
// ============================================================

describe('DateInput: an emptied field', () => {
  function setup(value = '2026-11-15') {
    const onChange = vi.fn();
    const utils = render(
      <DateInput label="d" value={value} onChange={onChange} />,
    );
    const input = screen.getByLabelText('d') as HTMLInputElement;
    return { onChange, input, ...utils };
  }
  const empty = (input: HTMLElement) =>
    fireEvent.change(input, { target: { value: '' } });

  /** A panel that follows today: '' means today. */
  function Following() {
    const [date, setDate] = useState('2026-11-15');
    return (
      <DateInput
        label="d"
        value={date}
        onChange={(next) => setDate(next === '' ? '2026-11-15' : next)}
      />
    );
  }

  it('shows the field empty and forwards nothing when it is emptied', () => {
    const { onChange, input } = setup();

    empty(input);

    expect(input.value).toBe('');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('forwards the empty value once, on blur', () => {
    const { onChange, input } = setup();
    empty(input);
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.blur(input);

    expect(onChange.mock.calls).toEqual([['']]);
    // The draft is gone: the field shows its value again until the parent
    // gives it another, and a second blur forwards nothing.
    expect(input.value).toBe('2026-11-15');
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('forwards a complete date and drops the empty draft', () => {
    const { onChange, input } = setup();
    empty(input);

    fireEvent.change(input, { target: { value: '2026-04-09' } });
    fireEvent.blur(input);

    expect(onChange.mock.calls).toEqual([['2026-04-09']]);
  });

  it('drops the draft when the value changes from outside', () => {
    const { onChange, input, rerender } = setup();
    empty(input);

    // The LIVE button or the midnight roll hands the field a new date.
    rerender(<DateInput label="d" value="2026-11-16" onChange={onChange} />);

    expect(input.value).toBe('2026-11-16');
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('forwards a blur with no draft as nothing', () => {
    const { onChange, input } = setup();

    fireEvent.blur(input);

    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps the segments typed so far when the parent turns "" into a date', () => {
    // Typing a zero-padded date over the field empties it on the first "0",
    // then completes it.
    render(<Following />);
    const input = screen.getByLabelText('d') as HTMLInputElement;

    empty(input);
    // Not rewritten to today mid-edit.
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: '2026-04-09' } });

    expect(input.value).toBe('2026-04-09');
  });

  it('puts the date back when a followed field is left empty', () => {
    render(<Following />);
    const input = screen.getByLabelText('d') as HTMLInputElement;

    empty(input);
    fireEvent.blur(input);

    expect(input.value).toBe('2026-11-15');
  });
});
