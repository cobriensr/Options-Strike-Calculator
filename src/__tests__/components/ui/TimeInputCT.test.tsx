import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TimeInputCT } from '../../../components/ui/TimeInputCT';

describe('TimeInputCT', () => {
  it('renders with a CT-anchored aria-label', () => {
    render(
      <TimeInputCT label="Start time" value="09:30" onChange={() => {}} />,
    );
    const input = screen.getByLabelText('Start time (Central Time)');
    expect(input).toBeInTheDocument();
    expect((input as HTMLInputElement).type).toBe('time');
  });

  it('forwards the controlled value', () => {
    render(<TimeInputCT label="t" value="13:45" onChange={() => {}} />);
    const input = screen.getByLabelText('t (Central Time)') as HTMLInputElement;
    expect(input.value).toBe('13:45');
  });

  it('calls onChange with the new value', () => {
    const onChange = vi.fn();
    render(<TimeInputCT label="t" value="" onChange={onChange} />);
    const input = screen.getByLabelText('t (Central Time)');
    // fireEvent.change is the reliable cross-jsdom way to drive a controlled
    // type=time input — userEvent.type is flaky for time pickers.
    fireEvent.change(input, { target: { value: '10:15' } });
    expect(onChange).toHaveBeenCalledWith('10:15');
  });

  it('passes min/max to the underlying input', () => {
    render(
      <TimeInputCT
        label="t"
        value=""
        onChange={() => {}}
        min="08:30"
        max="15:00"
      />,
    );
    const input = screen.getByLabelText('t (Central Time)') as HTMLInputElement;
    expect(input.min).toBe('08:30');
    expect(input.max).toBe('15:00');
  });

  it('uses 1-minute step granularity', () => {
    render(<TimeInputCT label="t" value="" onChange={() => {}} />);
    const input = screen.getByLabelText('t (Central Time)') as HTMLInputElement;
    expect(input.step).toBe('60');
  });

  it('hides the visual label but keeps the aria-label when labelVisible=false', () => {
    render(
      <TimeInputCT
        label="Hidden"
        value=""
        onChange={() => {}}
        labelVisible={false}
      />,
    );
    expect(screen.getByLabelText('Hidden (Central Time)')).toBeInTheDocument();
    // The visible label text is rendered inside an .sr-only label, so
    // .getByText would still find it but hidden from sighted users via CSS.
    const labels = screen.getAllByText('Hidden (Central Time)');
    expect(labels[0]?.className).toContain('sr-only');
  });
});
