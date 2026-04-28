import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DateInputET } from '../../../components/ui/DateInputET';

describe('DateInputET', () => {
  it('renders with an ET-anchored aria-label', () => {
    render(
      <DateInputET
        label="Trading day"
        value="2026-04-17"
        onChange={() => {}}
      />,
    );
    const input = screen.getByLabelText('Trading day (Eastern Time)');
    expect(input).toBeInTheDocument();
    expect((input as HTMLInputElement).type).toBe('date');
  });

  it('forwards the controlled value', () => {
    render(<DateInputET label="d" value="2026-04-17" onChange={() => {}} />);
    const input = screen.getByLabelText('d (Eastern Time)') as HTMLInputElement;
    expect(input.value).toBe('2026-04-17');
  });

  it('calls onChange with the new value', () => {
    const onChange = vi.fn();
    render(<DateInputET label="d" value="" onChange={onChange} />);
    const input = screen.getByLabelText('d (Eastern Time)');
    fireEvent.change(input, { target: { value: '2026-04-23' } });
    expect(onChange).toHaveBeenCalledWith('2026-04-23');
  });

  it('passes min/max to the underlying input', () => {
    render(
      <DateInputET
        label="d"
        value=""
        onChange={() => {}}
        min="2026-01-01"
        max="2026-12-31"
      />,
    );
    const input = screen.getByLabelText('d (Eastern Time)') as HTMLInputElement;
    expect(input.min).toBe('2026-01-01');
    expect(input.max).toBe('2026-12-31');
  });

  it('passes list attribute through for datalist hints', () => {
    render(
      <DateInputET
        label="d"
        value=""
        onChange={() => {}}
        list="my-available-dates"
      />,
    );
    const input = screen.getByLabelText('d (Eastern Time)') as HTMLInputElement;
    expect(input.getAttribute('list')).toBe('my-available-dates');
  });

  it('hides the visual label but keeps the aria-label when labelVisible=false', () => {
    render(
      <DateInputET
        label="Hidden"
        value=""
        onChange={() => {}}
        labelVisible={false}
      />,
    );
    expect(screen.getByLabelText('Hidden (Eastern Time)')).toBeInTheDocument();
    const labels = screen.getAllByText('Hidden (Eastern Time)');
    expect(labels[0]?.className).toContain('sr-only');
  });
});
