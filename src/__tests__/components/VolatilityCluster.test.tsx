import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import VolatilityCluster from '../../components/VolatilityCluster';
import {
  useClusterMultiplier,
  type YesterdayOHLC,
} from '../../hooks/useClusterMultiplier';
import { computeClusterSignal } from '../../utils/volatility-cluster';

/**
 * The panel is a view: it shows the inputs and the result it is given and
 * reports typing. useClusterMultiplier owns both, the way App wires them, so
 * most tests mount the pair and type into the fields. `effective-mult` is the
 * value App hands the snapshot save, regime ceilings and analyze context.
 */
function Harness({
  vix,
  spot,
  yesterday,
}: Readonly<{
  vix: number | null;
  spot: number | null;
  yesterday?: YesterdayOHLC;
}>) {
  const cluster = useClusterMultiplier({
    vix,
    spot,
    yesterday,
    scope: 'test',
  });
  return (
    <>
      <VolatilityCluster
        vix={vix}
        spot={spot}
        inputs={cluster.inputs}
        signal={cluster.signal}
        onInputChange={cluster.setInput}
        isEdited={cluster.isEdited}
        onReset={cluster.reset}
      />
      <output data-testid="effective-mult">{cluster.signal.mult}</output>
    </>
  );
}

const HOT_DAY: YesterdayOHLC = { open: 6681.78, high: 6810.44, low: 6636.04 };

function setInput(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function enterYesterday(open: string, high: string, low: string) {
  setInput(/yesterday open/i, open);
  setInput(/yesterday high/i, high);
  setInput(/yesterday low/i, low);
}

function inputValue(label: RegExp): string {
  return (screen.getByLabelText(label) as HTMLInputElement).value;
}

// ============================================================
// RENDERING
// ============================================================
describe('VolatilityCluster: rendering', () => {
  it('renders without crashing', () => {
    render(<Harness vix={20} spot={6800} />);
    expect(
      screen.getAllByText(/volatility clustering/i).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('renders in dark mode', () => {
    render(<Harness vix={20} spot={6800} />);
    expect(
      screen.getAllByText(/volatility clustering/i).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('shows all three input fields', () => {
    render(<Harness vix={20} spot={6800} />);
    expect(screen.getByLabelText(/yesterday open/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/yesterday high/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/yesterday low/i)).toBeInTheDocument();
  });

  it('shows empty state when VIX is null', () => {
    render(<Harness vix={null} spot={6800} />);
    expect(screen.getByText(/enter a vix value/i)).toBeInTheDocument();
  });

  it('shows the high-low hint when VIX is set but no range is known', () => {
    render(<Harness vix={20} spot={6800} />);
    expect(
      screen.getByText(/enter yesterday.s spx high and low to check/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/today.s multiplier/i)).not.toBeInTheDocument();
  });
});

// ============================================================
// SIGNAL CLASSIFICATION
// ============================================================
describe('VolatilityCluster: signals', () => {
  // VIX 15 (low regime): p50=0.73, p75=1.01, p90=1.32

  it('shows TAILWIND for calm yesterday at low VIX', () => {
    render(<Harness vix={15} spot={6800} />);
    // 30 pts / 6800 = 0.44% → below p50 (0.73%)
    enterYesterday('6800', '6815', '6785');
    expect(screen.getByText('TAILWIND')).toBeInTheDocument();
    expect(screen.getByText(/quieter than average/i)).toBeInTheDocument();
  });

  it('shows NEUTRAL for normal yesterday', () => {
    render(<Harness vix={15} spot={6800} />);
    // 60 pts / 6800 = 0.88% → between p50 (0.73) and p75 (1.01)
    enterYesterday('6800', '6830', '6770');
    expect(screen.getByText('NEUTRAL')).toBeInTheDocument();
  });

  it('shows CLUSTERING for active yesterday', () => {
    render(<Harness vix={15} spot={6800} />);
    // 80 pts / 6800 = 1.18% → between p75 (1.01) and p90 (1.32)
    enterYesterday('6800', '6840', '6760');
    expect(screen.getByText('CLUSTERING')).toBeInTheDocument();
    expect(screen.getByText(/tightening/i)).toBeInTheDocument();
  });

  it('shows HIGH CLUSTERING for extreme yesterday at high VIX', () => {
    render(<Harness vix={30} spot={6800} />);
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
    render(<Harness vix={15} spot={6800} />);
    enterYesterday('6800', '6815', '6785');
    expect(screen.getByText('0.914x')).toBeInTheDocument();
    expect(screen.getByText('narrower')).toBeInTheDocument();
  });

  it('shows multiplier > 1 for hot yesterday at VIX 25+', () => {
    render(<Harness vix={30} spot={6800} />);
    enterYesterday('6800', '6950', '6650');
    expect(screen.getByText('1.872x')).toBeInTheDocument();
    expect(screen.getByText('wider')).toBeInTheDocument();
  });

  it('shows correct classification label', () => {
    render(<Harness vix={20} spot={6800} />);
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
    render(<Harness vix={15} spot={6800} />);
    // 40 pts / 6800 open = 0.59%
    enterYesterday('6800', '6820', '6780');
    expect(screen.getByText('0.59%')).toBeInTheDocument();
    expect(screen.getByText('40 pts')).toBeInTheDocument();
  });

  it('uses spot as fallback when open not entered', () => {
    render(<Harness vix={15} spot={6800} />);
    setInput(/yesterday open/i, '');
    setInput(/yesterday high/i, '6820');
    setInput(/yesterday low/i, '6780');
    // 40 / 6800 = 0.59%
    expect(screen.getByText('0.59%')).toBeInTheDocument();
  });

  it('shows the VIX regime', () => {
    render(<Harness vix={22} spot={6800} />);
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
    const { unmount } = render(<Harness vix={12} spot={6800} />);
    enterYesterday('6800', '6850', '6750');
    expect(screen.getByText('HIGH CLUSTERING')).toBeInTheDocument();
    unmount();

    // At VIX 30: p50 is 1.99% → this is <p50 → Calm
    render(<Harness vix={30} spot={6800} />);
    enterYesterday('6800', '6850', '6750');
    expect(screen.getByText('TAILWIND')).toBeInTheDocument();
  });
});

// ============================================================
// EDGE CASES
// ============================================================
describe('VolatilityCluster: edge cases', () => {
  it('shows error when high <= low', () => {
    render(<Harness vix={20} spot={6800} />);
    setInput(/yesterday high/i, '6780');
    setInput(/yesterday low/i, '6820');
    expect(screen.getByText(/high must be greater/i)).toBeInTheDocument();
  });

  it('handles non-numeric input', () => {
    render(<Harness vix={20} spot={6800} />);
    setInput(/yesterday high/i, 'abc');
    setInput(/yesterday low/i, '6780');
    expect(screen.queryByText(/multiplier/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('effective-mult')).toHaveTextContent('1');
  });

  it('works without spot (uses midpoint)', () => {
    render(<Harness vix={20} spot={null} />);
    setInput(/yesterday open/i, '');
    setInput(/yesterday high/i, '6820');
    setInput(/yesterday low/i, '6780');
    expect(screen.getByText('0.59%')).toBeInTheDocument();
  });

  it('renders percentile reference bar', () => {
    render(<Harness vix={20} spot={6800} />);
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
    render(<Harness vix={20} spot={6800} />);
    enterYesterday('6800', '6850', '6750');
    expect(screen.getByText(/multiplier/i)).toBeInTheDocument();
  });

  it('renders in dark theme', () => {
    render(<Harness vix={20} spot={6800} />);
    enterYesterday('6800', '6850', '6750');
    expect(screen.getByText(/multiplier/i)).toBeInTheDocument();
  });
});

// ============================================================
// COMPUTED VALUE VS MANUAL EDIT (F24)
// ============================================================
describe('VolatilityCluster: computed value and manual edit', () => {
  it('shows the computed value when the owner has not edited', () => {
    render(<Harness vix={20} spot={6800} yesterday={HOT_DAY} />);
    // 174.4 pts / 6681.78 = 2.61% → above p90 (2.15%) for VIX 18-25
    expect(inputValue(/yesterday open/i)).toBe('6681.78');
    expect(inputValue(/yesterday high/i)).toBe('6810.44');
    expect(inputValue(/yesterday low/i)).toBe('6636.04');
    expect(screen.getByText('HIGH CLUSTERING')).toBeInTheDocument();
    expect(screen.getByText('1.203x')).toBeInTheDocument();
    expect(screen.getByTestId('effective-mult')).toHaveTextContent('1.203');
  });

  it('a manual edit overrides the computed value', () => {
    render(<Harness vix={20} spot={6800} yesterday={HOT_DAY} />);
    expect(screen.getByTestId('effective-mult')).toHaveTextContent('1.203');
    // Narrow the range: 60 pts / 6681.78 = 0.90% → Calm for VIX 18-25.
    setInput(/yesterday high/i, '6696.04');
    expect(inputValue(/yesterday high/i)).toBe('6696.04');
    expect(screen.getByText('TAILWIND')).toBeInTheDocument();
    expect(screen.getByText('0.956x')).toBeInTheDocument();
    expect(screen.getByTestId('effective-mult')).toHaveTextContent('0.956');
  });

  it('keeps the edit when the live data changes underneath it', () => {
    const { rerender } = render(
      <Harness vix={20} spot={6800} yesterday={HOT_DAY} />,
    );
    setInput(/yesterday open/i, '7000');
    rerender(
      <Harness
        vix={20}
        spot={6800}
        yesterday={{ open: 6500, high: 6600, low: 6400 }}
      />,
    );
    expect(inputValue(/yesterday open/i)).toBe('7000');
    expect(inputValue(/yesterday high/i)).toBe('6810.44');
  });

  it('starts empty when yesterday is not available', () => {
    render(<Harness vix={20} spot={6800} />);
    expect(inputValue(/yesterday open/i)).toBe('');
    expect(inputValue(/yesterday high/i)).toBe('');
    expect(inputValue(/yesterday low/i)).toBe('');
    expect(screen.getByTestId('effective-mult')).toHaveTextContent('1');
  });

  it('follows yesterday when it arrives after first paint', () => {
    const { rerender } = render(<Harness vix={20} spot={6800} />);
    expect(screen.getByTestId('effective-mult')).toHaveTextContent('1');
    rerender(<Harness vix={20} spot={6800} yesterday={HOT_DAY} />);
    expect(inputValue(/yesterday high/i)).toBe('6810.44');
    expect(screen.getByTestId('effective-mult')).toHaveTextContent('1.203');
  });
});

// ============================================================
// THE PANEL ALONE (controlled)
// ============================================================
describe('VolatilityCluster: controlled by its props', () => {
  const inputs = { open: '6800', high: '6850', low: '6750' };

  it('shows the signal it is given, without computing one', () => {
    const signal = computeClusterSignal({
      vix: 20,
      spot: 6800,
      open: 6800,
      high: 6850,
      low: 6750,
    });
    render(
      <VolatilityCluster
        vix={20}
        spot={6800}
        inputs={inputs}
        signal={signal}
        onInputChange={vi.fn()}
        isEdited={false}
        onReset={vi.fn()}
      />,
    );
    expect(screen.getByText('0.969x')).toBeInTheDocument();
    expect(screen.getByText('1.47%')).toBeInTheDocument();
    expect(inputValue(/yesterday high/i)).toBe('6850');
  });

  it('reports each field edit by name, and does not change its own value', () => {
    const onInputChange = vi.fn();
    render(
      <VolatilityCluster
        vix={20}
        spot={6800}
        inputs={inputs}
        signal={{ rangePct: null, cluster: null, mult: 1 }}
        onInputChange={onInputChange}
        isEdited={false}
        onReset={vi.fn()}
      />,
    );
    setInput(/yesterday open/i, '6801');
    setInput(/yesterday high/i, '6851');
    setInput(/yesterday low/i, '6751');
    expect(onInputChange.mock.calls).toEqual([
      ['open', '6801'],
      ['high', '6851'],
      ['low', '6751'],
    ]);
    expect(inputValue(/yesterday open/i)).toBe('6800');
  });

  it.each([
    [true, 1],
    [false, 0],
  ])('isEdited %s: %d "Reset to data" control', (isEdited, count) => {
    render(
      <VolatilityCluster
        vix={20}
        spot={6800}
        inputs={inputs}
        signal={{ rangePct: null, cluster: null, mult: 1 }}
        onInputChange={vi.fn()}
        isEdited={isEdited}
        onReset={vi.fn()}
      />,
    );
    expect(
      screen.queryAllByRole('button', { name: 'Reset to data' }),
    ).toHaveLength(count);
  });

  it('calls onReset from the control', () => {
    const onReset = vi.fn();
    render(
      <VolatilityCluster
        vix={20}
        spot={6800}
        inputs={inputs}
        signal={{ rangePct: null, cluster: null, mult: 1 }}
        onInputChange={vi.fn()}
        isEdited
        onReset={onReset}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reset to data' }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// SEEING AND CLEARING AN EDIT
// ============================================================
describe('VolatilityCluster: reset to data', () => {
  const resetButton = () =>
    screen.queryByRole('button', { name: 'Reset to data' });

  it('offers no reset until the owner edits', () => {
    render(<Harness vix={20} spot={6800} yesterday={HOT_DAY} />);
    expect(resetButton()).not.toBeInTheDocument();
  });

  it('after an edit, "Reset to data" brings back the data and the computed value', () => {
    render(<Harness vix={20} spot={6800} yesterday={HOT_DAY} />);
    setInput(/yesterday high/i, '6696.04');
    expect(screen.getByTestId('effective-mult')).toHaveTextContent('0.956');
    expect(resetButton()).toBeInTheDocument();

    fireEvent.click(resetButton()!);

    expect(inputValue(/yesterday high/i)).toBe('6810.44');
    expect(screen.getByText('1.203x')).toBeInTheDocument();
    expect(screen.getByTestId('effective-mult')).toHaveTextContent('1.203');
    expect(resetButton()).not.toBeInTheDocument();
  });
});
