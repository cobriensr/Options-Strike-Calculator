import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FuturesCalculator from '../../components/futures/FuturesCalculator';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Type into the entry price field */
async function fillEntry(
  user: ReturnType<typeof userEvent.setup>,
  value: string,
) {
  await user.type(screen.getByLabelText('Entry Price'), value);
}

/** Type into the exit price field */
async function fillExit(
  user: ReturnType<typeof userEvent.setup>,
  value: string,
) {
  await user.type(screen.getByLabelText('Exit Price'), value);
}

// ── Initial render ────────────────────────────────────────────────────────────

describe('FuturesCalculator — initial render', () => {
  it('renders the section heading', () => {
    render(<FuturesCalculator />);
    expect(
      screen.getByRole('region', { name: 'Futures day-trade P&L calculator' }),
    ).toBeInTheDocument();
  });

  it('renders the heading text', () => {
    render(<FuturesCalculator />);
    expect(screen.getByText(/Futures P&L Calculator/i)).toBeInTheDocument();
  });

  it('renders all four symbol chips', () => {
    render(<FuturesCalculator />);
    expect(screen.getByRole('button', { name: 'ES' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'NQ' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'MES' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'MNQ' })).toBeInTheDocument();
  });

  it('renders Clear button', () => {
    render(<FuturesCalculator />);
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
  });

  it('defaults to ES symbol — shows ES spec bar', () => {
    render(<FuturesCalculator />);
    expect(screen.getByText(/E-Mini S&P 500/)).toBeInTheDocument();
    expect(screen.getByText('$50')).toBeInTheDocument();
    expect(screen.getByText('$12.5')).toBeInTheDocument();
    expect(screen.getByText('$500')).toBeInTheDocument();
  });

  it('renders direction buttons', () => {
    render(<FuturesCalculator />);
    expect(
      screen.getByRole('button', { name: 'Long (Buy)' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Short (Sell)' }),
    ).toBeInTheDocument();
  });

  it('renders entry, exit, and contracts stepper', () => {
    render(<FuturesCalculator />);
    expect(screen.getByLabelText('Entry Price')).toBeInTheDocument();
    expect(screen.getByLabelText('Exit Price')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Increase contracts' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Decrease contracts' }),
    ).toBeInTheDocument();
  });

  it('shows empty state when no entry is provided', () => {
    render(<FuturesCalculator />);
    expect(screen.getByText(/Enter an entry price/)).toBeInTheDocument();
  });

  it('contracts stepper defaults to 1', () => {
    render(<FuturesCalculator />);
    expect(screen.getByTestId('fc-contracts-display')).toHaveTextContent('1');
  });
});

// ── Collapsible header ────────────────────────────────────────────────────────

describe('FuturesCalculator — collapsible header', () => {
  it('header button has aria-expanded=true by default', () => {
    render(<FuturesCalculator />);
    expect(
      screen.getByRole('button', { name: 'Toggle Futures P&L Calculator' }),
    ).toHaveAttribute('aria-expanded', 'true');
  });

  it('clicking the header collapses the body', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await user.click(
      screen.getByRole('button', { name: 'Toggle Futures P&L Calculator' }),
    );

    expect(
      screen.getByRole('button', { name: 'Toggle Futures P&L Calculator' }),
    ).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Entry Price')).not.toBeInTheDocument();
  });

  it('clicking the header again expands the body', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    const toggle = screen.getByRole('button', {
      name: 'Toggle Futures P&L Calculator',
    });
    await user.click(toggle);
    await user.click(toggle);

    expect(screen.getByLabelText('Entry Price')).toBeInTheDocument();
  });

  it('Enter key toggles collapsed state', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    const toggle = screen.getByRole('button', {
      name: 'Toggle Futures P&L Calculator',
    });
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('Space key toggles collapsed state', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    const toggle = screen.getByRole('button', {
      name: 'Toggle Futures P&L Calculator',
    });
    toggle.focus();
    await user.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});

// ── Symbol switching ──────────────────────────────────────────────────────────

describe('FuturesCalculator — symbol switching', () => {
  it('switching to NQ updates the spec bar', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await user.click(screen.getByRole('button', { name: 'NQ' }));

    expect(screen.getByText(/E-Mini NASDAQ 100/)).toBeInTheDocument();
    expect(screen.getByText('$20')).toBeInTheDocument();
    expect(screen.getByText('$5')).toBeInTheDocument();
    expect(screen.getByText('$1,000')).toBeInTheDocument();
  });

  it('switching back to ES restores ES spec bar', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await user.click(screen.getByRole('button', { name: 'NQ' }));
    await user.click(screen.getByRole('button', { name: 'ES' }));

    expect(screen.getByText(/E-Mini S&P 500/)).toBeInTheDocument();
    expect(screen.getByText('$50')).toBeInTheDocument();
  });

  it('switching to MES updates the spec bar', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await user.click(screen.getByRole('button', { name: 'MES' }));

    expect(screen.getByText(/Micro E-Mini S&P 500/)).toBeInTheDocument();
    expect(screen.getByText('$5')).toBeInTheDocument();
    expect(screen.getByText('$1.25')).toBeInTheDocument();
    expect(screen.getByText('$50')).toBeInTheDocument();
  });

  it('switching to MNQ updates the spec bar', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await user.click(screen.getByRole('button', { name: 'MNQ' }));

    expect(screen.getByText(/Micro E-Mini NASDAQ 100/)).toBeInTheDocument();
    expect(screen.getByText('$2')).toBeInTheDocument();
    expect(screen.getByText('$0.5')).toBeInTheDocument();
    expect(screen.getByText('$100')).toBeInTheDocument();
  });

  it('switching symbol clears prices then uses new spec', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    // ES 1-tick gross = $12.50
    expect(screen.getByText('+$12.50')).toBeInTheDocument();

    // Switch to NQ — prices are cleared
    await user.click(screen.getByRole('button', { name: 'NQ' }));
    expect(screen.getByLabelText('Entry Price')).toHaveValue('');

    // Re-enter price under NQ spec
    await fillEntry(user, '21000');
    // NQ 1-tick gross = $5.00
    expect(screen.getByText('+$5.00')).toBeInTheDocument();
  });
});

// ── Direction toggle ──────────────────────────────────────────────────────────

describe('FuturesCalculator — direction toggle', () => {
  it('switching to short clears prices; short tick ladder exits below entry', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    // Long: +1 tick exit is above entry
    expect(screen.getByText('5,500.25')).toBeInTheDocument();

    // Switch to short — prices clear
    await user.click(screen.getByRole('button', { name: 'Short (Sell)' }));
    expect(screen.getByLabelText('Entry Price')).toHaveValue('');

    // Re-enter price under short direction
    await fillEntry(user, '5500');
    // Short: +1 tick exit is BELOW entry
    expect(screen.getByText('5,499.75')).toBeInTheDocument();
  });

  it('short direction gives a loss when price rises', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    // Start as short, then enter prices
    await user.click(screen.getByRole('button', { name: 'Short (Sell)' }));
    await fillEntry(user, '5500');
    await fillExit(user, '5510');

    // Short with price rising: gross -$500 (adverse move)
    expect(screen.getByText('-$500.00')).toBeInTheDocument();
    expect(screen.getByText('-$505.76')).toBeInTheDocument();
  });
});

// ── Tick ladder (entry only) ──────────────────────────────────────────────────

describe('FuturesCalculator — tick ladder', () => {
  it('shows tick ladder when entry is entered but exit is empty', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');

    expect(screen.getByText(/Tick ladder/i)).toBeInTheDocument();
    expect(screen.getByText(/Break-even/i)).toBeInTheDocument();
  });

  it('shows all 9 tick steps', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');

    // TICK_STEPS = [1, 2, 4, 6, 8, 10, 12, 16, 20]
    for (const t of [
      '+1',
      '+2',
      '+4',
      '+6',
      '+8',
      '+10',
      '+12',
      '+16',
      '+20',
    ]) {
      expect(screen.getByText(t)).toBeInTheDocument();
    }
  });

  it('shows correct ES break-even price (entry + round-trip fees in points)', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    // break-even = 5500 + 3.18/50 = 5500.0636
    expect(screen.getByText('5,500.12')).toBeInTheDocument();
  });

  it('hides tick ladder when both entry and exit are entered', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    await fillExit(user, '5510');

    expect(screen.queryByText(/Tick ladder/i)).not.toBeInTheDocument();
  });

  it('round-trip fee note reflects contract count', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    // Increment from 1 → 3
    const inc = screen.getByRole('button', { name: 'Increase contracts' });
    await user.click(inc);
    await user.click(inc);

    // 3× $2.88 each side → total -$17.28
    expect(screen.getByText('-$17.28')).toBeInTheDocument();
  });
});

// ── Full P&L results (entry + exit) ──────────────────────────────────────────

describe('FuturesCalculator — full P&L results', () => {
  it('shows trade results panel when both prices are entered', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    await fillExit(user, '5510');

    expect(screen.getByText(/Trade Results/)).toBeInTheDocument();
  });

  it('shows correct gross P&L for ES long 10-point win', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    await fillExit(user, '5510');

    expect(screen.getByText('+$500.00')).toBeInTheDocument();
  });

  it('shows correct net P&L after fees', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    await fillExit(user, '5510');

    // Net = $500 - $3.18 = $496.82
    expect(screen.getByText('+$494.24')).toBeInTheDocument();
  });

  it('shows buy-side and sell-side fee rows', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    await fillExit(user, '5510');

    expect(screen.getByText(/Buy-side fees/)).toBeInTheDocument();
    expect(screen.getByText(/Sell-side fees/)).toBeInTheDocument();
    expect(screen.getByText(/Total round-trip fees/)).toBeInTheDocument();
  });

  it('shows day margin required', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    await fillExit(user, '5510');

    expect(screen.getByText('Day margin required')).toBeInTheDocument();
    // ES 1 contract: $500
    expect(screen.getByText('$500.00')).toBeInTheDocument();
  });

  it('shows return on margin', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    await fillExit(user, '5510');

    expect(screen.getByText('Return on margin')).toBeInTheDocument();
    // ROM = 496.82 / 500 * 100 = 99.36%
    expect(screen.getByText('+98.85%')).toBeInTheDocument();
  });

  it('shows points and ticks moved', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    await fillExit(user, '5510');

    expect(screen.getByText('+10.00 pts')).toBeInTheDocument();
    expect(screen.getByText('+40 ticks')).toBeInTheDocument();
  });

  it('shows negative net P&L for a losing trade', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5510');
    await fillExit(user, '5500');

    // Long with price falling: gross -$500, net -$505.76
    expect(screen.getByText('-$505.76')).toBeInTheDocument();
  });

  it('NQ results use correct $20/point multiplier', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await user.click(screen.getByRole('button', { name: 'NQ' }));
    await fillEntry(user, '21000');
    await fillExit(user, '21010');

    // 10 pts × $20 = $200 gross, net = $200 - $3.18 = $196.82
    expect(screen.getByText('+$200.00')).toBeInTheDocument();
    expect(screen.getByText('+$194.24')).toBeInTheDocument();
  });

  it('scales correctly with 2 contracts', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    await fillExit(user, '5510');
    await user.click(
      screen.getByRole('button', { name: 'Increase contracts' }),
    );

    // 2 contracts: gross $1000, fees $11.52, net $988.48
    expect(screen.getByText('+$1,000.00')).toBeInTheDocument();
    expect(screen.getByText('+$988.48')).toBeInTheDocument();
    expect(screen.getByText('$1,000.00')).toBeInTheDocument(); // margin (2 × $500)
  });

  it('trade results header shows plural for multiple contracts', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    await fillExit(user, '5510');
    const inc = screen.getByRole('button', { name: 'Increase contracts' });
    await user.click(inc);
    await user.click(inc);

    expect(screen.getByText(/3 contracts/)).toBeInTheDocument();
  });

  it('trade results header shows singular for 1 contract', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    await fillExit(user, '5510');

    // JSX splits text nodes; match on the exact div textContent
    const header = screen.getByText(
      (_, node) =>
        node?.tagName === 'DIV' &&
        node?.textContent?.trim() === 'Trade Results · 1 contract',
    );
    expect(header).toBeInTheDocument();
  });
});

// ── Clear button ──────────────────────────────────────────────────────────────

describe('FuturesCalculator — Clear button', () => {
  it('clears entry, exit, and adverse price inputs', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    await fillExit(user, '5510');
    await user.click(screen.getByRole('button', { name: 'Clear' }));

    expect(screen.getByLabelText('Entry Price')).toHaveValue('');
    expect(screen.getByLabelText('Exit Price')).toHaveValue('');
  });

  it('resets contracts to 1', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    const inc = screen.getByRole('button', { name: 'Increase contracts' });
    await user.click(inc);
    await user.click(inc);
    await user.click(inc);
    await user.click(inc);
    await user.click(screen.getByRole('button', { name: 'Clear' }));

    expect(screen.getByTestId('fc-contracts-display')).toHaveTextContent('1');
  });

  it('returns to empty state after clearing', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    await fillExit(user, '5510');
    await user.click(screen.getByRole('button', { name: 'Clear' }));

    expect(screen.getByText(/Enter an entry price/)).toBeInTheDocument();
  });
});

// ── Contracts stepper ────────────────────────────────────────────────────────

describe('FuturesCalculator — contracts stepper', () => {
  it('increments on + click', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await user.click(
      screen.getByRole('button', { name: 'Increase contracts' }),
    );

    expect(screen.getByTestId('fc-contracts-display')).toHaveTextContent('2');
  });

  it('decrements on − click but does not go below 1', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await user.click(
      screen.getByRole('button', { name: 'Decrease contracts' }),
    );

    expect(screen.getByTestId('fc-contracts-display')).toHaveTextContent('1');
  });

  it('decrements correctly from 3 → 2', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    const inc = screen.getByRole('button', { name: 'Increase contracts' });
    await user.click(inc);
    await user.click(inc);
    await user.click(
      screen.getByRole('button', { name: 'Decrease contracts' }),
    );

    expect(screen.getByTestId('fc-contracts-display')).toHaveTextContent('2');
  });
});

// ── Fee display accuracy ──────────────────────────────────────────────────────

describe('FuturesCalculator — fee display', () => {
  it('spec bar shows $2.88 fee per side', () => {
    render(<FuturesCalculator />);
    expect(screen.getByText('$2.88')).toBeInTheDocument();
  });

  it('fee rows display -$2.88 each for 1-contract ES trade', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    await fillExit(user, '5510');

    // Two fee rows: buy-side and sell-side, each -$2.88
    const feeAmounts = screen.getAllByText('-$2.88');
    expect(feeAmounts).toHaveLength(2);
  });

  it('round-trip total fee row shows -$5.76 for 1 contract', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    await fillExit(user, '5510');

    expect(screen.getByText('-$5.76')).toBeInTheDocument();
  });
});

// ── Adverse excursion ─────────────────────────────────────────────────────────

describe('FuturesCalculator — adverse excursion', () => {
  it('shows "Adverse / Stop (Low)" label when Long', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');

    expect(screen.getByLabelText('Adverse / Stop (Low)')).toBeInTheDocument();
  });

  it('shows "Adverse / Stop (High)" label when Short', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    // Switch to short first, then enter price (direction change clears prices)
    await user.click(screen.getByRole('button', { name: 'Short (Sell)' }));
    await fillEntry(user, '5500');

    expect(screen.getByLabelText('Adverse / Stop (High)')).toBeInTheDocument();
  });

  it('does not show adverse input when no entry is provided', () => {
    render(<FuturesCalculator />);
    expect(
      screen.queryByLabelText('Adverse / Stop (Low)'),
    ).not.toBeInTheDocument();
  });

  it('shows MAE panel when adverse price is entered', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    await user.type(screen.getByLabelText('Adverse / Stop (Low)'), '5490');

    expect(screen.getByText(/Max Adverse Excursion/i)).toBeInTheDocument();
  });

  it('shows correct adverse net P&L for ES long (10-point adverse move)', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    // Long ES: entry 5500, lowest 5490 → -10 pts × $50 = -$500 gross, net -$505.76
    await fillEntry(user, '5500');
    await user.type(screen.getByLabelText('Adverse / Stop (Low)'), '5490');

    expect(screen.getByText('-$505.76')).toBeInTheDocument();
  });

  it('shows correct adverse gross exposure', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    // Long ES: entry 5500, lowest 5490 → -$500 gross
    await fillEntry(user, '5500');
    await user.type(screen.getByLabelText('Adverse / Stop (Low)'), '5490');

    expect(screen.getByText('-$500.00')).toBeInTheDocument();
  });

  it('shows adverse in points and ticks', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    // Long ES: entry 5500, lowest 5490 → -10.00 pts / -40 ticks
    await fillEntry(user, '5500');
    await user.type(screen.getByLabelText('Adverse / Stop (Low)'), '5490');

    expect(screen.getByText('-10.00 pts / -40 ticks')).toBeInTheDocument();
  });

  it('clears adverse input when Clear is clicked', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    await user.type(screen.getByLabelText('Adverse / Stop (Low)'), '5490');
    await user.click(screen.getByRole('button', { name: 'Clear' }));

    // After clear, adverse field is gone (entry cleared → entryValid=false)
    expect(
      screen.queryByLabelText('Adverse / Stop (Low)'),
    ).not.toBeInTheDocument();
  });

  it('shows correct adverse result for Short position', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await user.click(screen.getByRole('button', { name: 'Short (Sell)' }));
    await fillEntry(user, '5500');
    // Short ES: entry 5500, highest 5510 → -10 pts adverse → -$500 gross
    await user.type(screen.getByLabelText('Adverse / Stop (High)'), '5510');

    expect(screen.getByText('-$505.76')).toBeInTheDocument();
  });
});

// ── MFE (Favorable excursion) ─────────────────────────────────────────────────

describe('FuturesCalculator — favorable excursion (MFE)', () => {
  it('shows "Favorable / Target (High)" label when Long after entry', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');

    expect(
      screen.getByLabelText('Favorable / Target (High)'),
    ).toBeInTheDocument();
  });

  it('shows "Favorable / Target (Low)" label when Short after entry', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await user.click(screen.getByRole('button', { name: 'Short (Sell)' }));
    await fillEntry(user, '5500');

    expect(
      screen.getByLabelText('Favorable / Target (Low)'),
    ).toBeInTheDocument();
  });

  it('shows MFE panel when favorable price is entered', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    await user.type(screen.getByLabelText('Favorable / Target (High)'), '5520');

    expect(screen.getByText(/Max Favorable Excursion/i)).toBeInTheDocument();
  });

  it('shows correct MFE net P&L for ES long (20-point favorable move)', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    // Long ES: entry 5500, favorable 5520 → +20 pts × $50 = $1000 gross, net $994.24
    await fillEntry(user, '5500');
    await user.type(screen.getByLabelText('Favorable / Target (High)'), '5520');

    expect(screen.getByText('+$994.24')).toBeInTheDocument();
  });

  it('MFE panel shows in green', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    await user.type(screen.getByLabelText('Favorable / Target (High)'), '5520');

    expect(screen.getByText(/Max Favorable Excursion/i)).toBeInTheDocument();
    expect(screen.getByText('Net upside (after fees)')).toBeInTheDocument();
  });

  it('clears favorable input when Clear is clicked', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    await user.type(screen.getByLabelText('Favorable / Target (High)'), '5520');
    await user.click(screen.getByRole('button', { name: 'Clear' }));

    expect(
      screen.queryByLabelText('Favorable / Target (High)'),
    ).not.toBeInTheDocument();
  });
});

// ── R:R ratio ─────────────────────────────────────────────────────────────────

describe('FuturesCalculator — R:R ratio', () => {
  it('shows R:R in trade results when entry + exit + adverse all provided', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    await fillExit(user, '5520');
    await user.type(screen.getByLabelText('Adverse / Stop (Low)'), '5490');

    // reward 20 pts / risk 10 pts = 2.00:1
    expect(screen.getByText('2.00:1')).toBeInTheDocument();
  });

  it('does not show R:R without adverse price', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    await fillExit(user, '5520');

    expect(screen.queryByText(/Risk:Reward/)).not.toBeInTheDocument();
  });

  it('shows R:R label "Risk:Reward (vs stop)"', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    await fillExit(user, '5510');
    await user.type(screen.getByLabelText('Adverse / Stop (Low)'), '5490');

    expect(screen.getByText('Risk:Reward (vs stop)')).toBeInTheDocument();
  });
});

// ── Account settings ──────────────────────────────────────────────────────────

describe('FuturesCalculator — account settings', () => {
  it('renders Account Balance and Risk % inputs', () => {
    render(<FuturesCalculator />);
    expect(screen.getByLabelText('Account Balance')).toBeInTheDocument();
    expect(screen.getByLabelText('Risk % per Trade')).toBeInTheDocument();
  });

  it('shows derived max risk when account and risk % are entered', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    const accountInput = screen.getByLabelText('Account Balance');
    await user.clear(accountInput);
    await user.type(accountInput, '50000');
    // risk % field already has default "1" from localStorage/state init
    // $50,000 × 1% = $500
    expect(screen.getByText('$500.00')).toBeInTheDocument();
  });

  it('account balance is not cleared when Clear is clicked', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    const accountInput = screen.getByLabelText('Account Balance');
    await user.clear(accountInput);
    await user.type(accountInput, '50000');
    await fillEntry(user, '5500');
    await user.click(screen.getByRole('button', { name: 'Clear' }));

    expect(screen.getByLabelText('Account Balance')).toHaveValue('50000');
  });

  it('shows % of account in MAE panel when account is set', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    const accountInput = screen.getByLabelText('Account Balance');
    await user.clear(accountInput);
    await user.type(accountInput, '50000');
    await fillEntry(user, '5500');
    await user.type(screen.getByLabelText('Adverse / Stop (Low)'), '5490');

    // net MAE = -$505.76 / $50,000 = -1.01%
    expect(screen.getByText(/-1\.01% of account/)).toBeInTheDocument();
  });

  it('shows % of account in trade results when account is set', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    const accountInput = screen.getByLabelText('Account Balance');
    await user.clear(accountInput);
    await user.type(accountInput, '50000');
    await fillEntry(user, '5500');
    await fillExit(user, '5510');

    // net = +$494.24 / $50,000 = +0.99%
    expect(screen.getByText(/\+0\.99% of account/)).toBeInTheDocument();
  });
});

// ── Position sizing ───────────────────────────────────────────────────────────

describe('FuturesCalculator — position sizing', () => {
  it('shows position sizing panel when entry + adverse + account + risk% set', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    const accountInput = screen.getByLabelText('Account Balance');
    await user.clear(accountInput);
    await user.type(accountInput, '50000');
    await fillEntry(user, '5500');
    await user.type(screen.getByLabelText('Adverse / Stop (Low)'), '5490');

    expect(screen.getByText('Position Sizing')).toBeInTheDocument();
  });

  it('does not show position sizing without account balance', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    // Clear account (default state has empty account from localStorage mock)
    const accountInput = screen.getByLabelText('Account Balance');
    await user.clear(accountInput);

    await fillEntry(user, '5500');
    await user.type(screen.getByLabelText('Adverse / Stop (Low)'), '5490');

    expect(screen.queryByText('Position Sizing')).not.toBeInTheDocument();
  });

  it('shows "budget too small" when risk per contract exceeds budget', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    // ES, 10-pt stop: risk/contract = $505.76. Account $1000 × 0.01% = $0.10 → 0 contracts
    const accountInput = screen.getByLabelText('Account Balance');
    await user.clear(accountInput);
    await user.type(accountInput, '1000');

    const riskInput = screen.getByLabelText('Risk % per Trade');
    await user.clear(riskInput);
    await user.type(riskInput, '0.01');

    await fillEntry(user, '5500');
    await user.type(screen.getByLabelText('Adverse / Stop (Low)'), '5490');

    expect(
      screen.getByText('budget too small for 1 contract'),
    ).toBeInTheDocument();
  });

  it('hides position sizing panel when Clear is clicked (entry cleared)', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    const accountInput = screen.getByLabelText('Account Balance');
    await user.clear(accountInput);
    await user.type(accountInput, '50000');
    await fillEntry(user, '5500');
    await user.type(screen.getByLabelText('Adverse / Stop (Low)'), '5490');
    expect(screen.getByText('Position Sizing')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear' }));

    expect(screen.queryByText('Position Sizing')).not.toBeInTheDocument();
    // Account balance survives Clear
    expect(screen.getByLabelText('Account Balance')).toHaveValue('50000');
  });
});
