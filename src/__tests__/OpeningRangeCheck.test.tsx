import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import OpeningRangeCheck from '../components/OpeningRangeCheck';
import { lightTheme, darkTheme } from '../themes';

function setInput(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function enterRange(high: string, low: string) {
  setInput(/30-min high/i, high);
  setInput(/30-min low/i, low);
}

// ============================================================
// RENDERING
// ============================================================
describe('OpeningRangeCheck: rendering', () => {
  it('renders without crashing', () => {
    render(<OpeningRangeCheck th={lightTheme} vix={20} spot={6800} />);
    expect(screen.getByText(/opening range check/i)).toBeInTheDocument();
  });

  it('renders in dark mode', () => {
    render(<OpeningRangeCheck th={darkTheme} vix={20} spot={6800} />);
    expect(screen.getByText(/opening range check/i)).toBeInTheDocument();
  });

  it('shows both input fields', () => {
    render(<OpeningRangeCheck th={lightTheme} vix={20} spot={6800} />);
    expect(screen.getByLabelText(/30-min high/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/30-min low/i)).toBeInTheDocument();
  });

  it('shows empty state when VIX is null', () => {
    render(<OpeningRangeCheck th={lightTheme} vix={null} spot={6800} />);
    expect(screen.getByText(/enter a vix value/i)).toBeInTheDocument();
  });

  it('shows analysis from seeded defaults when VIX is set', () => {
    render(<OpeningRangeCheck th={lightTheme} vix={20} spot={6800} />);
    // Defaults (5735/5705) produce an analysis immediately
    expect(screen.getByText('RANGE INTACT')).toBeInTheDocument();
  });
});

// ============================================================
// SIGNAL CLASSIFICATION
// ============================================================
describe('OpeningRangeCheck: signals', () => {
  // VIX 20 → expected median H-L ~1.25%, p90 ~2.05%
  // Small range: 6810 - 6790 = 20 pts = 0.29% → well under 40% of 1.25%
  it('shows GREEN signal for small opening range', () => {
    render(<OpeningRangeCheck th={lightTheme} vix={20} spot={6800} />);
    enterRange('6810', '6790');
    expect(screen.getByText('RANGE INTACT')).toBeInTheDocument();
    expect(screen.getByText(/good conditions to add/i)).toBeInTheDocument();
  });

  // Medium range: 6840 - 6770 = 70 pts = 1.03% → ~82% of 1.25% median
  it('shows RED signal for large opening range', () => {
    render(<OpeningRangeCheck th={lightTheme} vix={20} spot={6800} />);
    enterRange('6840', '6770');
    expect(screen.getByText('RANGE EXHAUSTED')).toBeInTheDocument();
    expect(screen.getByText(/already running hot/i)).toBeInTheDocument();
  });

  // Moderate range: 6830 - 6790 = 40 pts = 0.59% → ~47% of 1.25%
  it('shows YELLOW signal for moderate opening range', () => {
    render(<OpeningRangeCheck th={lightTheme} vix={20} spot={6800} />);
    enterRange('6830', '6790');
    expect(screen.getByText('MODERATE')).toBeInTheDocument();
    expect(
      screen.getAllByText(/tighter deltas/i).length,
    ).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================
// STATISTICS DISPLAY
// ============================================================
describe('OpeningRangeCheck: stats', () => {
  it('shows opening range percentage', () => {
    render(<OpeningRangeCheck th={lightTheme} vix={20} spot={6800} />);
    enterRange('6820', '6780');
    // 40 / 6800 * 100 = 0.59%
    expect(screen.getByText('0.59%')).toBeInTheDocument();
  });

  it('shows opening range in points', () => {
    render(<OpeningRangeCheck th={lightTheme} vix={20} spot={6800} />);
    enterRange('6820', '6780');
    expect(screen.getByText('40 pts')).toBeInTheDocument();
  });

  it('shows expected median H-L', () => {
    render(<OpeningRangeCheck th={lightTheme} vix={20} spot={6800} />);
    enterRange('6820', '6780');
    expect(screen.getByText(/expected median/i)).toBeInTheDocument();
    expect(screen.getByText(/50th pctile/i)).toBeInTheDocument();
  });

  it('shows expected 90th H-L', () => {
    render(<OpeningRangeCheck th={lightTheme} vix={20} spot={6800} />);
    enterRange('6820', '6780');
    expect(screen.getByText(/expected 90th/i)).toBeInTheDocument();
    expect(screen.getAllByText(/90th pctile/i).length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it('shows percentage consumed bars', () => {
    render(<OpeningRangeCheck th={lightTheme} vix={20} spot={6800} />);
    enterRange('6820', '6780');
    expect(screen.getByText(/vs\. median h-l/i)).toBeInTheDocument();
    expect(screen.getByText(/vs\. 90th pctile h-l/i)).toBeInTheDocument();
    expect(screen.getAllByText(/consumed/i).length).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================
// VIX SENSITIVITY
// ============================================================
describe('OpeningRangeCheck: VIX sensitivity', () => {
  it('same range at low VIX consumes more of expected range', () => {
    // VIX 12 → median H-L ~0.62% ; 40 pts / 6800 = 0.59% → 95% consumed
    render(<OpeningRangeCheck th={lightTheme} vix={12} spot={6800} />);
    enterRange('6820', '6780');
    expect(screen.getByText('RANGE EXHAUSTED')).toBeInTheDocument();
  });

  it('same range at high VIX consumes less of expected range', () => {
    // VIX 30 → median H-L ~1.88% ; 40 pts / 6800 = 0.59% → 31% consumed
    render(<OpeningRangeCheck th={lightTheme} vix={30} spot={6800} />);
    enterRange('6820', '6780');
    expect(screen.getByText('RANGE INTACT')).toBeInTheDocument();
  });
});

// ============================================================
// EDGE CASES
// ============================================================
describe('OpeningRangeCheck: edge cases', () => {
  it('shows error when high <= low', () => {
    render(<OpeningRangeCheck th={lightTheme} vix={20} spot={6800} />);
    enterRange('6780', '6820');
    expect(screen.getByText(/high must be greater/i)).toBeInTheDocument();
  });

  it('handles non-numeric input gracefully', () => {
    render(<OpeningRangeCheck th={lightTheme} vix={20} spot={6800} />);
    enterRange('abc', '6780');
    // Should not crash or show analysis
    expect(screen.queryByText(/% consumed/i)).not.toBeInTheDocument();
  });

  it('works without spot (uses midpoint)', () => {
    render(<OpeningRangeCheck th={lightTheme} vix={20} spot={null} />);
    enterRange('6820', '6780');
    // Should still compute using midpoint (6800)
    expect(screen.getByText('0.59%')).toBeInTheDocument();
  });

  it('works with very tight range', () => {
    render(<OpeningRangeCheck th={lightTheme} vix={20} spot={6800} />);
    enterRange('6801', '6800');
    expect(screen.getByText('RANGE INTACT')).toBeInTheDocument();
  });

  it('works with very wide range', () => {
    render(<OpeningRangeCheck th={lightTheme} vix={15} spot={6800} />);
    enterRange('6900', '6700');
    // 200/6800 = 2.94% → way past median
    expect(screen.getByText('RANGE EXHAUSTED')).toBeInTheDocument();
  });
});

// ============================================================
// DOW ADJUSTMENT
// ============================================================
describe('OpeningRangeCheck: DOW adjustment', () => {
  it('applies DOW multiplier from selectedDate', () => {
    // Monday (quieter) vs Thursday (wider) at same VIX should change the expected range
    const { unmount } = render(
      <OpeningRangeCheck
        th={lightTheme}
        vix={20}
        spot={6800}
        selectedDate="2026-03-09"
      />,
    );
    enterRange('6820', '6780');
    const monText =
      screen.getByText(/vs\. median h-l/i).closest('div')?.parentElement
        ?.textContent ?? '';
    unmount();

    render(
      <OpeningRangeCheck
        th={lightTheme}
        vix={20}
        spot={6800}
        selectedDate="2026-03-12"
      />,
    );
    enterRange('6820', '6780');
    const thuText =
      screen.getByText(/vs\. median h-l/i).closest('div')?.parentElement
        ?.textContent ?? '';

    // Monday expected median is lower, so same range consumes more → different %
    expect(monText).not.toBe(thuText);
  });
});

// ============================================================
// THEME SUPPORT
// ============================================================
describe('OpeningRangeCheck: theme support', () => {
  it('renders analysis in light theme', () => {
    render(<OpeningRangeCheck th={lightTheme} vix={20} spot={6800} />);
    enterRange('6820', '6780');
    expect(screen.getAllByText(/% consumed/i).length).toBeGreaterThanOrEqual(1);
  });

  it('renders analysis in dark theme', () => {
    render(<OpeningRangeCheck th={darkTheme} vix={20} spot={6800} />);
    enterRange('6820', '6780');
    expect(screen.getAllByText(/% consumed/i).length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================
// AUTO-FILL FROM LIVE DATA
// ============================================================
describe('OpeningRangeCheck: auto-fill from live data', () => {
  it('auto-fills range when initialRange is provided', () => {
    render(
      <OpeningRangeCheck
        th={lightTheme}
        vix={20}
        spot={6800}
        initialRange={{ high: 6798.96, low: 6762.05 }}
      />,
    );
    const highInput = screen.getByLabelText(/30-min high/i) as HTMLInputElement;
    const lowInput = screen.getByLabelText(/30-min low/i) as HTMLInputElement;
    expect(highInput.value).toBe('6798.96');
    expect(lowInput.value).toBe('6762.05');
  });

  it('shows signal when auto-filled', () => {
    render(
      <OpeningRangeCheck
        th={lightTheme}
        vix={20}
        spot={6800}
        initialRange={{ high: 6820, low: 6790 }}
      />,
    );
    // 30 pts / 6800 = 0.44% → well under 40% of ~1.25% median → RANGE INTACT
    expect(screen.getByText('RANGE INTACT')).toBeInTheDocument();
  });

  it('does not overwrite user input with initialRange', () => {
    render(
      <OpeningRangeCheck
        th={lightTheme}
        vix={20}
        spot={6800}
        initialRange={{ high: 6820, low: 6790 }}
      />,
    );
    const highInput = screen.getByLabelText(/30-min high/i) as HTMLInputElement;
    // User types a different value
    fireEvent.change(highInput, { target: { value: '6850' } });
    expect(highInput.value).toBe('6850');
  });

  it('shows seeded defaults when no initialRange provided', () => {
    render(<OpeningRangeCheck th={lightTheme} vix={20} spot={6800} />);
    const highInput = screen.getByLabelText(/30-min high/i) as HTMLInputElement;
    const lowInput = screen.getByLabelText(/30-min low/i) as HTMLInputElement;
    expect(highInput.value).toBe('5735');
    expect(lowInput.value).toBe('5705');
  });

  it('auto-fill triggers analysis display', () => {
    render(
      <OpeningRangeCheck
        th={lightTheme}
        vix={20}
        spot={6800}
        initialRange={{ high: 6840, low: 6770 }}
      />,
    );
    // 70 pts / 6800 = 1.03% → >65% of ~1.25% median → RANGE EXHAUSTED
    expect(screen.getByText('RANGE EXHAUSTED')).toBeInTheDocument();
    expect(screen.getAllByText(/consumed/i).length).toBeGreaterThanOrEqual(1);
  });
});
