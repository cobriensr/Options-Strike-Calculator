/**
 * MetricsBar — covers the four sub-badges' conditional branches:
 * SlopeBadge (null / positive / negative / zero), FlipBadge
 * (occurred=false / sign +1 / sign -1 / sign 0), CliffBadge
 * (null timestamp / zero magnitude / present), DivergenceBadge
 * (diverging=false / true), and the fmtTime helper paths reached
 * via title attributes (null / invalid / valid ISO).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MetricsBar } from '../MetricsBar';
import type {
  CliffResult,
  DivergenceResult,
  FlipResult,
  SlopeResult,
} from '../../../hooks/useGreekFlow';
import {
  srHintText,
  titledElementsNeedingHint,
  titledGenericsWithoutHint,
} from '../../../__tests__/helpers/aria';

const noFlip: FlipResult = {
  occurred: false,
  atTimestamp: null,
  magnitude: 0,
  currentSign: 0,
};
const noCliff: CliffResult = { magnitude: 0, atTimestamp: null };
const noDiv: DivergenceResult = { spySign: 0, qqqSign: 0, diverging: false };

function renderBar(
  overrides: {
    slope?: SlopeResult;
    flip?: FlipResult;
    cliff?: CliffResult;
    divergence?: DivergenceResult;
  } = {},
) {
  return render(
    <MetricsBar
      slope={overrides.slope ?? { slope: null, points: 0 }}
      flip={overrides.flip ?? noFlip}
      cliff={overrides.cliff ?? noCliff}
      divergence={overrides.divergence ?? noDiv}
    />,
  );
}

describe('MetricsBar — SlopeBadge', () => {
  it('renders an em-dash placeholder when slope is null', () => {
    renderBar();
    const badge = screen.getByTitle('Insufficient points for slope');
    expect(badge.textContent).toBe('—');
    expect(badge).toHaveClass('text-secondary');
  });

  it('renders a green up-arrow when slope is positive', () => {
    renderBar({ slope: { slope: 1.234, points: 15 } });
    const badge = screen.getByTitle(/Slope.*1\.23 per min/);
    expect(badge.textContent).toContain('↑');
    expect(badge).toHaveClass('text-emerald-400');
  });

  it('renders a red down-arrow when slope is negative', () => {
    renderBar({ slope: { slope: -2.5, points: 15 } });
    const badge = screen.getByTitle(/Slope.*-2\.50 per min/);
    expect(badge.textContent).toContain('↓');
    expect(badge).toHaveClass('text-rose-400');
  });

  it('renders a flat arrow when slope is exactly zero', () => {
    renderBar({ slope: { slope: 0, points: 15 } });
    const badge = screen.getByTitle(/Slope.*0\.00 per min/);
    expect(badge.textContent).toContain('→');
    expect(badge).toHaveClass('text-secondary');
  });
});

describe('MetricsBar — FlipBadge', () => {
  it('renders nothing when no flip occurred', () => {
    renderBar();
    expect(screen.queryByText('flip')).not.toBeInTheDocument();
  });

  it('renders a green flip badge when currentSign = +1', () => {
    renderBar({
      flip: {
        occurred: true,
        atTimestamp: '2026-04-28T18:30:00Z',
        magnitude: 1234,
        currentSign: 1,
      },
    });
    const badge = screen.getByText('flip');
    expect(badge).toHaveClass('text-emerald-400');
    expect(badge.getAttribute('title')).toMatch(/mag 1234/);
  });

  it('renders a red flip badge when currentSign = -1', () => {
    renderBar({
      flip: {
        occurred: true,
        atTimestamp: '2026-04-28T18:30:00Z',
        magnitude: 500,
        currentSign: -1,
      },
    });
    const badge = screen.getByText('flip');
    expect(badge).toHaveClass('text-rose-400');
  });

  it('renders a neutral flip badge when currentSign = 0', () => {
    renderBar({
      flip: {
        occurred: true,
        atTimestamp: '2026-04-28T18:30:00Z',
        magnitude: 0,
        currentSign: 0,
      },
    });
    const badge = screen.getByText('flip');
    expect(badge).toHaveClass('text-secondary');
  });

  it('formats null atTimestamp as em-dash in the title (fmtTime null branch)', () => {
    renderBar({
      flip: {
        occurred: true,
        atTimestamp: null,
        magnitude: 100,
        currentSign: 1,
      },
    });
    const badge = screen.getByText('flip');
    expect(badge.getAttribute('title')).toContain('at —');
  });

  it('formats invalid atTimestamp as em-dash (fmtTime NaN branch)', () => {
    renderBar({
      flip: {
        occurred: true,
        atTimestamp: 'not-a-real-iso',
        magnitude: 100,
        currentSign: 1,
      },
    });
    const badge = screen.getByText('flip');
    expect(badge.getAttribute('title')).toContain('at —');
  });
});

describe('MetricsBar — CliffBadge', () => {
  it('renders nothing when atTimestamp is null', () => {
    renderBar();
    expect(screen.queryByText('cliff')).not.toBeInTheDocument();
  });

  it('renders nothing when magnitude is exactly zero', () => {
    renderBar({
      cliff: { magnitude: 0, atTimestamp: '2026-04-28T19:30:00Z' },
    });
    expect(screen.queryByText('cliff')).not.toBeInTheDocument();
  });

  it('renders an amber cliff badge when both timestamp and magnitude are present', () => {
    renderBar({
      cliff: { magnitude: 4321, atTimestamp: '2026-04-28T19:30:00Z' },
    });
    const badge = screen.getByText('cliff');
    expect(badge).toHaveClass('text-amber-400');
    expect(badge.getAttribute('title')).toMatch(/mag 4321/);
  });
});

describe('MetricsBar — DivergenceBadge', () => {
  it('renders nothing when diverging is false', () => {
    renderBar();
    expect(screen.queryByText(/div/)).not.toBeInTheDocument();
  });

  it('renders the violet divergence badge when diverging is true', () => {
    renderBar({
      divergence: { spySign: 1, qqqSign: -1, diverging: true },
    });
    const badge = screen.getByText(/⇄ div/);
    expect(badge).toHaveClass('text-violet-400');
    expect(badge.getAttribute('title')).toMatch(/SPY and QQQ/);
  });
});

describe('MetricsBar — composite', () => {
  it('renders all four badges together when every signal fires', () => {
    renderBar({
      slope: { slope: 0.75, points: 20 },
      flip: {
        occurred: true,
        atTimestamp: '2026-04-28T19:00:00Z',
        magnitude: 222,
        currentSign: 1,
      },
      cliff: { magnitude: 3000, atTimestamp: '2026-04-28T20:00:00Z' },
      divergence: { spySign: -1, qqqSign: 1, diverging: true },
    });
    expect(screen.getByText(/↑ slope/)).toBeInTheDocument();
    expect(screen.getByText('flip')).toBeInTheDocument();
    expect(screen.getByText('cliff')).toBeInTheDocument();
    expect(screen.getByText(/⇄ div/)).toBeInTheDocument();
  });

  it('renders only the slope placeholder when nothing else fires (empty/idle session)', () => {
    const { container } = renderBar();
    // Only the SlopeBadge em-dash should be present.
    const spans = container.querySelectorAll('span');
    expect(spans).toHaveLength(1);
    expect(spans[0]?.textContent).toBe('—');
  });
});

// ── Hover text for screen readers ────────────────────────────
//
// Every badge keeps its mouse-hover `title`; a screen reader gets the same
// explanation as a hidden hint after the visible label, or, for the
// glyph-only slope placeholder, as the name of an `img`. The badges repeat in
// every chart cell, so a hint stays at or under 60 characters.

const HINT_MAX = 60;

/** The time-of-day text in a title or hint uses a narrow no-break space on
 *  newer ICU. Fold every whitespace to a plain space before comparing. */
const flat = (s: string | null): string => (s ?? '').replaceAll(/\s/g, ' ');

const FLIP_AT_1330: FlipResult = {
  occurred: true,
  atTimestamp: '2026-04-28T18:30:00Z',
  magnitude: 123_456_789,
  currentSign: 1,
};
const CLIFF_AT_1430: CliffResult = {
  magnitude: 123_456_789,
  atTimestamp: '2026-04-28T19:30:00Z',
};

describe('MetricsBar — hover text for screen readers', () => {
  it('names the slope placeholder, keeping its title', () => {
    renderBar();
    const dash = screen.getByRole('img', {
      name: 'not enough points to compute the slope',
    });
    expect(dash.textContent).toBe('—');
    expect(dash).toHaveAttribute('title', 'Insufficient points for slope');
  });

  it('shows no slope placeholder once there is a slope', () => {
    renderBar({ slope: { slope: 1.234, points: 15 } });
    expect(screen.queryByRole('img')).toBeNull();
  });

  it.each([
    [1.234, 'last 15 min: 1.23 per min', 'Slope (last 15 min): 1.23 per min'],
    [-2.5, 'last 15 min: -2.50 per min', 'Slope (last 15 min): -2.50 per min'],
    [0, 'last 15 min: 0.00 per min', 'Slope (last 15 min): 0.00 per min'],
    [
      123_456_789.5,
      'last 15 min: 123456789.50 per min',
      'Slope (last 15 min): 123456789.50 per min',
    ],
  ])('hints the slope %d', (slope, hint, title) => {
    renderBar({ slope: { slope, points: 15 } });
    const badge = screen.getByText(/slope$/);
    expect(srHintText(badge)).toBe(hint);
    expect(srHintText(badge)!.length).toBeLessThanOrEqual(HINT_MAX);
    expect(badge).toHaveAttribute('title', title);
  });

  it('hints a flip with its time and a compact magnitude, keeping its title', () => {
    renderBar({ flip: FLIP_AT_1330 });
    const badge = screen.getByText('flip');
    const hint = flat(srHintText(badge));
    expect(hint).toBe(
      'sign changed within 30 min, at 1:30 PM (magnitude 123.5M)',
    );
    expect(hint.length).toBeLessThanOrEqual(HINT_MAX);
    expect(flat(badge.getAttribute('title'))).toBe(
      'Sign flip in last 30 min at 1:30 PM (mag 123456789)',
    );
  });

  it('keeps the longest flip hint within the cap', () => {
    // The widest case: a two-digit hour, a negative magnitude, and a
    // compact form with a decimal (12:59 PM CT, -999.9M). It is 59
    // characters, one under the 60-character cap.
    renderBar({
      flip: {
        ...FLIP_AT_1330,
        atTimestamp: '2026-04-28T17:59:00Z',
        magnitude: -999_900_000,
      },
    });
    const badge = screen.getByText('flip');
    const hint = flat(srHintText(badge));
    expect(hint).toBe(
      'sign changed within 30 min, at 12:59 PM (magnitude -999.9M)',
    );
    expect(hint.length).toBeLessThanOrEqual(HINT_MAX);
    expect(flat(badge.getAttribute('title'))).toBe(
      'Sign flip in last 30 min at 12:59 PM (mag -999900000)',
    );
  });

  it.each([
    ['a null time', null],
    ['an invalid time', 'not-a-real-iso'],
  ])('drops the "at" clause from a flip hint with %s', (_name, atTimestamp) => {
    renderBar({ flip: { ...FLIP_AT_1330, atTimestamp } });
    const badge = screen.getByText('flip');
    expect(srHintText(badge)).toBe(
      'sign changed within 30 min (magnitude 123.5M)',
    );
    // The title is untouched: it still shows a dash for the missing time.
    expect(badge).toHaveAttribute(
      'title',
      'Sign flip in last 30 min at — (mag 123456789)',
    );
  });

  it('hints a cliff with its time and a compact magnitude, keeping its title', () => {
    renderBar({ cliff: CLIFF_AT_1430 });
    const badge = screen.getByText('cliff');
    const hint = flat(srHintText(badge));
    expect(hint).toBe('over 10 min, at 2:30 PM (magnitude 123.5M)');
    expect(hint.length).toBeLessThanOrEqual(HINT_MAX);
    expect(flat(badge.getAttribute('title'))).toBe(
      '10-min cliff at 2:30 PM (mag 123456789)',
    );
  });

  it('drops the "at" clause from a cliff hint with an invalid time', () => {
    // The badge never renders with a null time, so only an invalid ISO
    // string reaches this branch.
    renderBar({ cliff: { ...CLIFF_AT_1430, atTimestamp: 'not-a-real-iso' } });
    const badge = screen.getByText('cliff');
    expect(srHintText(badge)).toBe('over 10 min (magnitude 123.5M)');
    // The title is untouched: it still shows a dash for the missing time.
    expect(badge).toHaveAttribute('title', '10-min cliff at — (mag 123456789)');
  });

  it('hints the divergence badge, keeping its title', () => {
    renderBar({ divergence: { spySign: 1, qqqSign: -1, diverging: true } });
    const badge = screen.getByText(/⇄ div/);
    expect(srHintText(badge)).toBe(
      'SPY and QQQ have opposite signs on this field',
    );
    expect(srHintText(badge)!.length).toBeLessThanOrEqual(HINT_MAX);
    expect(badge).toHaveAttribute(
      'title',
      'SPY and QQQ have opposite signs on this field',
    );
  });

  it('leaves no titled generic element without a hint when every badge shows', () => {
    const { container } = renderBar({
      slope: { slope: 0.75, points: 20 },
      flip: FLIP_AT_1330,
      cliff: CLIFF_AT_1430,
      divergence: { spySign: -1, qqqSign: 1, diverging: true },
    });
    // slope, flip, cliff and divergence: all four reached.
    expect(titledElementsNeedingHint(container)).toHaveLength(4);
    expect(titledGenericsWithoutHint(container)).toEqual([]);
  });

  it('leaves no titled generic element without a hint when only the placeholder shows', () => {
    const { container } = renderBar();
    // The placeholder is an `img` named by aria-label, so it needs no hint.
    expect(titledGenericsWithoutHint(container)).toEqual([]);
  });
});
