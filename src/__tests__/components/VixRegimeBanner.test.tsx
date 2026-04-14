import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import VixRegimeBanner from '../../components/VixRegimeBanner';
import { classifyVix } from '../../components/VixRegimeBanner/regime';

describe('classifyVix', () => {
  it.each([
    [0, 'calm'],
    [10, 'calm'],
    [14.99, 'calm'],
    [15, 'normal'],
    [17, 'normal'],
    [19.99, 'normal'],
    [20, 'elevated'],
    [25, 'elevated'],
    [29.99, 'elevated'],
    [30, 'stress'],
    [50, 'stress'],
    [100, 'stress'],
  ])('%f -> %s bucket', (vix, expectedKey) => {
    expect(classifyVix(vix).key).toBe(expectedKey);
  });

  it('returns matching severity for each bucket', () => {
    expect(classifyVix(10).severity).toBe('ok');
    expect(classifyVix(17).severity).toBe('note');
    expect(classifyVix(25).severity).toBe('warn');
    expect(classifyVix(35).severity).toBe('danger');
  });
});

describe('<VixRegimeBanner />', () => {
  it('renders nothing for null / undefined / empty / non-numeric input', () => {
    const cases: Array<string | number | null | undefined> = [
      null,
      undefined,
      '',
      'abc',
      0,
      -5,
    ];
    for (const v of cases) {
      const { container, unmount } = render(<VixRegimeBanner vix={v} />);
      expect(container.firstChild).toBeNull();
      unmount();
    }
  });

  it('accepts numeric VIX and renders the regime label + rule', () => {
    render(<VixRegimeBanner vix={24.3} />);
    const banner = screen.getByTestId('vix-regime-banner');
    expect(banner).toHaveAttribute('data-regime', 'elevated');
    expect(banner.textContent).toContain('VIX 24.3');
    expect(banner.textContent).toContain('Elevated');
    expect(banner.textContent).toContain('Flat short-gamma by 2:45 CT');
  });

  it('parses string VIX input (from calculator input fields)', () => {
    render(<VixRegimeBanner vix="33.4" />);
    const banner = screen.getByTestId('vix-regime-banner');
    expect(banner).toHaveAttribute('data-regime', 'stress');
    expect(banner.textContent).toContain('Do NOT sell iron flies or BWBs');
  });

  it('pulses only for Stress regime, not Elevated or below', () => {
    const { rerender } = render(<VixRegimeBanner vix={12} />);
    expect(screen.getByTestId('vix-regime-banner')).not.toHaveClass(
      'animate-pulse',
    );

    rerender(<VixRegimeBanner vix={25} />);
    expect(screen.getByTestId('vix-regime-banner')).not.toHaveClass(
      'animate-pulse',
    );

    rerender(<VixRegimeBanner vix={33} />);
    expect(screen.getByTestId('vix-regime-banner')).toHaveClass(
      'animate-pulse',
    );
  });

  it('exposes the rule text via aria-label for screen readers', () => {
    render(<VixRegimeBanner vix={10} />);
    const banner = screen.getByTestId('vix-regime-banner');
    expect(banner).toHaveAttribute(
      'aria-label',
      expect.stringContaining('VIX regime: Calm'),
    );
  });
});
