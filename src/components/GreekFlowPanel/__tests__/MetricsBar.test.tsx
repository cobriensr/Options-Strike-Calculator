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

const noFlip: FlipResult = {
  occurred: false,
  atTimestamp: null,
  magnitude: 0,
  currentSign: 0,
};
const noCliff: CliffResult = { magnitude: 0, atTimestamp: null };
const noDiv: DivergenceResult = { spySign: 0, qqqSign: 0, diverging: false };

function renderBar(overrides: {
  slope?: SlopeResult;
  flip?: FlipResult;
  cliff?: CliffResult;
  divergence?: DivergenceResult;
} = {}) {
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
