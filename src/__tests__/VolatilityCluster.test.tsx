import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import VolatilityCluster from '../components/VolatilityCluster';
import { lightTheme, darkTheme } from '../themes';

function setInput(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function enterYesterday(open: string, high: string, low: string) {
  setInput(/yest\. open/i, open);
  setInput(/yest\. high/i, high);
  setInput(/yest\. low/i, low);
}

// ============================================================
// RENDERING
// ============================================================
describe('VolatilityCluster: rendering', () => {
  it('renders without crashing', () => {
    render(<VolatilityCluster th={lightTheme} vix={20} spot={6800} />);
    expect(screen.getAllByText(/volatility clustering/i).length).toBeGreaterThanOrEqual(1);
  });

  it('renders in dark mode', () => {
    render(<VolatilityCluster th={darkTheme} vix={20} spot={6800} />);
    expect(screen.getAllByText(/volatility clustering/i).length).toBeGreaterThanOrEqual(1);
  });

  it('shows all three input fields', () => {
    render(<VolatilityCluster th={lightTheme} vix={20} spot={6800} />);
    expect(screen.getByLabelText(/yest\. open/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/yest\. high/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/yest\. low/i)).toBeInTheDocument();
  });

  it('shows empty state when VIX is null', () => {
    render(<VolatilityCluster th={lightTheme} vix={null} spot={6800} />);
    expect(screen.getByText(/enter a vix value/i)).toBeInTheDocument();
  });

  it('shows hint when VIX set but no range entered', () => {
    render(<VolatilityCluster th={lightTheme} vix={20} spot={6800} />);
    expect(screen.getAllByText(/enter yesterday/i).length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================
// SIGNAL CLASSIFICATION
// ============================================================
describe('VolatilityCluster: signals', () => {
  // VIX 15 (low regime): p50=0.73, p75=1.01, p90=1.32

  it('shows TAILWIND for calm yesterday at low VIX', () => {
    render(<VolatilityCluster th={lightTheme} vix={15} spot={6800} />);
    // 30 pts / 6800 = 0.44% → below p50 (0.73%)
    enterYesterday('6800', '6815', '6785');
    expect(screen.getByText('TAILWIND')).toBeInTheDocument();
    expect(screen.getByText(/quieter than average/i)).toBeInTheDocument();
  });

  it('shows NEUTRAL for normal yesterday', () => {
    render(<VolatilityCluster th={lightTheme} vix={15} spot={6800} />);
    // 60 pts / 6800 = 0.88% → between p50 (0.73) and p75 (1.01)
    enterYesterday('6800', '6830', '6770');
    expect(screen.getByText('NEUTRAL')).toBeInTheDocument();
  });

  it('shows CLUSTERING for active yesterday', () => {
    render(<VolatilityCluster th={lightTheme} vix={15} spot={6800} />);
    // 80 pts / 6800 = 1.18% → between p75 (1.01) and p90 (1.32)
    enterYesterday('6800', '6840', '6760');
    expect(screen.getByText('CLUSTERING')).toBeInTheDocument();
    expect(screen.getByText(/tightening/i)).toBeInTheDocument();
  });

  it('shows HIGH CLUSTERING for extreme yesterday at high VIX', () => {
    render(<VolatilityCluster th={lightTheme} vix={30} spot={6800} />);
    // 300 pts / 6800 = 4.41% → above p90 (3.78%)
    enterYesterday('6800', '6950', '6650');
    expect(screen.getByText('HIGH CLUSTERING')).toBeInTheDocument();
    expect(screen.getByText(/widen significantly/i)).toBeInTheDocument();
  });
});

// ============================================================
// MULTIPLIER VALUES
// ============================================================
describe('VolatilityCluster: multipliers', () => {
  it('shows multiplier < 1 for calm yesterday', () => {
    render(<VolatilityCluster th={lightTheme} vix={15} spot={6800} />);
    enterYesterday('6800', '6815', '6785');
    expect(screen.getByText('0.914x')).toBeInTheDocument();
    expect(screen.getByText('narrower')).toBeInTheDocument();
  });

  it('shows multiplier > 1 for hot yesterday at VIX 25+', () => {
    render(<VolatilityCluster th={lightTheme} vix={30} spot={6800} />);
    enterYesterday('6800', '6950', '6650');
    expect(screen.getByText('1.872x')).toBeInTheDocument();
    expect(screen.getByText('wider')).toBeInTheDocument();
  });

  it('shows correct classification label', () => {
    render(<VolatilityCluster th={lightTheme} vix={20} spot={6800} />);
    // 100 pts / 6800 = 1.47% → between p50 (1.24) and p75 (1.64) for mid VIX
    enterYesterday('6800', '6850', '6750');
    expect(screen.getByText(/Normal \(p50/)).toBeInTheDocument();
  });
});

// ============================================================
// RANGE COMPUTATION
// ============================================================
describe('VolatilityCluster: range computation', () => {
  it('computes range % from open price', () => {
    render(<VolatilityCluster th={lightTheme} vix={15} spot={6800} />);
    // 40 pts / 6800 open = 0.59%
    enterYesterday('6800', '6820', '6780');
    expect(screen.getByText('0.59%')).toBeInTheDocument();
    expect(screen.getByText('40 pts')).toBeInTheDocument();
  });

  it('uses spot as fallback when open not entered', () => {
    render(<VolatilityCluster th={lightTheme} vix={15} spot={6800} />);
    setInput(/yest\. high/i, '6820');
    setInput(/yest\. low/i, '6780');
    // 40 / 6800 = 0.59%
    expect(screen.getByText('0.59%')).toBeInTheDocument();
  });

  it('shows the VIX regime', () => {
    render(<VolatilityCluster th={lightTheme} vix={22} spot={6800} />);
    enterYesterday('6800', '6850', '6750');
    expect(screen.getByText(/VIX 18/)).toBeInTheDocument();
  });
});

// ============================================================
// VIX SENSITIVITY
// ============================================================
describe('VolatilityCluster: VIX sensitivity', () => {
  it('same range is "hot" at low VIX but "calm" at high VIX', () => {
    // 100 pts / 6800 = 1.47%
    // At VIX 12: p90 is 1.32% → this is >p90 → Hot
    const { unmount } = render(<VolatilityCluster th={lightTheme} vix={12} spot={6800} />);
    enterYesterday('6800', '6850', '6750');
    expect(screen.getByText('HIGH CLUSTERING')).toBeInTheDocument();
    unmount();

    // At VIX 30: p50 is 1.99% → this is <p50 → Calm
    render(<VolatilityCluster th={lightTheme} vix={30} spot={6800} />);
    enterYesterday('6800', '6850', '6750');
    expect(screen.getByText('TAILWIND')).toBeInTheDocument();
  });
});

// ============================================================
// EDGE CASES
// ============================================================
describe('VolatilityCluster: edge cases', () => {
  it('shows error when high <= low', () => {
    render(<VolatilityCluster th={lightTheme} vix={20} spot={6800} />);
    setInput(/yest\. high/i, '6780');
    setInput(/yest\. low/i, '6820');
    expect(screen.getByText(/high must be greater/i)).toBeInTheDocument();
  });

  it('handles non-numeric input', () => {
    render(<VolatilityCluster th={lightTheme} vix={20} spot={6800} />);
    setInput(/yest\. high/i, 'abc');
    setInput(/yest\. low/i, '6780');
    expect(screen.queryByText(/multiplier/i)).not.toBeInTheDocument();
  });

  it('works without spot (uses midpoint)', () => {
    render(<VolatilityCluster th={lightTheme} vix={20} spot={null} />);
    setInput(/yest\. high/i, '6820');
    setInput(/yest\. low/i, '6780');
    expect(screen.getByText('0.59%')).toBeInTheDocument();
  });

  it('renders percentile reference bar', () => {
    render(<VolatilityCluster th={lightTheme} vix={20} spot={6800} />);
    enterYesterday('6800', '6850', '6750');
    expect(screen.getAllByText(/p50/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/p75/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/p90/).length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================
// THEME SUPPORT
// ============================================================
describe('VolatilityCluster: theme support', () => {
  it('renders in light theme', () => {
    render(<VolatilityCluster th={lightTheme} vix={20} spot={6800} />);
    enterYesterday('6800', '6850', '6750');
    expect(screen.getByText(/multiplier/i)).toBeInTheDocument();
  });

  it('renders in dark theme', () => {
    render(<VolatilityCluster th={darkTheme} vix={20} spot={6800} />);
    enterYesterday('6800', '6850', '6750');
    expect(screen.getByText(/multiplier/i)).toBeInTheDocument();
  });
});

// ============================================================
// CALLBACK
// ============================================================
describe('VolatilityCluster: onMultiplierChange callback', () => {
  it('calls onMultiplierChange when range is entered', () => {
    const onMult = vi.fn();
    render(<VolatilityCluster th={lightTheme} vix={20} spot={6800} onMultiplierChange={onMult} />);
    enterYesterday('6800', '6850', '6750');
    expect(onMult).toHaveBeenCalled();
    const lastCall = onMult.mock.calls.at(-1)![0];
    expect(lastCall).toBeGreaterThan(0);
  });

  it('calls with 1.0 when no data entered', () => {
    const onMult = vi.fn();
    render(<VolatilityCluster th={lightTheme} vix={20} spot={6800} onMultiplierChange={onMult} />);
    // Initial render calls with 1 (no data)
    expect(onMult).toHaveBeenCalledWith(1);
  });
});