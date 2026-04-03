import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BackToTop from '../../components/BackToTop';

// ── Setup ────────────────────────────────────────────────

let rafSpy: ReturnType<typeof vi.spyOn>;
let scrollToSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // Mock rAF to execute callback immediately
  rafSpy = vi
    .spyOn(window, 'requestAnimationFrame')
    .mockImplementation((cb) => {
      cb(0);
      return 0;
    });

  // Mock scrollTo
  scrollToSpy = vi.fn();
  window.scrollTo = scrollToSpy as unknown as typeof window.scrollTo;

  // Default: top of page, 500px viewport
  Object.defineProperty(window, 'scrollY', {
    value: 0,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, 'innerHeight', {
    value: 500,
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  rafSpy.mockRestore();
  vi.restoreAllMocks();
});

// ============================================================
// HIDDEN BY DEFAULT
// ============================================================

describe('BackToTop: hidden by default', () => {
  it('renders but is not visible when at the top of the page', () => {
    render(<BackToTop />);

    const button = screen.getByRole('button', { name: 'Back to top' });
    expect(button).toBeInTheDocument();
    expect(button.className).toContain('opacity-0');
    expect(button.className).toContain('pointer-events-none');
  });
});

// ============================================================
// APPEARS ON SCROLL
// ============================================================

describe('BackToTop: appears on scroll', () => {
  it('becomes visible after scrolling past 2x viewport height', () => {
    render(<BackToTop />);

    const button = screen.getByRole('button', { name: 'Back to top' });

    // Scroll past threshold (innerHeight * 2 = 1000)
    Object.defineProperty(window, 'scrollY', {
      value: 1500,
      configurable: true,
    });
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });

    expect(button.className).toContain('opacity-100');
    expect(button.className).toContain('pointer-events-auto');
  });

  it('hides again when scrolling back up', () => {
    render(<BackToTop />);

    const button = screen.getByRole('button', { name: 'Back to top' });

    // Scroll past threshold
    Object.defineProperty(window, 'scrollY', {
      value: 1500,
      configurable: true,
    });
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(button.className).toContain('opacity-100');

    // Scroll back up
    Object.defineProperty(window, 'scrollY', {
      value: 100,
      configurable: true,
    });
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(button.className).toContain('opacity-0');
    expect(button.className).toContain('pointer-events-none');
  });
});

// ============================================================
// SCROLLS TO TOP ON CLICK
// ============================================================

describe('BackToTop: scrolls to top on click', () => {
  it('calls window.scrollTo({ top: 0 }) when clicked', async () => {
    const user = userEvent.setup();
    render(<BackToTop />);

    // Make button visible first
    Object.defineProperty(window, 'scrollY', {
      value: 1500,
      configurable: true,
    });
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });

    const button = screen.getByRole('button', { name: 'Back to top' });
    await user.click(button);

    expect(scrollToSpy).toHaveBeenCalledTimes(1);
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 0 });
  });
});

// ============================================================
// ACCESSIBILITY
// ============================================================

describe('BackToTop: accessibility', () => {
  it('has correct aria-label', () => {
    render(<BackToTop />);

    const button = screen.getByLabelText('Back to top');
    expect(button).toBeInTheDocument();
    expect(button.tagName).toBe('BUTTON');
  });

  it('SVG has aria-hidden="true"', () => {
    render(<BackToTop />);

    const button = screen.getByRole('button', { name: 'Back to top' });
    const svg = button.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('aria-hidden')).toBe('true');
  });
});
