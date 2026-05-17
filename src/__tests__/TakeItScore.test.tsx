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
});
