import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import VIXRegimeCard from '../components/VIXRegimeCard';
import { lightTheme, darkTheme } from '../themes';

// ============================================================
// RENDERING: basic
// ============================================================
describe('VIXRegimeCard: rendering', () => {
  it('renders without crashing for VIX 15', () => {
    render(<VIXRegimeCard th={lightTheme} vix={15} spot={6800} />);
    expect(screen.getByText(/regime/i)).toBeInTheDocument();
  });

  it('renders without crashing for VIX 25', () => {
    render(<VIXRegimeCard th={lightTheme} vix={25} spot={6800} />);
    expect(screen.getByText(/regime/i)).toBeInTheDocument();
  });

  it('renders without crashing in dark mode', () => {
    render(<VIXRegimeCard th={darkTheme} vix={15} spot={6800} />);
    expect(screen.getByText(/regime/i)).toBeInTheDocument();
  });

  it('returns null for invalid VIX (negative)', () => {
    const { container } = render(
      <VIXRegimeCard th={lightTheme} vix={-5} spot={6800} />,
    );
    expect(container.innerHTML).toBe('');
  });
});

// ============================================================
// ZONE LABELS
// ============================================================
describe('VIXRegimeCard: zone classification', () => {
  it('shows GREEN for VIX 10', () => {
    render(<VIXRegimeCard th={lightTheme} vix={10} spot={6800} />);
    expect(screen.getByText(/green/i)).toBeInTheDocument();
  });

  it('shows GREEN for VIX 13', () => {
    render(<VIXRegimeCard th={lightTheme} vix={13} spot={6800} />);
    expect(screen.getByText(/green/i)).toBeInTheDocument();
  });

  it('shows GREEN for VIX 16', () => {
    render(<VIXRegimeCard th={lightTheme} vix={16} spot={6800} />);
    expect(screen.getByText(/green/i)).toBeInTheDocument();
  });

  it('shows CAUTION for VIX 19', () => {
    render(<VIXRegimeCard th={lightTheme} vix={19} spot={6800} />);
    expect(screen.getByText(/caution/i)).toBeInTheDocument();
  });

  it('shows CAUTION for VIX 22', () => {
    render(<VIXRegimeCard th={lightTheme} vix={22} spot={6800} />);
    expect(screen.getByText(/caution/i)).toBeInTheDocument();
  });

  it('shows ELEVATED for VIX 27', () => {
    render(<VIXRegimeCard th={lightTheme} vix={27} spot={6800} />);
    expect(screen.getByText(/elevated/i)).toBeInTheDocument();
  });

  it('shows EXTREME for VIX 35', () => {
    render(<VIXRegimeCard th={lightTheme} vix={35} spot={6800} />);
    expect(screen.getByText(/extreme/i)).toBeInTheDocument();
  });

  it('shows EXTREME for VIX 50', () => {
    render(<VIXRegimeCard th={lightTheme} vix={50} spot={6800} />);
    expect(screen.getByText(/extreme/i)).toBeInTheDocument();
  });

  it('shows EXTREME for VIX 80', () => {
    render(<VIXRegimeCard th={lightTheme} vix={80} spot={6800} />);
    expect(screen.getByText(/extreme/i)).toBeInTheDocument();
  });
});

// ============================================================
// STAT VALUES
// ============================================================
describe('VIXRegimeCard: displayed statistics', () => {
  it('shows Median Range label', () => {
    render(<VIXRegimeCard th={lightTheme} vix={15} spot={6800} />);
    expect(screen.getByText('Median Range')).toBeInTheDocument();
  });

  it('shows 90th Pctile label', () => {
    render(<VIXRegimeCard th={lightTheme} vix={15} spot={6800} />);
    expect(screen.getByText('90th Pctile')).toBeInTheDocument();
  });

  it('shows median O→C label', () => {
    render(<VIXRegimeCard th={lightTheme} vix={15} spot={6800} />);
    expect(screen.getByText(/med.*o.*c/i)).toBeInTheDocument();
  });

  it('displays percentage values with % sign', () => {
    render(<VIXRegimeCard th={lightTheme} vix={15} spot={6800} />);
    const percentElements = screen.getAllByText(/%/);
    expect(percentElements.length).toBeGreaterThanOrEqual(3);
  });

  it('displays point values for VIX 15 at SPX 6800', () => {
    render(<VIXRegimeCard th={lightTheme} vix={15} spot={6800} />);
    // There are 3 point sub-labels (median, p90, O→C)
    const ptsElements = screen.getAllByText(/pts/);
    expect(ptsElements.length).toBe(3);
  });

  it('shows historical day count', () => {
    render(<VIXRegimeCard th={lightTheme} vix={15} spot={6800} />);
    expect(screen.getByText(/historical days/i)).toBeInTheDocument();
  });

  it('shows specific day count from fine stats when available', () => {
    render(<VIXRegimeCard th={lightTheme} vix={15} spot={6800} />);
    // VIX 15 has 636 days in fine stats
    expect(screen.getByText(/636/)).toBeInTheDocument();
  });

  it('uses bucket count when fine stat is not available (VIX 50)', () => {
    render(<VIXRegimeCard th={lightTheme} vix={50} spot={6800} />);
    // VIX 40+ bucket has 221 days
    expect(screen.getByText(/221/)).toBeInTheDocument();
  });
});

// ============================================================
// ADVICE TEXT
// ============================================================
describe('VIXRegimeCard: advice text', () => {
  it('shows favorable advice for green zone', () => {
    render(<VIXRegimeCard th={lightTheme} vix={13} spot={6800} />);
    expect(screen.getByText(/favorable/i)).toBeInTheDocument();
  });

  it('shows widen advice for caution zone', () => {
    render(<VIXRegimeCard th={lightTheme} vix={22} spot={6800} />);
    expect(screen.getByText(/widen/i)).toBeInTheDocument();
  });

  it('shows sit out advice for stop zone', () => {
    render(<VIXRegimeCard th={lightTheme} vix={27} spot={6800} />);
    expect(screen.getByText(/sitting out/i)).toBeInTheDocument();
  });

  it('shows do not sell advice for danger zone', () => {
    render(<VIXRegimeCard th={lightTheme} vix={45} spot={6800} />);
    expect(screen.getByText(/do not sell/i)).toBeInTheDocument();
  });

  it('shows % days exceeding 2% range in advice', () => {
    render(<VIXRegimeCard th={lightTheme} vix={15} spot={6800} />);
    expect(screen.getByText(/exceed 2% range/)).toBeInTheDocument();
  });
});

// ============================================================
// SPOT PRICE SENSITIVITY
// ============================================================
describe('VIXRegimeCard: spot price calculations', () => {
  it('shows larger point values for higher spot prices', () => {
    const { unmount } = render(
      <VIXRegimeCard th={lightTheme} vix={20} spot={3000} />,
    );
    const container1 = document.body.innerHTML;
    unmount();

    render(<VIXRegimeCard th={lightTheme} vix={20} spot={6800} />);
    const container2 = document.body.innerHTML;

    expect(container1).not.toBe(container2);
  });

  it('does not crash with very small spot price', () => {
    render(<VIXRegimeCard th={lightTheme} vix={15} spot={100} />);
    expect(screen.getByText(/regime/i)).toBeInTheDocument();
  });

  it('does not crash with very large spot price', () => {
    render(<VIXRegimeCard th={lightTheme} vix={15} spot={10000} />);
    expect(screen.getByText(/regime/i)).toBeInTheDocument();
  });
});

// ============================================================
// BOUNDARY VIX VALUES
// ============================================================
describe('VIXRegimeCard: VIX boundary values', () => {
  it('renders for VIX exactly 12 (boundary)', () => {
    render(<VIXRegimeCard th={lightTheme} vix={12} spot={6800} />);
    expect(screen.getByText(/regime/i)).toBeInTheDocument();
  });

  it('renders for VIX exactly 18 (zone transition)', () => {
    render(<VIXRegimeCard th={lightTheme} vix={18} spot={6800} />);
    expect(screen.getByText(/caution/i)).toBeInTheDocument();
  });

  it('renders for VIX exactly 25 (zone transition)', () => {
    render(<VIXRegimeCard th={lightTheme} vix={25} spot={6800} />);
    expect(screen.getByText(/elevated/i)).toBeInTheDocument();
  });

  it('renders for VIX exactly 30 (zone transition)', () => {
    render(<VIXRegimeCard th={lightTheme} vix={30} spot={6800} />);
    expect(screen.getByText(/extreme/i)).toBeInTheDocument();
  });

  it('renders for VIX exactly 40 (zone transition)', () => {
    render(<VIXRegimeCard th={lightTheme} vix={40} spot={6800} />);
    expect(screen.getByText(/extreme/i)).toBeInTheDocument();
  });

  it('renders for fractional VIX 14.73', () => {
    render(<VIXRegimeCard th={lightTheme} vix={14.73} spot={6800} />);
    expect(screen.getByText(/green/i)).toBeInTheDocument();
  });

  it('renders for VIX 0.5 (very low)', () => {
    render(<VIXRegimeCard th={lightTheme} vix={0.5} spot={6800} />);
    expect(screen.getByText(/green/i)).toBeInTheDocument();
  });
});

// ============================================================
// THEME VARIATIONS
// ============================================================
describe('VIXRegimeCard: theme support', () => {
  it('renders with light theme', () => {
    render(<VIXRegimeCard th={lightTheme} vix={20} spot={6800} />);
    expect(screen.getByText(/regime/i)).toBeInTheDocument();
  });

  it('renders with dark theme', () => {
    render(<VIXRegimeCard th={darkTheme} vix={20} spot={6800} />);
    expect(screen.getByText(/regime/i)).toBeInTheDocument();
  });

  it('renders each zone in both themes without crashing', () => {
    const vixLevels = [10, 19, 27, 50]; // go, caution, stop, danger
    for (const v of vixLevels) {
      const { unmount: u1 } = render(
        <VIXRegimeCard th={lightTheme} vix={v} spot={6800} />,
      );
      expect(screen.getByText(/regime/i)).toBeInTheDocument();
      u1();

      const { unmount: u2 } = render(
        <VIXRegimeCard th={darkTheme} vix={v} spot={6800} />,
      );
      expect(screen.getByText(/regime/i)).toBeInTheDocument();
      u2();
    }
  });
});
