import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThresholdsEditor } from '../../components/Tracker/ThresholdsEditor';
import {
  DEFAULT_UP_THRESHOLDS,
  DEFAULT_DOWN_THRESHOLDS,
} from '../../components/Tracker/types';

describe('ThresholdsEditor', () => {
  it('renders DEFAULT_UP_THRESHOLDS + "(using defaults)" hint when upThresholds is null', () => {
    render(
      <ThresholdsEditor
        upThresholds={null}
        downThresholds={[-30]}
        onChange={() => undefined}
      />,
    );
    for (const v of DEFAULT_UP_THRESHOLDS) {
      expect(
        screen.getByRole('button', { name: `Remove up threshold ${String(v)}%` }),
      ).toBeInTheDocument();
    }
    // Defaults hint appears next to "Up thresholds" but NOT down (down is explicit).
    expect(screen.getAllByText('(using defaults)')).toHaveLength(1);
  });

  it('renders DEFAULT_DOWN_THRESHOLDS + hint when downThresholds is null', () => {
    render(
      <ThresholdsEditor
        upThresholds={[50]}
        downThresholds={null}
        onChange={() => undefined}
      />,
    );
    for (const v of DEFAULT_DOWN_THRESHOLDS) {
      expect(
        screen.getByRole('button', {
          name: `Remove down threshold ${String(v)}%`,
        }),
      ).toBeInTheDocument();
    }
    expect(screen.getAllByText('(using defaults)')).toHaveLength(1);
  });

  it('add up threshold: parses "+75" → 75, calls onChange with sorted list', () => {
    const onChange = vi.fn();
    render(
      <ThresholdsEditor
        upThresholds={[50, 200]}
        downThresholds={[-30]}
        onChange={onChange}
      />,
    );
    const input = screen.getByRole('textbox', {
      name: 'New up threshold percentage',
    });
    fireEvent.change(input, { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add up threshold' }));

    expect(onChange).toHaveBeenCalledWith([50, 100, 200], [-30]);
    expect(input).toHaveValue('');
  });

  it('add up threshold rejects non-positive values', () => {
    const onChange = vi.fn();
    render(
      <ThresholdsEditor
        upThresholds={[]}
        downThresholds={null}
        onChange={onChange}
      />,
    );
    const input = screen.getByRole('textbox', {
      name: 'New up threshold percentage',
    });
    fireEvent.change(input, { target: { value: '-50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add up threshold' }));
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add up threshold' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('add down threshold: parses "-50%" → -50, sorted descending', () => {
    const onChange = vi.fn();
    render(
      <ThresholdsEditor
        upThresholds={[50]}
        downThresholds={[-30]}
        onChange={onChange}
      />,
    );
    const input = screen.getByRole('textbox', {
      name: 'New down threshold percentage',
    });
    // The % suffix is stripped; the parsed value must be negative
    fireEvent.change(input, { target: { value: '-50%' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add down threshold' }));
    // Down list is sorted descending (closer-to-zero first)
    expect(onChange).toHaveBeenCalledWith([50], [-30, -50]);
  });

  it('add down threshold rejects non-negative values', () => {
    const onChange = vi.fn();
    render(
      <ThresholdsEditor
        upThresholds={null}
        downThresholds={[]}
        onChange={onChange}
      />,
    );
    const input = screen.getByRole('textbox', {
      name: 'New down threshold percentage',
    });
    fireEvent.change(input, { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add down threshold' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('removing the LAST up threshold fires onChange(null, down) not onChange([], down)', () => {
    const onChange = vi.fn();
    render(
      <ThresholdsEditor
        upThresholds={[100]}
        downThresholds={[-30]}
        onChange={onChange}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove up threshold 100%' }),
    );
    expect(onChange).toHaveBeenCalledWith(null, [-30]);
  });

  it('removing the LAST down threshold fires onChange(up, null)', () => {
    const onChange = vi.fn();
    render(
      <ThresholdsEditor
        upThresholds={[50]}
        downThresholds={[-30]}
        onChange={onChange}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove down threshold -30%' }),
    );
    expect(onChange).toHaveBeenCalledWith([50], null);
  });

  it('non-numeric input is silently rejected on add', () => {
    const onChange = vi.fn();
    render(
      <ThresholdsEditor
        upThresholds={null}
        downThresholds={null}
        onChange={onChange}
      />,
    );
    fireEvent.change(
      screen.getByRole('textbox', { name: 'New up threshold percentage' }),
      { target: { value: 'abc' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add up threshold' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
