import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ViewToggle } from '../components/ViewToggle';

describe('ViewToggle', () => {
  it('renders both view tabs', () => {
    render(<ViewToggle view="calculator" onViewChange={vi.fn()} />);
    expect(
      screen.getByRole('tab', { name: /calculator/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: /options alerts/i }),
    ).toBeInTheDocument();
  });

  it('marks the active view with aria-selected', () => {
    render(<ViewToggle view="alerts" onViewChange={vi.fn()} />);
    expect(
      screen.getByRole('tab', { name: /options alerts/i }),
    ).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /calculator/i })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('calls onViewChange with the clicked view', () => {
    const onViewChange = vi.fn();
    render(<ViewToggle view="calculator" onViewChange={onViewChange} />);
    fireEvent.click(screen.getByRole('tab', { name: /options alerts/i }));
    expect(onViewChange).toHaveBeenCalledWith('alerts');
  });
});
