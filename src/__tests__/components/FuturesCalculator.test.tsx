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

  it('renders ES and NQ symbol chips', () => {
    render(<FuturesCalculator />);
    expect(screen.getByRole('button', { name: 'ES' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'NQ' })).toBeInTheDocument();
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

  it('switching symbol updates tick ladder values', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');

    // ES 1-tick gross = $12.50
    expect(screen.getByText('+$12.50')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'NQ' }));
    // NQ 1-tick gross = $5.00
    expect(screen.getByText('+$5.00')).toBeInTheDocument();
  });
});

// ── Direction toggle ──────────────────────────────────────────────────────────

describe('FuturesCalculator — direction toggle', () => {
  it('switching to short changes exit price direction in tick ladder', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    // Long: exit for +1 tick = 5500.25
    expect(screen.getByText('5,500.25')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Short (Sell)' }));
    // Short: exit for +1 tick = 5499.75
    expect(screen.getByText('5,499.75')).toBeInTheDocument();
  });

  it('switching to short flips full P&L sign', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    await fillExit(user, '5510');

    // Long: price rose 10pts → gross +$500
    expect(screen.getByText('+$500.00')).toBeInTheDocument();

    // Switch to short: same prices → now a loss
    await user.click(screen.getByRole('button', { name: 'Short (Sell)' }));
    // Gross = -$500, net = -$503.18
    expect(screen.getByText('-$500.00')).toBeInTheDocument();
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
    expect(screen.getByText('5,500.06')).toBeInTheDocument();
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

    // 3× $1.59 each side → total -$9.54
    expect(screen.getByText('-$9.54')).toBeInTheDocument();
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
    expect(screen.getByText('+$496.82')).toBeInTheDocument();
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
    expect(screen.getByText('+99.36%')).toBeInTheDocument();
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

    // Long with price falling: gross -$500, net -$503.18
    expect(screen.getByText('-$503.18')).toBeInTheDocument();
  });

  it('NQ results use correct $20/point multiplier', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await user.click(screen.getByRole('button', { name: 'NQ' }));
    await fillEntry(user, '21000');
    await fillExit(user, '21010');

    // 10 pts × $20 = $200 gross, net = $200 - $3.18 = $196.82
    expect(screen.getByText('+$200.00')).toBeInTheDocument();
    expect(screen.getByText('+$196.82')).toBeInTheDocument();
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
    expect(screen.getByText('+$993.64')).toBeInTheDocument();
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
  it('clears entry and exit price inputs', async () => {
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
  it('spec bar shows $1.59 fee per side', () => {
    render(<FuturesCalculator />);
    expect(screen.getByText('$1.59')).toBeInTheDocument();
  });

  it('fee rows display -$1.59 each for 1-contract ES trade', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    await fillExit(user, '5510');

    // Two fee rows: buy-side and sell-side, each -$1.59
    const feeAmounts = screen.getAllByText('-$1.59');
    expect(feeAmounts).toHaveLength(2);
  });

  it('round-trip total fee row shows -$3.18 for 1 contract', async () => {
    const user = userEvent.setup();
    render(<FuturesCalculator />);

    await fillEntry(user, '5500');
    await fillExit(user, '5510');

    expect(screen.getByText('-$3.18')).toBeInTheDocument();
  });
});
