import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BWBCalculator from '../../components/BWBCalculator';
import {
  calcNet,
  calcPnl,
  calcMetrics,
  generatePnlRows,
  calcIronFlyPnl,
  calcIronFlyMetrics,
  generateIronFlyPnlRows,
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
    expect(calcPnl('calls', low, mid, high, net, 6600)).toBeCloseTo(maxLoss, 8);
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
    expect(screen.getByText('Settlement Pin Calculator')).toBeInTheDocument();
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

  it('renders 3 strike inputs and dual fill price inputs', () => {
    render(<BWBCalculator />);
    expect(screen.getByLabelText('Low strike')).toBeInTheDocument();
    expect(screen.getByLabelText('Mid strike')).toBeInTheDocument();
    expect(screen.getByLabelText('High strike')).toBeInTheDocument();
    expect(screen.getByLabelText('BWB fill price')).toBeInTheDocument();
    expect(screen.getByLabelText('Iron Fly fill price')).toBeInTheDocument();
    expect(screen.getAllByText('Debit')).toHaveLength(2);
    expect(screen.getAllByText('Credit')).toHaveLength(2);
  });

  it('shows empty state when inputs are incomplete', () => {
    render(<BWBCalculator />);
    expect(
      screen.getByText(/Enter three strikes and at least one fill price/),
    ).toBeInTheDocument();
  });

  it('shows BWB results when BWB fill price is entered', async () => {
    const user = userEvent.setup();
    render(<BWBCalculator />);

    await user.type(screen.getByLabelText('Low strike'), '6480');
    await user.type(screen.getByLabelText('Mid strike'), '6500');
    await user.type(screen.getByLabelText('High strike'), '6540');
    await user.type(screen.getByLabelText('BWB fill price'), '1.50');
    // Default is credit, click Debit (first Debit button = BWB)
    await user.click(screen.getAllByText('Debit')[0]!);

    // Should show trade summary
    expect(screen.getByText(/DEBIT/)).toBeInTheDocument();
    // Should show P&L table
    expect(
      screen.getByRole('table', { name: 'BWB P&L at expiry' }),
    ).toBeInTheDocument();
  });

  it('shows Iron Fly results when IF fill price is entered', async () => {
    const user = userEvent.setup();
    render(<BWBCalculator />);

    await user.type(screen.getByLabelText('Low strike'), '6480');
    await user.type(screen.getByLabelText('Mid strike'), '6500');
    await user.type(screen.getByLabelText('High strike'), '6540');
    await user.type(screen.getByLabelText('Iron Fly fill price'), '8.00');

    expect(
      screen.getByRole('table', { name: 'Iron Fly P&L at expiry' }),
    ).toBeInTheDocument();
  });

  it('shows both results side by side when both fills are entered', async () => {
    const user = userEvent.setup();
    render(<BWBCalculator />);

    await user.type(screen.getByLabelText('Low strike'), '6480');
    await user.type(screen.getByLabelText('Mid strike'), '6500');
    await user.type(screen.getByLabelText('High strike'), '6540');
    await user.type(screen.getByLabelText('BWB fill price'), '0.91');
    await user.type(screen.getByLabelText('Iron Fly fill price'), '8.00');

    expect(
      screen.getByRole('table', { name: 'BWB P&L at expiry' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: 'Iron Fly P&L at expiry' }),
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

  it('clear button resets all inputs including both fill prices', async () => {
    const user = userEvent.setup();
    render(<BWBCalculator />);

    await user.type(screen.getByLabelText('Low strike'), '6480');
    await user.type(screen.getByLabelText('Mid strike'), '6500');
    await user.type(screen.getByLabelText('BWB fill price'), '0.91');
    await user.type(screen.getByLabelText('Iron Fly fill price'), '8.00');
    await user.click(screen.getByText('Clear'));

    expect(screen.getByLabelText('Low strike')).toHaveValue('');
    expect(screen.getByLabelText('Mid strike')).toHaveValue('');
    expect(screen.getByLabelText('BWB fill price')).toHaveValue('');
    expect(screen.getByLabelText('Iron Fly fill price')).toHaveValue('');
  });

  it('switches between calls and puts', async () => {
    const user = userEvent.setup();
    render(<BWBCalculator />);

    await user.type(screen.getByLabelText('Low strike'), '6480');
    await user.type(screen.getByLabelText('Mid strike'), '6500');
    await user.type(screen.getByLabelText('High strike'), '6540');
    await user.type(screen.getByLabelText('BWB fill price'), '1.50');

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

  it('sweet spot auto-fills strikes for calls', async () => {
    const user = userEvent.setup();
    render(<BWBCalculator />);

    // Default narrow=20, wide=40
    await user.type(screen.getByLabelText('Sweet spot strike'), '6500');

    // For calls: low = 6500-20 = 6480, mid = 6500, high = 6500+40 = 6540
    expect(screen.getByLabelText('Low strike')).toHaveValue('6480');
    expect(screen.getByLabelText('Mid strike')).toHaveValue('6500');
    expect(screen.getByLabelText('High strike')).toHaveValue('6540');
  });

  it('sweet spot auto-fills strikes for puts', async () => {
    const user = userEvent.setup();
    render(<BWBCalculator />);

    await user.click(screen.getByText('Puts'));
    await user.type(screen.getByLabelText('Sweet spot strike'), '6500');

    // For puts: low = 6500-40 = 6460, mid = 6500, high = 6500+20 = 6520
    expect(screen.getByLabelText('Low strike')).toHaveValue('6460');
    expect(screen.getByLabelText('Mid strike')).toHaveValue('6500');
    expect(screen.getByLabelText('High strike')).toHaveValue('6520');
  });

  it('clear button resets sweet spot', async () => {
    const user = userEvent.setup();
    render(<BWBCalculator />);

    await user.type(screen.getByLabelText('Sweet spot strike'), '6500');
    await user.click(screen.getByText('Clear'));

    expect(screen.getByLabelText('Sweet spot strike')).toHaveValue('');
    expect(screen.getByLabelText('Low strike')).toHaveValue('');
  });

  it('shows key numbers section with filled inputs', async () => {
    const user = userEvent.setup();
    render(<BWBCalculator />);

    await user.type(screen.getByLabelText('Low strike'), '6480');
    await user.type(screen.getByLabelText('Mid strike'), '6500');
    await user.type(screen.getByLabelText('High strike'), '6540');
    await user.type(screen.getByLabelText('BWB fill price'), '1.50');

    expect(screen.getByText('Max Profit')).toBeInTheDocument();
    expect(screen.getByText('Breakevens')).toBeInTheDocument();
  });
});

// ============================================================
// BWBCalculator — anchor / charm / wing / credit-debit coverage
// ============================================================

describe('BWBCalculator anchor + charm', () => {
  const anchorResponse = {
    anchor: 5700,
    price: 5680,
    distFromPrice: 20,
    charmAdjusted: 5705,
  };

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(anchorResponse),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders gamma anchor after successful fetch', async () => {
    render(<BWBCalculator />);
    await waitFor(() => {
      expect(screen.getByText('5700')).toBeInTheDocument();
    });
    expect(screen.getByText(/γ Anchor/)).toBeInTheDocument();
  });

  it('shows charm toggle when charmAdjusted differs from strike', async () => {
    render(<BWBCalculator />);
    await waitFor(() => {
      expect(screen.getByText('γ+C')).toBeInTheDocument();
    });
    expect(screen.getByText('γ', { exact: true })).toBeInTheDocument();
  });

  it('hides charm toggle when charmAdjusted equals strike', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ...anchorResponse, charmAdjusted: 5700 }),
      }),
    );
    render(<BWBCalculator />);
    await waitFor(() => {
      expect(screen.getByText('5700')).toBeInTheDocument();
    });
    expect(screen.queryByText('γ+C')).not.toBeInTheDocument();
  });

  it('clicking γ+C switches to charm-adjusted strike', async () => {
    const user = userEvent.setup();
    render(<BWBCalculator />);
    await waitFor(() => {
      expect(screen.getByText('γ+C')).toBeInTheDocument();
    });
    await user.click(screen.getByText('γ+C'));
    // Now should show charmAdjusted value (5705) instead of 5700
    expect(screen.getByText('5705')).toBeInTheDocument();
  });

  it('Use button fills sweet spot with anchor strike', async () => {
    const user = userEvent.setup();
    render(<BWBCalculator />);
    await waitFor(() => {
      expect(screen.getByText('Use')).toBeInTheDocument();
    });
    await user.click(screen.getByText('Use'));
    expect(screen.getByLabelText('Sweet spot strike')).toHaveValue('5700');
    // Auto-filled strikes (calls, narrow=20, wide=40):
    expect(screen.getByLabelText('Low strike')).toHaveValue('5680');
    expect(screen.getByLabelText('Mid strike')).toHaveValue('5700');
    expect(screen.getByLabelText('High strike')).toHaveValue('5740');
  });

  it('passes selectedDate as query param to fetch', async () => {
    render(<BWBCalculator selectedDate="2026-04-01" />);
    await waitFor(() => {
      expect(screen.getByText('5700')).toBeInTheDocument();
    });
    const fetchCalls = vi.mocked(fetch).mock.calls;
    expect(fetchCalls[0]![0]).toBe('/api/bwb-anchor?date=2026-04-01');
  });

  it('handles fetch failure gracefully', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Network error')),
    );
    render(<BWBCalculator />);
    // Should still render without anchor
    expect(screen.getByText('Settlement Pin Calculator')).toBeInTheDocument();
    expect(screen.queryByText(/γ Anchor/)).not.toBeInTheDocument();
  });

  it('handles non-ok response gracefully', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve(null),
      }),
    );
    render(<BWBCalculator />);
    // Wait for fetch to settle
    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalled();
    });
    expect(screen.queryByText(/γ Anchor/)).not.toBeInTheDocument();
  });
});

describe('BWBCalculator wing width + credit/debit', () => {
  it('changing narrow width re-fills strikes', async () => {
    const user = userEvent.setup();
    render(<BWBCalculator />);

    await user.type(screen.getByLabelText('Sweet spot strike'), '6500');
    // Default narrow=20 => low=6480
    expect(screen.getByLabelText('Low strike')).toHaveValue('6480');

    // For controlled numeric inputs, fireEvent.change is more reliable
    // than userEvent.type since the handler ignores non-numeric values
    const narrowInput = screen.getByLabelText('Narrow wing width');
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(narrowInput, { target: { value: '25' } });
    // low = 6500 - 25 = 6475
    expect(screen.getByLabelText('Low strike')).toHaveValue('6475');
  });

  it('changing wide width re-fills strikes', async () => {
    const user = userEvent.setup();
    render(<BWBCalculator />);

    await user.type(screen.getByLabelText('Sweet spot strike'), '6500');
    // Default wide=40 => high=6540
    expect(screen.getByLabelText('High strike')).toHaveValue('6540');

    const wideInput = screen.getByLabelText('Wide wing width');
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(wideInput, { target: { value: '50' } });
    // high = 6500 + 50 = 6550
    expect(screen.getByLabelText('High strike')).toHaveValue('6550');
  });

  it('manual strike edit clears sweet spot', async () => {
    const user = userEvent.setup();
    render(<BWBCalculator />);

    await user.type(screen.getByLabelText('Sweet spot strike'), '6500');
    expect(screen.getByLabelText('Sweet spot strike')).toHaveValue('6500');

    // Manually edit low strike
    await user.clear(screen.getByLabelText('Low strike'));
    await user.type(screen.getByLabelText('Low strike'), '6485');
    expect(screen.getByLabelText('Sweet spot strike')).toHaveValue('');
  });

  it('credit toggle shows CREDIT label in trade summary', async () => {
    const user = userEvent.setup();
    render(<BWBCalculator />);

    await user.type(screen.getByLabelText('Low strike'), '6480');
    await user.type(screen.getByLabelText('Mid strike'), '6500');
    await user.type(screen.getByLabelText('High strike'), '6540');
    await user.type(screen.getByLabelText('BWB fill price'), '0.91');
    // Default is credit
    expect(screen.getByText('CREDIT')).toBeInTheDocument();
  });

  it('debit toggle shows DEBIT label', async () => {
    const user = userEvent.setup();
    render(<BWBCalculator />);

    await user.type(screen.getByLabelText('Low strike'), '6480');
    await user.type(screen.getByLabelText('Mid strike'), '6500');
    await user.type(screen.getByLabelText('High strike'), '6540');
    await user.type(screen.getByLabelText('BWB fill price'), '1.50');
    await user.click(screen.getAllByText('Debit')[0]!);
    expect(screen.getByText('DEBIT')).toBeInTheDocument();
  });

  it('contracts > 1 shows plural in footer', async () => {
    const user = userEvent.setup();
    render(<BWBCalculator />);

    await user.type(screen.getByLabelText('Low strike'), '6480');
    await user.type(screen.getByLabelText('Mid strike'), '6500');
    await user.type(screen.getByLabelText('High strike'), '6540');
    await user.type(screen.getByLabelText('BWB fill price'), '1.50');
    await user.click(screen.getByText('+'));
    await user.click(screen.getByText('+'));
    // 3 contracts — use getAllByText since it appears in both header and footer
    const matches = screen.getAllByText(/3 contracts/);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('contracts direct input accepts valid values', async () => {
    render(<BWBCalculator />);

    const contractInput = screen.getByLabelText('Number of contracts');
    const { fireEvent: fe } = await import('@testing-library/react');
    fe.change(contractInput, { target: { value: '5' } });
    expect(contractInput).toHaveValue('5');

    // Empty resets to 1
    fe.change(contractInput, { target: { value: '' } });
    expect(contractInput).toHaveValue('1');
  });
});

// ============================================================
// Unit tests: calcIronFlyPnl
// ============================================================

describe('bwb-math: calcIronFlyPnl', () => {
  // Typical 0DTE SPX iron fly: buy 5490P, sell 5500 straddle, buy 5510C
  // net = credit collected, e.g. 8.00 pts
  const low = 5490,
    mid = 5500,
    high = 5510;
  const net = 8;

  it('at the money (sweet spot): P&L = net (full credit kept)', () => {
    // At mid: max(mid-spx,0)=0, max(spx-mid,0)=0, wings expired worthless
    expect(calcIronFlyPnl(low, mid, high, net, 5500)).toBeCloseTo(8, 8);
  });

  it('below low wing: P&L = net - lowerWing (max loss below)', () => {
    // spx=5480: net - (mid-spx) + (low-spx) = 8 - 20 + 10 = -2
    // formula: net - max(5500-5480,0) - max(5480-5500,0) + max(5490-5480,0) + max(5480-5510,0)
    //        = 8 - 20 - 0 + 10 + 0 = -2
    expect(calcIronFlyPnl(low, mid, high, net, 5480)).toBeCloseTo(-2, 8);
  });

  it('at low wing exactly: P&L = net - lowerWing', () => {
    // spx=5490: net - max(5500-5490,0) - 0 + max(5490-5490,0) + 0
    //         = 8 - 10 - 0 + 0 + 0 = -2
    expect(calcIronFlyPnl(low, mid, high, net, 5490)).toBeCloseTo(-2, 8);
  });

  it('above high wing: P&L = net - upperWing (max loss above)', () => {
    // spx=5520: net - 0 - max(5520-5500,0) + 0 + max(5520-5510,0)
    //         = 8 - 0 - 20 + 0 + 10 = -2
    expect(calcIronFlyPnl(low, mid, high, net, 5520)).toBeCloseTo(-2, 8);
  });

  it('at high wing exactly: P&L = net - upperWing', () => {
    // spx=5510: 8 - 0 - 10 + 0 + 0 = -2
    expect(calcIronFlyPnl(low, mid, high, net, 5510)).toBeCloseTo(-2, 8);
  });

  it('at lower breakeven (mid - net): P&L ≈ 0', () => {
    // lowerBE = 5500 - 8 = 5492
    // spx=5492: 8 - max(8,0) - 0 + max(-2,0) + 0 = 8 - 8 + 0 = 0
    expect(calcIronFlyPnl(low, mid, high, net, 5492)).toBeCloseTo(0, 6);
  });

  it('at upper breakeven (mid + net): P&L ≈ 0', () => {
    // upperBE = 5500 + 8 = 5508
    // spx=5508: 8 - 0 - max(8,0) + 0 + max(-2,0) = 8 - 8 = 0
    expect(calcIronFlyPnl(low, mid, high, net, 5508)).toBeCloseTo(0, 6);
  });

  it('between lower BE and mid: partial profit', () => {
    // spx=5496 (between lowerBE=5492 and mid=5500)
    // 8 - max(4,0) - 0 + 0 + 0 = 4
    expect(calcIronFlyPnl(low, mid, high, net, 5496)).toBeCloseTo(4, 6);
  });

  it('between mid and upper BE: partial profit', () => {
    // spx=5504 (between mid=5500 and upperBE=5508)
    // 8 - 0 - max(4,0) + 0 + 0 = 4
    expect(calcIronFlyPnl(low, mid, high, net, 5504)).toBeCloseTo(4, 6);
  });

  it('zero net credit: P&L is always <= 0', () => {
    const pnlAtMid = calcIronFlyPnl(5490, 5500, 5510, 0, 5500);
    expect(pnlAtMid).toBeCloseTo(0, 8);
    const pnlBelow = calcIronFlyPnl(5490, 5500, 5510, 0, 5480);
    expect(pnlBelow).toBeLessThanOrEqual(0);
  });

  it('P&L is capped (same at and beyond wing)', () => {
    const atLow = calcIronFlyPnl(low, mid, high, net, 5490);
    const belowLow = calcIronFlyPnl(low, mid, high, net, 5400);
    expect(atLow).toBeCloseTo(belowLow, 8);

    const atHigh = calcIronFlyPnl(low, mid, high, net, 5510);
    const aboveHigh = calcIronFlyPnl(low, mid, high, net, 5600);
    expect(atHigh).toBeCloseTo(aboveHigh, 8);
  });
});

// ============================================================
// Unit tests: calcIronFlyMetrics
// ============================================================

describe('bwb-math: calcIronFlyMetrics', () => {
  const low = 5490,
    mid = 5500,
    high = 5510;
  const net = 8;
  const m = calcIronFlyMetrics(low, mid, high, net);

  it('lowerWing = mid - low', () => {
    expect(m.lowerWing).toBe(10);
  });

  it('upperWing = high - mid', () => {
    expect(m.upperWing).toBe(10);
  });

  it('maxProfit = net (credit collected at sweet spot)', () => {
    expect(m.maxProfit).toBe(8);
  });

  it('net is stored correctly', () => {
    expect(m.net).toBe(8);
  });

  it('lossBelow = net - lowerWing', () => {
    expect(m.lossBelow).toBeCloseTo(8 - 10, 8); // -2
  });

  it('lossAbove = net - upperWing', () => {
    expect(m.lossAbove).toBeCloseTo(8 - 10, 8); // -2
  });

  it('lowerBE = mid - net when net > 0', () => {
    expect(m.lowerBE).toBeCloseTo(5492, 8);
  });

  it('upperBE = mid + net when net > 0', () => {
    expect(m.upperBE).toBeCloseTo(5508, 8);
  });

  it('sweetSpot = mid', () => {
    expect(m.sweetSpot).toBe(5500);
  });

  it('asymmetric wings: lowerWing != upperWing', () => {
    const am = calcIronFlyMetrics(5480, 5500, 5515, 6);
    expect(am.lowerWing).toBe(20);
    expect(am.upperWing).toBe(15);
    expect(am.lossBelow).toBeCloseTo(6 - 20, 8); // -14
    expect(am.lossAbove).toBeCloseTo(6 - 15, 8); // -9
  });

  it('zero net: lowerBE and upperBE are null', () => {
    const zm = calcIronFlyMetrics(5490, 5500, 5510, 0);
    expect(zm.lowerBE).toBeNull();
    expect(zm.upperBE).toBeNull();
    expect(zm.maxProfit).toBe(0);
  });

  it('negative net (debit): lowerBE and upperBE are null', () => {
    const dm = calcIronFlyMetrics(5490, 5500, 5510, -2);
    expect(dm.lowerBE).toBeNull();
    expect(dm.upperBE).toBeNull();
  });
});

// ============================================================
// Unit tests: generateIronFlyPnlRows
// ============================================================

describe('bwb-math: generateIronFlyPnlRows', () => {
  const low = 5490,
    mid = 5500,
    high = 5510;
  const net = 8;
  const rows = generateIronFlyPnlRows(low, mid, high, net, 2);

  it('returns empty array when high - low > 300', () => {
    expect(generateIronFlyPnlRows(5000, 5500, 5400, 8, 1)).toHaveLength(0);
  });

  it('returns a non-empty array for valid inputs', () => {
    expect(rows.length).toBeGreaterThan(0);
  });

  it('rows are sorted by ascending SPX level', () => {
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.spx).toBeGreaterThan(rows[i - 1]!.spx);
    }
  });

  it('includes exact breakeven levels as rows', () => {
    const spxLevels = rows.map((r) => r.spx);
    // lowerBE = 5500 - 8 = 5492
    expect(spxLevels).toContain(5492);
    // upperBE = 5500 + 8 = 5508
    expect(spxLevels).toContain(5508);
  });

  it('sweet spot row has label "Max profit" and isKey = true', () => {
    const sweet = rows.find((r) => r.spx === 5500);
    expect(sweet).toBeDefined();
    expect(sweet!.label).toBe('Max profit');
    expect(sweet!.isKey).toBe(true);
  });

  it('breakeven rows have label "Breakeven" and isKey = true', () => {
    const lbe = rows.find((r) => r.spx === 5492);
    expect(lbe).toBeDefined();
    expect(lbe!.label).toBe('Breakeven');
    expect(lbe!.isKey).toBe(true);

    const ube = rows.find((r) => r.spx === 5508);
    expect(ube).toBeDefined();
    expect(ube!.label).toBe('Breakeven');
    expect(ube!.isKey).toBe(true);
  });

  it('pnlPerContract uses $100 multiplier at sweet spot', () => {
    const sweet = rows.find((r) => r.spx === 5500)!;
    // P&L = 8 pts × $100 = $800
    expect(sweet.pnlPerContract).toBe(800);
  });

  it('pnlTotal scales by contracts at sweet spot', () => {
    const sweet = rows.find((r) => r.spx === 5500)!;
    // 8 pts × $100 × 2 contracts = $1600
    expect(sweet.pnlTotal).toBe(1600);
  });

  it('non-key rows have isKey = false', () => {
    const nonKey = rows.filter((r) => !r.isKey);
    expect(nonKey.length).toBeGreaterThan(0);
    nonKey.forEach((r) => expect(r.isKey).toBe(false));
  });

  it('rows at/beyond wings have label "Max loss"', () => {
    // The start of the range (well below low) should get "Max loss"
    const startRow = rows[0]!;
    expect(startRow.label).toBe('Max loss');

    // The end of the range (well above high) should get "Max loss"
    const endRow = rows.at(-1)!;
    expect(endRow.label).toBe('Max loss');
  });

  it('pnlPts at max-loss levels equals net - wing', () => {
    // lossBelow = 8 - 10 = -2
    const startRow = rows[0]!;
    expect(startRow.pnlPts).toBeCloseTo(-2, 6);
  });

  it('zero net: no breakeven rows inserted', () => {
    const zeroRows = generateIronFlyPnlRows(5490, 5500, 5510, 0, 1);
    const beRows = zeroRows.filter((r) => r.label === 'Breakeven');
    expect(beRows).toHaveLength(0);
  });

  it('1 contract: pnlTotal equals pnlPerContract', () => {
    const singleRows = generateIronFlyPnlRows(5490, 5500, 5510, 8, 1);
    singleRows.forEach((r) => {
      expect(r.pnlTotal).toBe(r.pnlPerContract);
    });
  });
});
