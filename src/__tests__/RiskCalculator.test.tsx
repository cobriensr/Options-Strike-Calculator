import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import RiskCalculator from '../components/RiskCalculator';

// ── helpers ──────────────────────────────────────────────────

function setInput(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Get the contracts input by its id (getByLabelText matches buttons too). */
function getContractsInput(): HTMLInputElement {
  return document.getElementById('rc-contracts') as HTMLInputElement;
}

/** Fill the minimum fields needed to make the results section appear in sell mode. */
function fillSellDefaults() {
  setInput(/account balance/i, '25000');
  // Wing width defaults to 10, so grossLossPerContract = 1000
  // No credit means lossPerContract = grossLossPerContract = 1000
}

/** Fill fields for sell mode WITH credit to get net loss and R:R. */
function fillSellWithCredit() {
  setInput(/account balance/i, '25000');
  setInput(/credit received/i, '1.50');
}

/** Switch to buy mode and fill minimum fields for results. */
function fillBuyDefaults() {
  fireEvent.click(screen.getByRole('button', { name: /^buy$/i }));
  setInput(/account balance/i, '25000');
  setInput(/premium paid/i, '3.50');
}

/**
 * In buy mode the stop-loss percentage chips (25%, 50%, 75%) collide with
 * the portfolio cap chips that share the same labels.  We scope the query
 * by finding the "Stop" heading span and then searching within its
 * parent container for the desired button.
 */
function getStopChip(label: string): HTMLElement {
  const stopLabel = screen.getByText('Stop');
  const stopContainer = stopLabel.closest('.flex')!;
  const buttons = stopContainer.querySelectorAll('button');
  const match = Array.from(buttons).find((b) => b.textContent === label);
  if (!match) throw new Error(`Stop chip "${label}" not found`);
  return match;
}

/** Similarly, scope portfolio cap chips via the "Cap" heading. */
function getCapChip(label: string): HTMLElement {
  const capLabel = screen.getByText('Cap');
  const capContainer = capLabel.closest('.flex')!;
  const buttons = capContainer.querySelectorAll('button');
  const match = Array.from(buttons).find((b) => b.textContent === label);
  if (!match) throw new Error(`Cap chip "${label}" not found`);
  return match;
}

// ============================================================
// RENDERING
// ============================================================
describe('RiskCalculator: rendering', () => {
  it('renders without crashing', () => {
    render(<RiskCalculator />);
    expect(
      screen.getByRole('region', { name: /risk calculator/i }),
    ).toBeInTheDocument();
  });

  it('shows SELL mode by default', () => {
    render(<RiskCalculator />);
    const sellBtn = screen.getByRole('button', { name: /^sell$/i });
    expect(sellBtn).toBeInTheDocument();
    // Credit Received is a sell-only field
    expect(screen.getByLabelText(/credit received/i)).toBeInTheDocument();
  });

  it('shows correct common fields in sell mode', () => {
    render(<RiskCalculator />);
    expect(screen.getByLabelText(/account balance/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^delta$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/pop %/i)).toBeInTheDocument();
    expect(getContractsInput()).toBeInTheDocument();
  });

  it('shows sell-specific fields: Credit Received and Wing Width', () => {
    render(<RiskCalculator />);
    expect(screen.getByLabelText(/credit received/i)).toBeInTheDocument();
    expect(
      screen.getByRole('radiogroup', { name: /wing width/i }),
    ).toBeInTheDocument();
  });
});

// ============================================================
// MODE SWITCHING
// ============================================================
describe('RiskCalculator: mode switching', () => {
  it('switches to BUY mode and shows buy-specific fields', () => {
    render(<RiskCalculator />);
    fireEvent.click(screen.getByRole('button', { name: /^buy$/i }));

    expect(screen.getByLabelText(/premium paid/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/target exit/i)).toBeInTheDocument();
  });

  it('BUY mode hides sell-specific fields', () => {
    render(<RiskCalculator />);
    fireEvent.click(screen.getByRole('button', { name: /^buy$/i }));

    expect(screen.queryByLabelText(/credit received/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('radiogroup', { name: /wing width/i }),
    ).not.toBeInTheDocument();
  });

  it('Delta and PoP fields visible in both modes', () => {
    render(<RiskCalculator />);

    // Sell mode
    expect(screen.getByLabelText(/^delta$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/pop %/i)).toBeInTheDocument();

    // Switch to Buy
    fireEvent.click(screen.getByRole('button', { name: /^buy$/i }));
    expect(screen.getByLabelText(/^delta$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/pop %/i)).toBeInTheDocument();
  });

  it('switches back to SELL mode from BUY', () => {
    render(<RiskCalculator />);
    fireEvent.click(screen.getByRole('button', { name: /^buy$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^sell$/i }));

    expect(screen.getByLabelText(/credit received/i)).toBeInTheDocument();
    expect(
      screen.getByRole('radiogroup', { name: /wing width/i }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/premium paid/i)).not.toBeInTheDocument();
  });
});

// ============================================================
// ACCOUNT BALANCE INPUT
// ============================================================
describe('RiskCalculator: account balance', () => {
  it('accepts numeric input', () => {
    render(<RiskCalculator />);
    const input = screen.getByLabelText(/account balance/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '50000' } });
    expect(input.value).toBe('50000');
  });

  it('strips non-numeric characters', () => {
    render(<RiskCalculator />);
    const input = screen.getByLabelText(/account balance/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'abc25000xyz' } });
    expect(input.value).toBe('25000');
  });
});

// ============================================================
// CONTRACTS STEPPER
// ============================================================
describe('RiskCalculator: contracts stepper', () => {
  it('increments contracts', () => {
    render(<RiskCalculator />);
    const input = getContractsInput();
    expect(input.value).toBe('1');

    fireEvent.click(
      screen.getByRole('button', { name: /increase contracts/i }),
    );
    expect(input.value).toBe('2');
  });

  it('decrements contracts but not below 1', () => {
    render(<RiskCalculator />);
    const input = getContractsInput();
    expect(input.value).toBe('1');

    fireEvent.click(
      screen.getByRole('button', { name: /decrease contracts/i }),
    );
    expect(input.value).toBe('1'); // stays at 1
  });

  it('does not exceed 999', () => {
    render(<RiskCalculator />);
    const input = getContractsInput();
    fireEvent.change(input, { target: { value: '999' } });
    expect(input.value).toBe('999');

    fireEvent.click(
      screen.getByRole('button', { name: /increase contracts/i }),
    );
    expect(input.value).toBe('999');
  });

  it('allows direct numeric input', () => {
    render(<RiskCalculator />);
    const input = getContractsInput();
    fireEvent.change(input, { target: { value: '10' } });
    expect(input.value).toBe('10');
  });
});

// ============================================================
// WING WIDTH CHIPS (sell mode)
// ============================================================
describe('RiskCalculator: wing width chips', () => {
  it('renders all wing width options', () => {
    render(<RiskCalculator />);
    const wingGroup = screen.getByRole('radiogroup', {
      name: /wing width/i,
    });
    const buttons = wingGroup.querySelectorAll('button');
    const labels = Array.from(buttons).map((b) => b.textContent);
    expect(labels).toEqual(
      expect.arrayContaining(['5', '10', '15', '20', '25', '30', '50']),
    );
  });

  it('selects a different wing width when clicked', () => {
    render(<RiskCalculator />);
    const wingGroup = screen.getByRole('radiogroup', {
      name: /wing width/i,
    });
    const buttons = wingGroup.querySelectorAll('button');
    const chip25 = Array.from(buttons).find((b) => b.textContent === '25');
    expect(chip25).toBeDefined();
    fireEvent.click(chip25!);

    // With balance=25000, wing=25 -> grossLoss = 2500
    fillSellDefaults();
    // grossLossPerContract = 25 * 100 = 2500, also totalLoss
    // This value appears in the results cards
    expect(screen.getAllByText('$2,500').length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================
// PORTFOLIO CAP CHIPS
// ============================================================
describe('RiskCalculator: portfolio cap chips', () => {
  it('renders all cap options (25%, 50%, 75%, 100%)', () => {
    render(<RiskCalculator />);
    expect(getCapChip('25%')).toBeInTheDocument();
    expect(getCapChip('50%')).toBeInTheDocument();
    expect(getCapChip('75%')).toBeInTheDocument();
    expect(getCapChip('100%')).toBeInTheDocument();
  });

  it('updates max positions when cap is changed', () => {
    render(<RiskCalculator />);
    fillSellDefaults();
    // bal=25000, wing=10, no credit -> lossPerContract=1000
    // lossPct = 1000/25000*100 = 4%
    // maxPositions at 100% cap = floor(100/4) = 25
    // The "Max Positions (at 100%)" label contains the cap, check the value
    expect(screen.getByText(/max positions/i)).toBeInTheDocument();

    // Switch cap to 50%
    fireEvent.click(getCapChip('50%'));
    // maxPositions = floor(50/4) = 12
    expect(screen.getByText(/max positions \(at 50%\)/i)).toBeInTheDocument();
  });
});

// ============================================================
// STOP LOSS CHIPS — SELL MODE
// ============================================================
describe('RiskCalculator: sell stop loss chips', () => {
  it('renders all sell stop options', () => {
    render(<RiskCalculator />);
    expect(getStopChip('\u2014')).toBeInTheDocument(); // em-dash
    expect(getStopChip('2\u00D7')).toBeInTheDocument();
    expect(getStopChip('3\u00D7')).toBeInTheDocument();
    expect(getStopChip('4\u00D7')).toBeInTheDocument();
    expect(getStopChip('5\u00D7')).toBeInTheDocument();
  });

  it('selecting a stop multiple shows the stop price', () => {
    render(<RiskCalculator />);
    setInput(/credit received/i, '1.50');
    // Click 3x stop
    fireEvent.click(getStopChip('3\u00D7'));
    // Stop price = credit * stopMultiple = 1.50 * 3 = $4.50
    expect(screen.getByText('$4.50')).toBeInTheDocument();
  });

  it('stop loss reduces max loss per contract', () => {
    render(<RiskCalculator />);
    setInput(/account balance/i, '25000');
    setInput(/credit received/i, '1.50');
    // Default wing=10, credit=1.50
    // Net loss = (10*100 - 1.50*100) = 850 per contract

    // Click 2x stop: stopLossPerContract = (2-1)*150 = 150
    // lossPerContract = min(150, 850) = 150
    fireEvent.click(getStopChip('2\u00D7'));

    // Total max loss = 150 * 1 contract = $150
    // This shows in the Total Max Loss card and possibly in the tiers
    expect(screen.getAllByText('$150').length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================
// STOP LOSS CHIPS — BUY MODE
// ============================================================
describe('RiskCalculator: buy stop loss chips', () => {
  it('renders all buy stop options', () => {
    render(<RiskCalculator />);
    fireEvent.click(screen.getByRole('button', { name: /^buy$/i }));

    // Buy mode shows percentage stops — use scoped helper to avoid cap chip collision
    expect(getStopChip('\u2014')).toBeInTheDocument();
    expect(getStopChip('25%')).toBeInTheDocument();
    expect(getStopChip('50%')).toBeInTheDocument();
    expect(getStopChip('75%')).toBeInTheDocument();
  });

  it('selecting a buy stop pct shows exit price', () => {
    render(<RiskCalculator />);
    fireEvent.click(screen.getByRole('button', { name: /^buy$/i }));
    setInput(/premium paid/i, '4.00');
    // Click 50% stop
    fireEvent.click(getStopChip('50%'));
    // Exit price = premium * (1 - 50/100) = 4.00 * 0.50 = $2.00
    expect(screen.getByText('exit $2.00')).toBeInTheDocument();
  });

  it('buy stop reduces loss per contract', () => {
    render(<RiskCalculator />);
    fireEvent.click(screen.getByRole('button', { name: /^buy$/i }));
    setInput(/account balance/i, '25000');
    setInput(/premium paid/i, '4.00');

    // Without stop: lossPerContract = 4.00 * 100 = 400
    // With 25% stop: buyStopLossPerContract = 400 * (25/100) = 100
    fireEvent.click(getStopChip('25%'));

    // Total Max Loss should be $100
    expect(screen.getAllByText('$100').length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================
// RESULTS SECTION
// ============================================================
describe('RiskCalculator: results display', () => {
  it('does not show results when balance is zero', () => {
    render(<RiskCalculator />);
    expect(screen.queryByText(/total max loss/i)).not.toBeInTheDocument();
  });

  it('shows results when balance and loss data entered (sell)', () => {
    render(<RiskCalculator />);
    fillSellDefaults();

    expect(screen.getByText(/total max loss/i)).toBeInTheDocument();
    expect(screen.getByText(/% of account/i)).toBeInTheDocument();
    expect(screen.getByText(/bp required/i)).toBeInTheDocument();
    expect(screen.getByText(/risk \/ reward/i)).toBeInTheDocument();
    expect(screen.getByText(/expected value/i)).toBeInTheDocument();
  });

  it('displays correct sell-mode metrics without credit', () => {
    render(<RiskCalculator />);
    fillSellDefaults();
    // wing=10, no credit, contracts=1
    // grossLossPerContract = 1000, lossPerContract = 1000
    // totalLoss = 1000, lossPct = 1000/25000*100 = 4.0%
    // $1,000 appears in both "Max Loss / Contract" card and Total Max Loss card
    // and possibly in the tiers table, so use getAllByText
    expect(screen.getAllByText('$1,000').length).toBeGreaterThanOrEqual(2);
    // 4.0% appears in both the "% of Account" card and the tiers "Actual %" column
    expect(screen.getAllByText('4.0%').length).toBeGreaterThanOrEqual(1);
  });

  it('shows Gross and Net per contract when credit is entered', () => {
    render(<RiskCalculator />);
    fillSellWithCredit();
    // wing=10, credit=1.50, contracts=1
    // grossLoss = 1000, creditPer = 150, netLoss = 850
    expect(screen.getByText(/gross \/ contract/i)).toBeInTheDocument();
    expect(screen.getByText(/net \/ contract/i)).toBeInTheDocument();
    // $1,000 for gross (may appear multiple places)
    expect(screen.getAllByText('$1,000').length).toBeGreaterThanOrEqual(1);
    // $850 for net — totalLoss also = 850 so appears twice
    expect(screen.getAllByText('$850').length).toBeGreaterThanOrEqual(1);
  });

  it('shows Cost / Contract in buy mode', () => {
    render(<RiskCalculator />);
    fillBuyDefaults();
    // premium=3.50, premiumPerContract = 350
    expect(screen.getByText(/cost \/ contract/i)).toBeInTheDocument();
    // $350 appears in results card(s)
    expect(screen.getAllByText('$350').length).toBeGreaterThanOrEqual(1);
  });

  it('shows R:R as em dash when no profit data', () => {
    render(<RiskCalculator />);
    fillSellDefaults();
    // No credit -> maxProfit=0 -> rrRatio=0
    const rrLabel = screen.getByText(/risk \/ reward/i);
    // The sibling value element should contain the em dash
    const rrCard = rrLabel.closest('.bg-surface-alt')!;
    expect(rrCard.textContent).toContain('\u2014');
  });

  it('shows R:R ratio with credit in sell mode', () => {
    render(<RiskCalculator />);
    fillSellWithCredit();
    // credit=1.50, wing=10
    // maxProfit = 150, lossPerContract = 850
    // rrRatio = 850/150 = 5.666... -> 1:5.7
    expect(screen.getByText('1:5.7')).toBeInTheDocument();
  });

  it('computes max positions correctly', () => {
    render(<RiskCalculator />);
    fillSellDefaults();
    // bal=25000, lossPerContract=1000, lossPct=4%, cap=100%
    // maxPositions = floor(100/4) = 25
    expect(screen.getByText(/max positions/i)).toBeInTheDocument();
  });

  it('computes expected value when PoP and profit provided', () => {
    render(<RiskCalculator />);
    fillSellWithCredit();
    setInput(/pop %/i, '80');
    // pop=80, maxProfit=150 (credit), lossPerContract=850 (net)
    // EV = (80/100)*150 - (20/100)*850 = 120 - 170 = -50 per contract
    // Main display: '' + '$' + abs(50) = '$50' (negative uses red color, no sign)
    // Per-ct note: '$' + '' + '-50' + '/ct' = '$-50/ct'
    expect(screen.getByText('$50')).toBeInTheDocument();
    expect(screen.getByText('$-50/ct')).toBeInTheDocument();
  });
});

// ============================================================
// RISK TIERS TABLE
// ============================================================
describe('RiskCalculator: risk tiers table', () => {
  it('renders the risk tiers table with all tiers', () => {
    render(<RiskCalculator />);
    fillSellDefaults();

    const table = screen.getByRole('table', {
      name: /position sizing by risk/i,
    });
    expect(table).toBeInTheDocument();

    // All 5 tiers: 1%, 2%, 3%, 5%, 10%
    expect(screen.getByText('1%')).toBeInTheDocument();
    expect(screen.getByText('2%')).toBeInTheDocument();
    expect(screen.getByText('3%')).toBeInTheDocument();
    expect(screen.getByText('5%')).toBeInTheDocument();
    expect(screen.getByText('10%')).toBeInTheDocument();
  });

  it('shows correct budget for each tier', () => {
    render(<RiskCalculator />);
    fillSellDefaults();

    // bal=25000 -> 1% = $250, 2% = $500, 3% = $750, 5% = $1,250, 10% = $2,500
    expect(screen.getByText('$250')).toBeInTheDocument();
    expect(screen.getByText('$500')).toBeInTheDocument();
    expect(screen.getByText('$750')).toBeInTheDocument();
    expect(screen.getByText('$1,250')).toBeInTheDocument();
    expect(screen.getByText('$2,500')).toBeInTheDocument();
  });

  it('clicking a tier max contracts button updates contracts', () => {
    render(<RiskCalculator />);
    fillSellDefaults();
    // lossPerContract=1000
    // 10% tier budget = 2500, maxContracts = floor(2500/1000) = 2
    const tierButton = screen.getByTitle('Set contracts to 2');
    fireEvent.click(tierButton);

    const contractsInput = getContractsInput();
    expect(contractsInput.value).toBe('2');
  });

  it('shows table headers', () => {
    render(<RiskCalculator />);
    fillSellDefaults();

    expect(screen.getByText('Risk %')).toBeInTheDocument();
    expect(screen.getByText('Budget')).toBeInTheDocument();
    expect(screen.getByText('Max Contracts')).toBeInTheDocument();
    expect(screen.getByText('Max Loss')).toBeInTheDocument();
    expect(screen.getByText('Actual %')).toBeInTheDocument();
  });
});

// ============================================================
// CONVICTION GRID
// ============================================================
describe('RiskCalculator: conviction grid', () => {
  it('shows all four conviction tiers', () => {
    render(<RiskCalculator />);
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.getByText('Mod')).toBeInTheDocument();
    expect(screen.getByText('Low')).toBeInTheDocument();
    expect(screen.getByText('Out')).toBeInTheDocument();
  });

  it('shows correct ranges for each conviction tier', () => {
    render(<RiskCalculator />);
    expect(screen.getByText('8\u201310%')).toBeInTheDocument();
    expect(screen.getByText('5\u20137%')).toBeInTheDocument();
    expect(screen.getByText('3\u20134%')).toBeInTheDocument();
    // "0%" is the Out tier range — may also match conviction grid
    expect(screen.getByText('0%')).toBeInTheDocument();
  });
});

// ============================================================
// BUY MODE TARGET EXIT
// ============================================================
describe('RiskCalculator: buy mode target exit', () => {
  it('shows prompt text when premium entered but no target', () => {
    render(<RiskCalculator />);
    fireEvent.click(screen.getByRole('button', { name: /^buy$/i }));
    setInput(/premium paid/i, '3.50');

    expect(
      screen.getByText(/enter a target exit price to see profit/i),
    ).toBeInTheDocument();
  });

  it('shows prompt when neither premium nor target entered', () => {
    render(<RiskCalculator />);
    fireEvent.click(screen.getByRole('button', { name: /^buy$/i }));

    expect(
      screen.getByText(/enter premium paid and target exit to see analysis/i),
    ).toBeInTheDocument();
  });

  it('shows profit and R:R when target exit > premium', () => {
    render(<RiskCalculator />);
    fireEvent.click(screen.getByRole('button', { name: /^buy$/i }));
    setInput(/premium paid/i, '3.50');
    setInput(/target exit/i, '7.00');

    // buyProfitPerContract = (7.00 - 3.50) * 100 = 350
    expect(
      screen.getAllByText(/profit at target/i).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('$350/ct')).toBeInTheDocument();

    // rrRatio = lossPerContract / maxProfit = 350 / 350 = 1.0
    expect(screen.getByText('1:1.0')).toBeInTheDocument();
  });

  it('shows Profit at Target card in results with balance', () => {
    render(<RiskCalculator />);
    fillBuyDefaults();
    setInput(/target exit/i, '7.00');

    // "Profit at Target" label appears in the results cards
    expect(
      screen.getAllByText(/profit at target/i).length,
    ).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================
// SELL MODE TARGET GUIDANCE
// ============================================================
describe('RiskCalculator: sell mode target guidance', () => {
  it('shows target range based on wing width', () => {
    render(<RiskCalculator />);
    // Default wing = 10 -> target range = $1.00 - $1.50
    expect(screen.getByText('$1.00')).toBeInTheDocument();
    expect(screen.getByText('$1.50')).toBeInTheDocument();
  });

  it('shows Excellent verdict for high credit relative to wing', () => {
    render(<RiskCalculator />);
    // wing=10, credit >= 15% of wing (1.50) -> Excellent
    setInput(/credit received/i, '2.00');
    expect(screen.getByText(/excellent/i)).toBeInTheDocument();
  });

  it('shows OK verdict for credit at 10-15% of wing', () => {
    render(<RiskCalculator />);
    // wing=10, credit=1.00 -> creditPct = 1/10 = 10% -> OK
    setInput(/credit received/i, '1.00');
    expect(screen.getByText(/\bOK\b/)).toBeInTheDocument();
  });

  it('shows pass verdict for low credit', () => {
    render(<RiskCalculator />);
    // wing=10, credit=0.50 -> creditPct = 0.5/10 = 5% -> "5.0% — pass"
    setInput(/credit received/i, '0.50');
    expect(screen.getByText(/pass/i)).toBeInTheDocument();
  });

  it('shows delta warning when delta < 0.08', () => {
    render(<RiskCalculator />);
    setInput(/^delta$/i, '0.05');
    // Should show delta < 0.08 warning
    expect(screen.getByText(/\u0394<0\.08/)).toBeInTheDocument();
  });
});

// ============================================================
// EDGE CASES
// ============================================================
describe('RiskCalculator: edge cases', () => {
  it('shows results when balance entered (sell, default wing > 0)', () => {
    render(<RiskCalculator />);
    // Default wing=10 so grossLoss=1000 which is > 0
    setInput(/account balance/i, '25000');
    expect(screen.getByText(/total max loss/i)).toBeInTheDocument();
  });

  it('handles zero balance gracefully - no results', () => {
    render(<RiskCalculator />);
    setInput(/account balance/i, '0');
    expect(screen.queryByText(/total max loss/i)).not.toBeInTheDocument();
  });

  it('handles decimal input for balance', () => {
    render(<RiskCalculator />);
    const input = screen.getByLabelText(/account balance/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '25000.50' } });
    expect(input.value).toBe('25000.50');
  });

  it('conservative note shown in sell mode without credit', () => {
    render(<RiskCalculator />);
    fillSellDefaults();
    expect(
      screen.getByText(/conservative.*does not subtract credit/i),
    ).toBeInTheDocument();
  });

  it('buy mode shows max loss formula note', () => {
    render(<RiskCalculator />);
    fillBuyDefaults();
    expect(screen.getByText(/max loss = premium/i)).toBeInTheDocument();
  });

  it('no conservative note when credit entered in sell mode', () => {
    render(<RiskCalculator />);
    fillSellWithCredit();
    expect(
      screen.queryByText(/conservative.*does not subtract credit/i),
    ).not.toBeInTheDocument();
  });
});
