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
