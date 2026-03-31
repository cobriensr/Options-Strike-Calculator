import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BWBCalculator from '../../components/BWBCalculator';
import {
  calcNet,
  calcPnl,
  calcMetrics,
  generatePnlRows,
} from '../../components/BWBCalculator/bwb-math';

// ============================================================
// Unit tests: bwb-math
// ============================================================

describe('bwb-math: calcNet', () => {
  it('positive when 2×mid > low + high (credit)', () => {
    // sell high premium at mid, buy cheap at wings
    expect(calcNet(5, 10, 2)).toBe(13); // 2×10 - 5 - 2 = 13
  });

  it('negative when 2×mid < low + high (debit)', () => {
    expect(calcNet(23, 12.1, 2.7)).toBeCloseTo(-1.5, 8);
  });

  it('zero when premiums balance exactly', () => {
    expect(calcNet(5, 5, 5)).toBe(0);
  });
});

describe('bwb-math: calcPnl (calls)', () => {
  // User's real trade: Buy 6480C@23, Sell 2×6500C@12.10, Buy 6540C@2.70
  const low = 6480,
    mid = 6500,
    high = 6540;
  const net = calcNet(23, 12.1, 2.7); // -1.50

  it('below low: P&L = net (debit lost)', () => {
    expect(calcPnl('calls', low, mid, high, net, 6400)).toBeCloseTo(-1.5, 8);
  });

  it('at low strike: P&L = net', () => {
    expect(calcPnl('calls', low, mid, high, net, 6480)).toBeCloseTo(-1.5, 8);
  });

  it('at lower breakeven (6481.50): P&L ≈ 0', () => {
    expect(calcPnl('calls', low, mid, high, net, 6481.5)).toBeCloseTo(0, 6);
  });

  it('at sweet spot (6500): P&L = narrowWidth + net = 18.50', () => {
    expect(calcPnl('calls', low, mid, high, net, 6500)).toBeCloseTo(18.5, 6);
  });

  it('at upper breakeven (6518.50): P&L ≈ 0', () => {
    expect(calcPnl('calls', low, mid, high, net, 6518.5)).toBeCloseTo(0, 6);
  });

  it('above high: P&L capped at max loss', () => {
    const maxLoss = calcPnl('calls', low, mid, high, net, 6540);
    expect(maxLoss).toBeCloseTo(-21.5, 6);
    // Further above is the same
    expect(calcPnl('calls', low, mid, high, net, 6600)).toBeCloseTo(
      maxLoss,
      8,
    );
  });
});

describe('bwb-math: calcPnl (puts)', () => {
  const low = 6460,
    mid = 6500,
    high = 6520;
  const net = -1.5;

  it('above high: P&L = net (debit lost)', () => {
    expect(calcPnl('puts', low, mid, high, net, 6600)).toBeCloseTo(-1.5, 8);
  });

  it('at sweet spot (6500): P&L = (high-mid) + net = 18.50', () => {
    expect(calcPnl('puts', low, mid, high, net, 6500)).toBeCloseTo(18.5, 6);
  });

  it('below low: P&L capped at max loss', () => {
    const maxLoss = calcPnl('puts', low, mid, high, net, 6460);
    expect(maxLoss).toBeCloseTo(-21.5, 6);
    expect(calcPnl('puts', low, mid, high, net, 6400)).toBeCloseTo(maxLoss, 8);
  });
});

describe('bwb-math: calcMetrics (calls)', () => {
  const low = 6480,
    mid = 6500,
    high = 6540;
  const net = -1.5;
  const m = calcMetrics('calls', low, mid, high, net);

  it('narrowWidth = mid - low', () => {
    expect(m.narrowWidth).toBe(20);
  });

  it('wideWidth = high - mid', () => {
    expect(m.wideWidth).toBe(40);
  });

  it('maxProfit = narrowWidth + net', () => {
    expect(m.maxProfit).toBeCloseTo(18.5, 8);
  });

  it('safePnl = net', () => {
    expect(m.safePnl).toBeCloseTo(-1.5, 8);
  });

  it('riskPnl = -(wideWidth - narrowWidth) + net', () => {
    expect(m.riskPnl).toBeCloseTo(-21.5, 8);
  });

  it('lower breakeven between low and mid', () => {
    expect(m.lowerBE).toBeCloseTo(6481.5, 8);
  });

  it('upper breakeven between mid and high', () => {
    expect(m.upperBE).toBeCloseTo(6518.5, 8);
  });

  it('sweetSpot = mid', () => {
    expect(m.sweetSpot).toBe(6500);
  });
});

describe('bwb-math: calcMetrics (puts)', () => {
  const low = 6460,
    mid = 6500,
    high = 6520;
  const net = -1.5;
  const m = calcMetrics('puts', low, mid, high, net);

  it('narrowWidth = high - mid', () => {
    expect(m.narrowWidth).toBe(20);
  });

  it('wideWidth = mid - low', () => {
    expect(m.wideWidth).toBe(40);
  });

  it('lower breakeven between low and mid', () => {
    expect(m.lowerBE).toBeCloseTo(6481.5, 8);
  });

  it('upper breakeven between mid and high', () => {
    expect(m.upperBE).toBeCloseTo(6518.5, 8);
  });
});

describe('bwb-math: calcMetrics — credit BWB (no lower BE)', () => {
  // If net is positive, there may be no lower breakeven
  const m = calcMetrics('calls', 6480, 6500, 6540, 2);

  it('lower BE is null (always profitable on safe side)', () => {
    expect(m.lowerBE).toBeNull();
  });

  it('upper BE still exists', () => {
    expect(m.upperBE).not.toBeNull();
    expect(m.upperBE!).toBeGreaterThan(6500);
    expect(m.upperBE!).toBeLessThan(6540);
  });
});

describe('bwb-math: generatePnlRows', () => {
  const rows = generatePnlRows('calls', 6480, 6500, 6540, -1.5, 3);

  it('includes exact breakeven levels', () => {
    const spxLevels = rows.map((r) => r.spx);
    expect(spxLevels).toContain(6481.5);
    expect(spxLevels).toContain(6518.5);
  });

  it('includes the sweet spot', () => {
    const sweet = rows.find((r) => r.spx === 6500);
    expect(sweet).toBeDefined();
    expect(sweet!.label).toBe('Max profit');
    expect(sweet!.isKey).toBe(true);
  });

  it('breakeven rows have label "Breakeven"', () => {
    const be = rows.find((r) => r.spx === 6481.5);
    expect(be).toBeDefined();
    expect(be!.label).toBe('Breakeven');
    expect(be!.isKey).toBe(true);
  });

  it('pnl per contract uses $100 multiplier', () => {
    const sweet = rows.find((r) => r.spx === 6500)!;
    expect(sweet.pnlPerContract).toBe(1850); // 18.50 × 100
  });

  it('pnl total scales by contracts', () => {
    const sweet = rows.find((r) => r.spx === 6500)!;
    expect(sweet.pnlTotal).toBe(5550); // 18.50 × 100 × 3
  });

  it('rows are sorted by SPX level', () => {
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.spx).toBeGreaterThan(rows[i - 1]!.spx);
    }
  });
});

// ============================================================
// Component tests
// ============================================================

describe('BWBCalculator component', () => {
  it('renders the calculator heading', () => {
    render(<BWBCalculator />);
    expect(screen.getByText('BWB Live Calculator')).toBeInTheDocument();
  });

  it('renders calls/puts toggle', () => {
    render(<BWBCalculator />);
    expect(screen.getByText('Calls')).toBeInTheDocument();
    expect(screen.getByText('Puts')).toBeInTheDocument();
  });

  it('renders clear button', () => {
    render(<BWBCalculator />);
    expect(screen.getByText('Clear')).toBeInTheDocument();
  });

  it('renders 6 input fields (3 strikes + 3 prices)', () => {
    render(<BWBCalculator />);
    expect(screen.getByLabelText('Low strike')).toBeInTheDocument();
    expect(screen.getByLabelText('Mid strike')).toBeInTheDocument();
    expect(screen.getByLabelText('High strike')).toBeInTheDocument();
    expect(screen.getByLabelText('Low price')).toBeInTheDocument();
    expect(screen.getByLabelText('Mid price')).toBeInTheDocument();
    expect(screen.getByLabelText('High price')).toBeInTheDocument();
  });

  it('shows empty state when inputs are incomplete', () => {
    render(<BWBCalculator />);
    expect(
      screen.getByText(/Enter three strikes and their fill prices/),
    ).toBeInTheDocument();
  });

  it('shows results when all inputs are filled', async () => {
    const user = userEvent.setup();
    render(<BWBCalculator />);

    await user.type(screen.getByLabelText('Low strike'), '6480');
    await user.type(screen.getByLabelText('Mid strike'), '6500');
    await user.type(screen.getByLabelText('High strike'), '6540');
    await user.type(screen.getByLabelText('Low price'), '23');
    await user.type(screen.getByLabelText('Mid price'), '12.10');
    await user.type(screen.getByLabelText('High price'), '2.70');

    // Should show trade summary
    expect(screen.getByText(/DEBIT/)).toBeInTheDocument();
    // Should show P&L table
    expect(
      screen.getByRole('table', { name: 'BWB P&L at expiry' }),
    ).toBeInTheDocument();
  });

  it('shows validation error for non-ascending strikes', async () => {
    const user = userEvent.setup();
    render(<BWBCalculator />);

    await user.type(screen.getByLabelText('Low strike'), '6500');
    await user.type(screen.getByLabelText('Mid strike'), '6480');
    await user.type(screen.getByLabelText('High strike'), '6540');

    expect(
      screen.getByText(/Strikes must be in ascending order/),
    ).toBeInTheDocument();
  });

  it('clear button resets all inputs', async () => {
    const user = userEvent.setup();
    render(<BWBCalculator />);

    await user.type(screen.getByLabelText('Low strike'), '6480');
    await user.type(screen.getByLabelText('Mid strike'), '6500');
    await user.click(screen.getByText('Clear'));

    expect(screen.getByLabelText('Low strike')).toHaveValue('');
    expect(screen.getByLabelText('Mid strike')).toHaveValue('');
  });

  it('switches between calls and puts', async () => {
    const user = userEvent.setup();
    render(<BWBCalculator />);

    await user.type(screen.getByLabelText('Low strike'), '6480');
    await user.type(screen.getByLabelText('Mid strike'), '6500');
    await user.type(screen.getByLabelText('High strike'), '6540');
    await user.type(screen.getByLabelText('Low price'), '23');
    await user.type(screen.getByLabelText('Mid price'), '12.10');
    await user.type(screen.getByLabelText('High price'), '2.70');

    // Switch to puts — trade summary changes from "Call" to "Put"
    await user.click(screen.getByText('Puts'));
    expect(screen.getAllByText(/Put\b/).length).toBeGreaterThan(0);

    // Switch back to calls
    await user.click(screen.getByText('Calls'));
    expect(screen.getAllByText(/Call\b/).length).toBeGreaterThan(0);
  });

  it('contracts counter increments and decrements', async () => {
    const user = userEvent.setup();
    render(<BWBCalculator />);

    const contractInput = screen.getByLabelText('Number of contracts');
    expect(contractInput).toHaveValue('1');

    await user.click(screen.getByText('+'));
    expect(contractInput).toHaveValue('2');

    await user.click(screen.getByText('\u2212'));
    expect(contractInput).toHaveValue('1');

    // Cannot go below 1
    await user.click(screen.getByText('\u2212'));
    expect(contractInput).toHaveValue('1');
  });

  it('shows key numbers section with filled inputs', async () => {
    const user = userEvent.setup();
    render(<BWBCalculator />);

    await user.type(screen.getByLabelText('Low strike'), '6480');
    await user.type(screen.getByLabelText('Mid strike'), '6500');
    await user.type(screen.getByLabelText('High strike'), '6540');
    await user.type(screen.getByLabelText('Low price'), '23');
    await user.type(screen.getByLabelText('Mid price'), '12.10');
    await user.type(screen.getByLabelText('High price'), '2.70');

    expect(screen.getByText('Max Profit')).toBeInTheDocument();
    expect(screen.getByText('Breakevens')).toBeInTheDocument();
  });
});
