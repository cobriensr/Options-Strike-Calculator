import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ViewToggle } from '../components/ViewToggle';

describe('ViewToggle', () => {
  it('renders both view controls in a nav landmark', () => {
    render(<ViewToggle view="calculator" onViewChange={vi.fn()} />);
    expect(
      screen.getByRole('navigation', { name: /application view/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /calculator/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /options alerts/i }),
    ).toBeInTheDocument();
  });

  it('marks the active view with aria-current="page" and leaves the inactive one unset', () => {
    render(<ViewToggle view="alerts" onViewChange={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: /options alerts/i }),
    ).toHaveAttribute('aria-current', 'page');
    expect(
      screen.getByRole('button', { name: /calculator/i }),
    ).not.toHaveAttribute('aria-current');
  });

  it('calls onViewChange with the clicked view', () => {
    const onViewChange = vi.fn();
    render(<ViewToggle view="calculator" onViewChange={onViewChange} />);
    fireEvent.click(screen.getByRole('button', { name: /options alerts/i }));
    expect(onViewChange).toHaveBeenCalledWith('alerts');
  });
});
