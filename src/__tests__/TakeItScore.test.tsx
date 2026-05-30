import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TakeItScore } from '../components/TakeItScore/TakeItScore';
import { takeitProbClass } from '../components/TakeItScore/takeit-prob-class';

describe('takeitProbClass', () => {
  it('maps the spec-resolved decision #6 colour bands', () => {
    // < 0.40 red
    expect(takeitProbClass(0.1)).toContain('rose');
    expect(takeitProbClass(0.39)).toContain('rose');
    // 0.40–0.55 amber
    expect(takeitProbClass(0.4)).toContain('amber');
    expect(takeitProbClass(0.54)).toContain('amber');
    // 0.55–0.70 green
    expect(takeitProbClass(0.55)).toContain('green');
    expect(takeitProbClass(0.69)).toContain('green');
    // > 0.70 deep green (emerald)
    expect(takeitProbClass(0.7)).toContain('emerald');
    expect(takeitProbClass(0.95)).toContain('emerald');
  });

  it('returns neutral when prob is null/undefined', () => {
    expect(takeitProbClass(null)).toContain('neutral');
    expect(takeitProbClass(undefined)).toContain('neutral');
  });

  it('returns neutral when prob is NaN (defense-in-depth)', () => {
    expect(takeitProbClass(Number.NaN)).toContain('neutral');
    expect(takeitProbClass(Number.NaN)).not.toMatch(/rose|red/);
  });
});

describe('<TakeItScore>', () => {
  it('renders the chip with formatted prob when one is provided', () => {
    render(<TakeItScore prob={0.62} topFeatures={null} />);
    const chip = screen.getByTestId('takeit-score-chip');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent('0.62');
    expect(chip.className).toContain('green');
  });

  it('renders "—" when prob is null', () => {
    // Provide a non-null topFeatures so the component still renders.
    render(
      <TakeItScore prob={null} topFeatures={{ positive: [], negative: [] }} />,
    );
    const chip = screen.getByTestId('takeit-score-chip');
    expect(chip).toHaveTextContent('—');
    expect(chip.className).toContain('neutral');
  });

  it('uses the neutral color class when prob is NaN (defense-in-depth)', () => {
    render(
      <TakeItScore
        prob={Number.NaN}
        topFeatures={{ positive: [], negative: [] }}
      />,
    );
    const chip = screen.getByTestId('takeit-score-chip');
    // The chip's class string should NOT include rose/red (the < 0.40 band's color)
    expect(chip.className).not.toMatch(/rose|red/);
    expect(chip.className).toContain('neutral');
  });

  it('hides entirely when both prob and topFeatures are null', () => {
    const { container } = render(
      <TakeItScore prob={null} topFeatures={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows "flags…" indicator when prob set but topFeatures still NULL', () => {
    render(<TakeItScore prob={0.55} topFeatures={null} />);
    expect(screen.getByText('flags…')).toBeInTheDocument();
  });

  it('does NOT show "flags…" when topFeatures is populated', () => {
    render(
      <TakeItScore prob={0.55} topFeatures={{ positive: [], negative: [] }} />,
    );
    expect(screen.queryByText('flags…')).not.toBeInTheDocument();
  });

  it('renders top-3 positive + top-3 negative flag chips when expanded', () => {
    render(
      <TakeItScore
        prob={0.68}
        expanded
        topFeatures={{
          positive: [
            { name: 'session_phase', shap_value: 0.31, feature_value: 2 },
            { name: 'reload_tagged', shap_value: 0.18, feature_value: true },
            {
              name: 'mode_A_intraday_0DTE',
              shap_value: 0.09,
              feature_value: 1,
            },
          ],
          negative: [
            { name: 'is_itm_at_fire', shap_value: -0.24, feature_value: 1 },
            {
              name: 'aggressive_premium_flag',
              shap_value: -0.08,
              feature_value: 1,
            },
          ],
        }}
      />,
    );
    // Trader-friendly labels:
    expect(screen.getByText('Time of day')).toBeInTheDocument();
    expect(screen.getByText('Reload')).toBeInTheDocument();
    expect(screen.getByText('ITM at fire')).toBeInTheDocument();
    expect(screen.getByText('Aggressive premium')).toBeInTheDocument();
    // The mode_ prefix is stripped:
    expect(screen.getByText(/A intraday 0DTE/i)).toBeInTheDocument();
  });

  it('caps flag chips at 3 positive + 3 negative even when more provided', () => {
    const positives = Array.from({ length: 10 }, (_, i) => ({
      name: `pos_${i}`,
      shap_value: 0.1 - i * 0.01,
      feature_value: i,
    }));
    const negatives = Array.from({ length: 10 }, (_, i) => ({
      name: `neg_${i}`,
      shap_value: -0.1 + i * 0.01,
      feature_value: i,
    }));
    render(
      <TakeItScore
        prob={0.6}
        expanded
        topFeatures={{ positive: positives, negative: negatives }}
      />,
    );
    // slice(0, 3) on each side — pos_0..pos_2 + neg_0..neg_2 only.
    expect(screen.getByText('pos_0')).toBeInTheDocument();
    expect(screen.getByText('pos_2')).toBeInTheDocument();
    expect(screen.queryByText('pos_3')).not.toBeInTheDocument();
    expect(screen.getByText('neg_0')).toBeInTheDocument();
    expect(screen.getByText('neg_2')).toBeInTheDocument();
    expect(screen.queryByText('neg_3')).not.toBeInTheDocument();
  });

  it('does not render flag chips when expanded is false (default)', () => {
    render(
      <TakeItScore
        prob={0.6}
        topFeatures={{
          positive: [
            { name: 'session_phase', shap_value: 0.3, feature_value: 2 },
          ],
          negative: [],
        }}
      />,
    );
    expect(screen.queryByText('Time of day')).not.toBeInTheDocument();
  });

  it('gracefully handles malformed topFeatures blob (missing arrays)', () => {
    render(
      <TakeItScore prob={0.6} expanded topFeatures={{ unexpected: 'shape' }} />,
    );
    // Just the chip — no crash, no flag rendering.
    expect(screen.getByTestId('takeit-score-chip')).toHaveTextContent('0.60');
  });

  describe('chain peak marker (lottery-no-vanish-2026-05-29)', () => {
    it('shows the peak marker when the chain peaked above the latest fire', () => {
      // Latest fire cooled to 0.62 but the chain hit 0.78 earlier — the
      // feed keeps the chain visible on its peak, so the row explains why.
      render(
        <TakeItScore
          prob={0.62}
          topFeatures={null}
          peakProb={0.78}
          peakAt="2026-05-29T14:28:00Z"
        />,
      );
      const marker = screen.getByTestId('takeit-peak-marker');
      expect(marker).toHaveTextContent('peak 0.78');
      // 14:28 UTC → 09:28 CT
      expect(marker).toHaveTextContent('09:28');
    });

    it('hides the marker when the latest fire IS the peak (single-fire / still hot)', () => {
      render(<TakeItScore prob={0.78} topFeatures={null} peakProb={0.78} />);
      expect(
        screen.queryByTestId('takeit-peak-marker'),
      ).not.toBeInTheDocument();
    });

    it('hides the marker when peak rounds equal to the latest (sub-0.01 gap)', () => {
      render(<TakeItScore prob={0.78} topFeatures={null} peakProb={0.782} />);
      expect(
        screen.queryByTestId('takeit-peak-marker'),
      ).not.toBeInTheDocument();
    });

    it('shows the chain peak even when the latest fire prob AND flags are null (real bundle-unreachable shape)', () => {
      // The production shape of a fire whose model bundle was unreachable
      // at detect time: takeitProb null AND takeitTopFeatures null. The
      // chain is still on the feed because an EARLIER fire peaked at 0.71,
      // so the tile must render the peak marker rather than suppress
      // itself via the empty-state early return.
      render(
        <TakeItScore
          prob={null}
          topFeatures={null}
          peakProb={0.71}
          peakAt="2026-05-29T13:30:00Z"
        />,
      );
      expect(screen.getByTestId('takeit-peak-marker')).toHaveTextContent(
        'peak 0.71',
      );
    });

    it('still hides the whole tile when prob, flags, AND peak are all absent', () => {
      const { container } = render(
        <TakeItScore prob={null} topFeatures={null} peakProb={null} />,
      );
      expect(container).toBeEmptyDOMElement();
    });

    it('omits the timestamp gracefully when peakAt is missing', () => {
      render(<TakeItScore prob={0.5} topFeatures={null} peakProb={0.72} />);
      const marker = screen.getByTestId('takeit-peak-marker');
      expect(marker).toHaveTextContent('peak 0.72');
      expect(marker).not.toHaveTextContent('@');
    });
  });

  describe('tooltip plain-language copy', () => {
    it('uses plain-language tooltip for a scored chip', () => {
      render(<TakeItScore prob={0.78} topFeatures={null} />);
      const title = screen
        .getByTestId('takeit-score-chip')
        .getAttribute('title');
      expect(title).toContain('reaches at least +20%');
    });

    it('uses plain-language null-state tooltip', () => {
      render(
        <TakeItScore
          prob={null}
          topFeatures={{ positive: [], negative: [] }}
        />,
      );
      const title = screen
        .getByTestId('takeit-score-chip')
        .getAttribute('title');
      expect(title).toContain('model bundle was unavailable');
    });
  });
});
