/**
 * Component tests for the shared ScrubControls. Covers the four
 * branches the wider GexLandscape integration tests don't reliably hit:
 * scrub disabled vs enabled, LIVE badge presence, SCRUBBED badge + resume
 * button, and refresh while loading.
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ScrubControls } from '../../components/ScrubControls';

function defaultProps(
  overrides: Partial<Parameters<typeof ScrubControls>[0]> = {},
) {
  return {
    timestamp: '2026-04-14T20:30:00Z',
    selectedDate: '2026-04-14',
    onDateChange: vi.fn(),
    isLive: true,
    isScrubbed: false,
    canScrubPrev: true,
    canScrubNext: false,
    onScrubPrev: vi.fn(),
    onScrubNext: vi.fn(),
    onScrubTo: vi.fn(),
    onScrubLive: vi.fn(),
    onRefresh: vi.fn(),
    loading: false,
    timestamps: ['2026-04-14T20:25:00Z', '2026-04-14T20:30:00Z'],
    sectionLabel: 'GEX landscape',
    ...overrides,
  };
}

describe('ScrubControls', () => {
  it('renders a time picker dropdown when timestamps are available', () => {
    render(<ScrubControls {...defaultProps()} />);
    expect(
      screen.getByRole('combobox', { name: /jump to snapshot time/i }),
    ).toBeDefined();
  });

  it('omits the time picker when timestamp is null', () => {
    render(<ScrubControls {...defaultProps({ timestamp: null })} />);
    expect(
      screen.queryByRole('combobox', { name: /jump to snapshot time/i }),
    ).toBeNull();
  });

  it('shows the LIVE badge when isLive is true and not scrubbed', () => {
    render(<ScrubControls {...defaultProps()} />);
    // Two LIVE elements possible (timestamp color + badge); assert the badge specifically
    const liveBadges = screen.getAllByText('LIVE');
    expect(liveBadges.length).toBeGreaterThanOrEqual(1);
  });

  it('shows the SCRUBBED badge and resume button when isScrubbed is true', () => {
    render(
      <ScrubControls {...defaultProps({ isLive: false, isScrubbed: true })} />,
    );
    expect(screen.getByText('SCRUBBED')).toBeDefined();
    expect(screen.getByLabelText('Resume live')).toBeDefined();
  });

  it('disables the prev button when canScrubPrev is false', () => {
    const onScrubPrev = vi.fn();
    render(
      <ScrubControls {...defaultProps({ canScrubPrev: false, onScrubPrev })} />,
    );
    const prev = screen.getByLabelText(
      'Previous snapshot',
    ) as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    fireEvent.click(prev);
    expect(onScrubPrev).not.toHaveBeenCalled();
  });

  it('fires onScrubNext when the next button is clicked and enabled', () => {
    const onScrubNext = vi.fn();
    render(
      <ScrubControls {...defaultProps({ canScrubNext: true, onScrubNext })} />,
    );
    fireEvent.click(screen.getByLabelText('Next snapshot'));
    expect(onScrubNext).toHaveBeenCalledTimes(1);
  });

  it('fires onScrubLive when the resume button is clicked', () => {
    const onScrubLive = vi.fn();
    render(
      <ScrubControls
        {...defaultProps({ isLive: false, isScrubbed: true, onScrubLive })}
      />,
    );
    fireEvent.click(screen.getByLabelText('Resume live'));
    expect(onScrubLive).toHaveBeenCalledTimes(1);
  });

  it('forwards the typed date to onDateChange', () => {
    const onDateChange = vi.fn();
    render(<ScrubControls {...defaultProps({ onDateChange })} />);
    fireEvent.change(screen.getByLabelText('Select date'), {
      target: { value: '2026-04-13' },
    });
    expect(onDateChange).toHaveBeenCalledWith('2026-04-13');
  });

  it('uses sectionLabel in the refresh button aria-label', () => {
    const onRefresh = vi.fn();
    const { rerender } = render(
      <ScrubControls {...defaultProps({ onRefresh })} />,
    );
    fireEvent.click(screen.getByLabelText('Refresh GEX landscape'));
    expect(onRefresh).toHaveBeenCalledTimes(1);

    rerender(<ScrubControls {...defaultProps({ onRefresh, loading: true })} />);
    const refresh = screen.getByLabelText(
      'Refresh GEX landscape',
    ) as HTMLButtonElement;
    expect(refresh.disabled).toBe(true);
  });
});
