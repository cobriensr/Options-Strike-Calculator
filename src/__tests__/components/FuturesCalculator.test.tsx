import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

  it('renders entry, exit, and contracts inputs', () => {
    render(<FuturesCalculator />);
    expect(screen.getByLabelText('Entry Price')).toBeInTheDocument();
    expect(screen.getByLabelText('Exit Price')).toBeInTheDocument();
    expect(screen.getByLabelText('Contracts')).toBeInTheDocument();
  });

  it('shows empty state when no entry is provided', () => {
    render(<FuturesCalculator />);
    expect(screen.getByText(/Enter an entry price/)).toBeInTheDocument();
  });

  it('contracts input defaults to 1', () => {
    render(<FuturesCalculator />);
    expect(screen.getByLabelText('Contracts')).toHaveValue(1);
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
    fireEvent.change(screen.getByLabelText('Contracts'), {
      target: { value: '3' },
    });

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
    fireEvent.change(screen.getByLabelText('Contracts'), {
      target: { value: '2' },
    });

    // 2 contracts: gross $1000, fees $6.36, net $993.64
    expect(screen.getByText('+$1,000.00')).toBeInTheDocument();
    expect(screen.getByText('+$988.48')).toBeInTheDocument();
    expect(screen.getByText('$1,000.00')).toBeInTheDocument(); // margin (2 × $500)
  });

  it('trade results header shows plural for multiple contracts', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    await fillExit(user, '5510');
    fireEvent.change(screen.getByLabelText('Contracts'), {
      target: { value: '3' },
    });

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

    fireEvent.change(screen.getByLabelText('Contracts'), {
      target: { value: '5' },
    });
    await user.click(screen.getByRole('button', { name: 'Clear' }));

    expect(screen.getByLabelText('Contracts')).toHaveValue(1);
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

// ── Contracts input ───────────────────────────────────────────────────────────

describe('FuturesCalculator — contracts input', () => {
  it('accepts a valid integer', () => {
    render(<FuturesCalculator />);
    fireEvent.change(screen.getByLabelText('Contracts'), {
      target: { value: '4' },
    });
    expect(screen.getByLabelText('Contracts')).toHaveValue(4);
  });

  it('resets to 1 when empty value is entered', () => {
    render(<FuturesCalculator />);
    fireEvent.change(screen.getByLabelText('Contracts'), {
      target: { value: '' },
    });
    expect(screen.getByLabelText('Contracts')).toHaveValue(1);
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
  it('shows "Lowest Price Reached" label when Long', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');

    expect(screen.getByLabelText('Lowest Price Reached')).toBeInTheDocument();
  });

  it('shows "Highest Price Reached" label when Short', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    // Switch to short first, then enter price (direction change clears prices)
    await user.click(screen.getByRole('button', { name: 'Short (Sell)' }));
    await fillEntry(user, '5500');

    expect(screen.getByLabelText('Highest Price Reached')).toBeInTheDocument();
  });

  it('does not show adverse input when no entry is provided', () => {
    render(<FuturesCalculator />);
    expect(
      screen.queryByLabelText('Lowest Price Reached'),
    ).not.toBeInTheDocument();
  });

  it('shows MAE panel when adverse price is entered', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    await user.type(screen.getByLabelText('Lowest Price Reached'), '5490');

    expect(screen.getByText(/Max Adverse Excursion/i)).toBeInTheDocument();
  });

  it('shows correct adverse net P&L for ES long (10-point adverse move)', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    // Long ES: entry 5500, lowest 5490 → -10 pts × $50 = -$500 gross, net -$505.76
    await fillEntry(user, '5500');
    await user.type(screen.getByLabelText('Lowest Price Reached'), '5490');

    expect(screen.getByText('-$505.76')).toBeInTheDocument();
  });

  it('shows correct adverse gross exposure', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    // Long ES: entry 5500, lowest 5490 → -$500 gross
    await fillEntry(user, '5500');
    await user.type(screen.getByLabelText('Lowest Price Reached'), '5490');

    expect(screen.getByText('-$500.00')).toBeInTheDocument();
  });

  it('shows adverse in points and ticks', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    // Long ES: entry 5500, lowest 5490 → -10.00 pts / -40 ticks
    await fillEntry(user, '5500');
    await user.type(screen.getByLabelText('Lowest Price Reached'), '5490');

    expect(screen.getByText('-10.00 pts / -40 ticks')).toBeInTheDocument();
  });

  it('clears adverse input when Clear is clicked', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    await user.type(screen.getByLabelText('Lowest Price Reached'), '5490');
    await user.click(screen.getByRole('button', { name: 'Clear' }));

    // After clear, adverse field is gone (entry cleared → entryValid=false)
    expect(
      screen.queryByLabelText('Lowest Price Reached'),
    ).not.toBeInTheDocument();
  });

  it('shows correct adverse result for Short position', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await user.click(screen.getByRole('button', { name: 'Short (Sell)' }));
    await fillEntry(user, '5500');
    // Short ES: entry 5500, highest 5510 → -10 pts adverse → -$500 gross
    await user.type(screen.getByLabelText('Highest Price Reached'), '5510');

    expect(screen.getByText('-$505.76')).toBeInTheDocument();
  });
});
