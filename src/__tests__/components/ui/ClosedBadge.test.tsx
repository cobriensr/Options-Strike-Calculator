import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ClosedBadge } from '../../../components/ui/ClosedBadge';
import { ClosedBadge as ClosedBadgeFromBarrel } from '../../../components/ui';

describe('ClosedBadge', () => {
  beforeEach(() => {
    // Without fake timers `setSystemTime` pins only `Date`, which is all the
    // label reads (whether the capture is more than 6 days old).
    vi.setSystemTime(new Date('2026-11-21T15:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is exported from the ui barrel', () => {
    expect(ClosedBadgeFromBarrel).toBe(ClosedBadge);
  });

  it('renders the pill with the capture label', () => {
    render(<ClosedBadge asOf="2026-11-20T21:00:49.000Z" testId="b" />);
    expect(screen.getByTestId('b').textContent).toBe(
      'CLOSED · as of Fri 3:00 PM CT',
    );
  });

  it('adds the date past 6 days', () => {
    vi.setSystemTime(new Date('2026-11-26T21:00:50Z'));
    render(<ClosedBadge asOf="2026-11-20T21:00:49.000Z" testId="b" />);
    expect(screen.getByTestId('b').textContent).toBe(
      'CLOSED · as of Fri Nov 20 3:00 PM CT',
    );
  });

  it('renders nothing when asOf is absent', () => {
    const { container } = render(<ClosedBadge testId="b" />);
    expect(container.firstChild).toBeNull();
  });

  it.each([null, '', 'not a time'])('renders nothing for %s', (asOf) => {
    const { container } = render(<ClosedBadge asOf={asOf} testId="b" />);
    expect(container.firstChild).toBeNull();
  });

  it('carries the shared style and is not hidden from assistive tech', () => {
    render(<ClosedBadge asOf="2026-11-20T21:00:49.000Z" testId="b" />);
    const el = screen.getByTestId('b');
    expect(el).toHaveClass(
      'rounded',
      'px-1.5',
      'py-0.5',
      'font-mono',
      'text-[10px]',
      'font-semibold',
      'whitespace-nowrap',
    );
    expect(el).not.toHaveAttribute('aria-hidden');
    expect(el).not.toHaveAttribute('aria-label');
    expect(el.style.color).not.toBe('');
    expect(el.style.background).not.toBe('');
  });
});
