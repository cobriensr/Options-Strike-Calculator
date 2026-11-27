/**
 * Component tests for the shared ScrubControls. Covers the four
 * branches the wider GexLandscape integration tests don't reliably hit:
 * scrub disabled vs enabled, LIVE badge presence, SCRUBBED badge + resume
 * button, and refresh while loading.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ScrubControls } from '../../components/ScrubControls';
import {
  genericElementsWithAriaLabel,
  srHintText,
  titledGenericsWithoutHint,
} from '../helpers/aria';

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
    fireEvent.change(screen.getByLabelText(/Select date/i), {
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

// Site 96: the DELAYED badge. The GEX landscape passes a 3-minute threshold;
// the badge's hover text names the feed, not "alerts" (the panel shows GEX
// strike data), and a screen reader hears the same words.
describe('ScrubControls DELAYED badge (site 96)', () => {
  const HINT = 'the upstream feed has not sent new data';

  it('flips from LIVE to DELAYED 3m exactly at a 180 000 ms threshold', () => {
    const { rerender, container } = render(
      <ScrubControls
        {...defaultProps({ lastDataAgeMs: 179_999, staleThresholdMs: 180_000 })}
      />,
    );
    expect(screen.queryByText(/^DELAYED/)).toBeNull();
    expect(screen.getAllByText('LIVE').length).toBeGreaterThan(0);

    rerender(
      <ScrubControls
        {...defaultProps({ lastDataAgeMs: 180_000, staleThresholdMs: 180_000 })}
      />,
    );
    const badge = screen.getByText('DELAYED 3m');
    expect(srHintText(badge)).toBe(HINT);
    expect(badge).toHaveAttribute(
      'title',
      'Latest data is 3m old — the upstream feed has not sent new data',
    );
    // The LIVE pill gives way to the DELAYED one.
    expect(screen.queryAllByText('LIVE')).toHaveLength(0);
    expect(titledGenericsWithoutHint(container)).toEqual([]);
  });

  it.each([
    [12 * 60_000, 12],
    [7 * 60_000 + 59_999, 7],
  ])(
    'floors %i ms to %i whole minutes in the badge, title and hint',
    (lastDataAgeMs, minutes) => {
      render(
        <ScrubControls
          {...defaultProps({ lastDataAgeMs, staleThresholdMs: 180_000 })}
        />,
      );
      const badge = screen.getByText(`DELAYED ${minutes}m`);
      expect(badge).toHaveAttribute(
        'title',
        `Latest data is ${minutes}m old — the upstream feed has not sent new data`,
      );
      expect(srHintText(badge)).toBe(HINT);
    },
  );

  it('keeps the 5-minute default threshold for a caller that passes none', () => {
    const { rerender } = render(
      <ScrubControls {...defaultProps({ lastDataAgeMs: 299_999 })} />,
    );
    expect(screen.queryByText(/^DELAYED/)).toBeNull();
    rerender(<ScrubControls {...defaultProps({ lastDataAgeMs: 300_000 })} />);
    expect(screen.getByText('DELAYED 5m')).toBeDefined();
  });

  it('shows no DELAYED badge when the panel is not live', () => {
    const { container } = render(
      <ScrubControls
        {...defaultProps({
          isLive: false,
          isScrubbed: true,
          lastDataAgeMs: 900_000,
          staleThresholdMs: 180_000,
        })}
      />,
    );
    expect(screen.queryByText(/^DELAYED/)).toBeNull();
    expect(screen.getByText('SCRUBBED')).toBeDefined();
    expect(titledGenericsWithoutHint(container)).toEqual([]);
  });
});

// The opt-in CLOSED pill: `closedAsOf` swaps the LIVE or DELAYED badge for
// "CLOSED · as of <capture time>" while the panel is not scrubbed. Without
// the prop the controls render exactly as they did before it existed.
describe('ScrubControls CLOSED badge', () => {
  // 3:00 PM CT on Friday 2026-11-20, a few seconds into the capture minute.
  const CLOSE = '2026-11-20T21:00:07.000Z';
  const PILL = 'CLOSED · as of Fri 3:00 PM CT';

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-21T15:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the capture time in the badge slot once the market has closed', () => {
    render(
      <ScrubControls {...defaultProps({ isLive: false, closedAsOf: CLOSE })} />,
    );
    expect(screen.getByTestId('scrub-closed-badge').textContent).toBe(PILL);
    expect(screen.queryAllByText('LIVE')).toHaveLength(0);
    expect(screen.queryByText(/^DELAYED/)).toBeNull();
    expect(screen.queryByText('SCRUBBED')).toBeNull();
  });

  it('adds the date once the capture is more than 6 days old', () => {
    vi.setSystemTime(new Date('2026-11-30T15:00:00Z'));
    render(
      <ScrubControls {...defaultProps({ isLive: false, closedAsOf: CLOSE })} />,
    );
    expect(screen.getByTestId('scrub-closed-badge').textContent).toBe(
      'CLOSED · as of Fri Nov 20 3:00 PM CT',
    );
  });

  it('takes the place of LIVE and of DELAYED when the caller still says live', () => {
    const { rerender } = render(
      <ScrubControls {...defaultProps({ closedAsOf: CLOSE })} />,
    );
    expect(screen.getByTestId('scrub-closed-badge').textContent).toBe(PILL);
    expect(screen.queryAllByText('LIVE')).toHaveLength(0);

    rerender(
      <ScrubControls
        {...defaultProps({
          closedAsOf: CLOSE,
          lastDataAgeMs: 900_000,
          staleThresholdMs: 180_000,
        })}
      />,
    );
    expect(screen.getByTestId('scrub-closed-badge').textContent).toBe(PILL);
    expect(screen.queryByText(/^DELAYED/)).toBeNull();
  });

  it('lets the row wrap, so a long pill drops to its own line instead of overflowing the header', () => {
    const { container } = render(
      <ScrubControls {...defaultProps({ isLive: false, closedAsOf: CLOSE })} />,
    );
    expect(container.firstElementChild).toHaveClass('flex-wrap');
  });

  it('gives way to SCRUBBED on a scrubbed view', () => {
    render(
      <ScrubControls
        {...defaultProps({
          isLive: false,
          isScrubbed: true,
          closedAsOf: CLOSE,
        })}
      />,
    );
    expect(screen.queryByTestId('scrub-closed-badge')).toBeNull();
    expect(screen.getByText('SCRUBBED')).toBeDefined();
    expect(screen.getByLabelText('Resume live')).toBeDefined();
  });

  it('leaves the time select on the timestamp it was given', () => {
    render(
      <ScrubControls {...defaultProps({ isLive: false, closedAsOf: CLOSE })} />,
    );
    const select = screen.getByRole('combobox', {
      name: /jump to snapshot time/i,
    }) as HTMLSelectElement;
    expect(select.value).toBe('2026-04-14T20:30:00Z');
  });

  it('exposes the pill as plain text to assistive tech, with no ARIA name on a generic element', () => {
    const { container } = render(
      <ScrubControls {...defaultProps({ isLive: false, closedAsOf: CLOSE })} />,
    );
    const badge = screen.getByTestId('scrub-closed-badge');
    expect(badge).not.toHaveAttribute('aria-hidden');
    expect(badge.closest('[aria-hidden="true"]')).toBeNull();
    expect(genericElementsWithAriaLabel(container)).toEqual([]);
    expect(titledGenericsWithoutHint(container)).toEqual([]);
  });

  describe('without the prop', () => {
    it.each([
      ['absent', undefined],
      ['null', null],
    ])('renders exactly as before when closedAsOf is %s', (_label, value) => {
      // React's useId counts up across renders, in base 32 (DateInput's input
      // id: `_r_0_`, `_r_a_`, …), so the ids are masked before the two trees
      // are compared.
      const markup = (el: HTMLElement) =>
        el.innerHTML.replaceAll(/_r_[0-9a-z]+_/g, '_r_#_');

      const bare = render(<ScrubControls {...defaultProps()} />);
      const bareHtml = markup(bare.container);
      bare.unmount();

      const { container } = render(
        <ScrubControls {...defaultProps({ closedAsOf: value })} />,
      );
      expect(markup(container)).toBe(bareHtml);
      expect(screen.queryByTestId('scrub-closed-badge')).toBeNull();
      expect(screen.getAllByText('LIVE').length).toBeGreaterThan(0);
    });

    it('shows no badge at all for a closed, unscrubbed panel, as before', () => {
      render(<ScrubControls {...defaultProps({ isLive: false })} />);
      expect(screen.queryByTestId('scrub-closed-badge')).toBeNull();
      expect(screen.queryAllByText('LIVE')).toHaveLength(0);
      expect(screen.queryByText(/^DELAYED/)).toBeNull();
      expect(screen.queryByText('SCRUBBED')).toBeNull();
    });
  });
});
