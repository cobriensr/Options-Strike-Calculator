import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FilterChip } from '../../components/ui/FilterChip';

describe('<FilterChip>', () => {
  it('renders children', () => {
    render(
      <FilterChip onClick={() => undefined} testId="t">
        hello
      </FilterChip>,
    );
    expect(screen.getByTestId('t')).toHaveTextContent('hello');
  });

  it('fires onClick when not disabled', () => {
    const onClick = vi.fn();
    render(
      <FilterChip onClick={onClick} testId="t">
        x
      </FilterChip>,
    );
    fireEvent.click(screen.getByTestId('t'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not fire onClick when disabled', () => {
    const onClick = vi.fn();
    render(
      <FilterChip onClick={onClick} disabled testId="t">
        x
      </FilterChip>,
    );
    fireEvent.click(screen.getByTestId('t'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('applies inactive classes when active is false', () => {
    render(
      <FilterChip onClick={() => undefined} testId="t">
        x
      </FilterChip>,
    );
    const chip = screen.getByTestId('t');
    expect(chip.className).toContain('border-neutral-700');
    expect(chip.className).toContain('text-neutral-300');
    expect(chip.className).not.toContain('bg-sky-950/40');
  });

  it('applies active color classes when active is true', () => {
    render(
      <FilterChip active activeColor="sky" onClick={() => undefined} testId="t">
        x
      </FilterChip>,
    );
    const chip = screen.getByTestId('t');
    expect(chip.className).toContain('border-sky-500/70');
    expect(chip.className).toContain('bg-sky-950/40');
    expect(chip.className).toContain('text-sky-200');
  });

  it('omits aria-pressed when prop is undefined', () => {
    render(
      <FilterChip onClick={() => undefined} testId="t">
        x
      </FilterChip>,
    );
    expect(screen.getByTestId('t')).not.toHaveAttribute('aria-pressed');
  });

  it('sets aria-pressed when prop is provided', () => {
    render(
      <FilterChip
        active
        activeColor="rose"
        ariaPressed
        onClick={() => undefined}
        testId="t"
      >
        x
      </FilterChip>,
    );
    expect(screen.getByTestId('t')).toHaveAttribute('aria-pressed', 'true');
  });

  it('appends className escape hatch', () => {
    render(
      <FilterChip onClick={() => undefined} testId="t" className="extra-cls">
        x
      </FilterChip>,
    );
    expect(screen.getByTestId('t').className).toContain('extra-cls');
  });
});
