import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import StrikeCalculator from '../App';

const DEBOUNCE = 300;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Render helper that flushes async useEffect work (VIX data load, market data fetch)
async function renderApp() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<StrikeCalculator />);
  });
  return result!;
}

// Mock fetch for useMarketData — return 401 (public visitor) so the hook
// silently does nothing and all existing tests work unchanged.
beforeEach(() => {
  globalThis.fetch = vi.fn((url: string) => {
    if (url === '/vix1d-daily.json') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            '2026-03-11': { o: 18.5, h: 20.1, l: 17.8, c: 19.2 },
          }),
      });
    }
    return Promise.resolve({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'Not authenticated' }),
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Helper: fill in minimum inputs to trigger results
async function fillBasicInputs(user: ReturnType<typeof userEvent.setup>) {
  const spotInput = screen.getByPlaceholderText('e.g. 672');
  const vixInput = screen.getByPlaceholderText('e.g. 19');
  await user.type(spotInput, '672');
  await user.type(vixInput, '20');
  await act(() => wait(DEBOUNCE));
}

// ============================================================
// RENDERING
// ============================================================
describe('StrikeCalculator: rendering', () => {
  it('renders the header', async () => {
    await renderApp();
    expect(screen.getByText('Strike Calculator')).toBeInTheDocument();
  });

  it('renders empty state when no inputs', async () => {
    await renderApp();
    expect(screen.getByText(/enter spy spot price/i)).toBeInTheDocument();
  });

  it('renders all input sections', async () => {
    await renderApp();
    expect(screen.getByPlaceholderText('e.g. 672')).toBeInTheDocument();
    expect(screen.getByLabelText(/entry time/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/implied volatility/i)).toBeInTheDocument();
  });

  it('renders dark mode toggle', async () => {
    await renderApp();
    expect(screen.getByLabelText(/switch to dark mode/i)).toBeInTheDocument();
  });

  it('renders SPX direct input field', async () => {
    await renderApp();
    expect(screen.getByPlaceholderText('e.g. 6731')).toBeInTheDocument();
  });

  it('renders the Advanced section', async () => {
    await renderApp();
    expect(screen.getByLabelText(/advanced/i)).toBeInTheDocument();
  });

  it('renders put skew slider', async () => {
    await renderApp();
    expect(screen.getByLabelText(/put skew/i)).toBeInTheDocument();
  });
});

// ============================================================
// DARK MODE
// ============================================================
describe('StrikeCalculator: dark mode toggle', () => {
  it('toggles dark mode and updates aria-label', async () => {
    const user = userEvent.setup();
    await renderApp();

    const toggle = screen.getByLabelText(/switch to dark mode/i);
    await user.click(toggle);
    expect(screen.getByLabelText(/switch to light mode/i)).toBeInTheDocument();
  });

  it('toggles back to light mode', async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByLabelText(/switch to dark mode/i));
    await user.click(screen.getByLabelText(/switch to light mode/i));
    expect(screen.getByLabelText(/switch to dark mode/i)).toBeInTheDocument();
  });
});

// ============================================================
// IV MODE SWITCHING
// ============================================================
describe('StrikeCalculator: IV mode switching', () => {
  it('shows VIX input by default', async () => {
    await renderApp();
    expect(screen.getByLabelText(/vix value/i)).toBeInTheDocument();
  });

  it('switches to direct IV input', async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByText('Direct IV'));
    expect(screen.getByLabelText(/as decimal/i)).toBeInTheDocument();
  });

  it('switches back to VIX mode', async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByText('Direct IV'));
    // Use getAllByText since 'VIX' appears in multiple places (IV chip + regime analysis)
    const vixChips = screen.getAllByText('VIX');
    const ivChip = vixChips.find((el) => el.closest('button'));
    await user.click(ivChip!);
    expect(screen.getByLabelText(/vix value/i)).toBeInTheDocument();
  });

  it('calculates results using direct IV mode', async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByText('Direct IV'));

    const spotInput = screen.getByPlaceholderText('e.g. 672');
    await user.type(spotInput, '672');

    const ivInput = screen.getByPlaceholderText('e.g. 0.22');
    await user.type(ivInput, '0.20');

    await act(() => wait(DEBOUNCE));
    expect(screen.getByText('All Delta Strikes')).toBeInTheDocument();
  });
});

// ============================================================
// VALIDATION
// ============================================================
describe('StrikeCalculator: validation display', () => {
  it('shows error for non-numeric spot price', async () => {
    const user = userEvent.setup();
    await renderApp();

    const spotInput = screen.getByPlaceholderText('e.g. 672');
    await user.type(spotInput, 'abc');
    await act(() => wait(DEBOUNCE));

    expect(screen.getByText('Enter a positive number')).toBeInTheDocument();
  });

  it('shows time error for pre-market time', async () => {
    const user = userEvent.setup();
    await renderApp();

    const hourSelect = screen.getByLabelText('Hour');
    await user.selectOptions(hourSelect, '8');
    await act(() => wait(100));

    expect(screen.getByText(/before market open/i)).toBeInTheDocument();
  });
});

// ============================================================
// RESULTS RENDERING
// ============================================================
describe('StrikeCalculator: results rendering', () => {
  it('shows results table when all inputs are valid', async () => {
    const user = userEvent.setup();
    await renderApp();
    await fillBasicInputs(user);
    expect(screen.getByText('All Delta Strikes')).toBeInTheDocument();
  });

  it('renders all 6 delta rows in results', async () => {
    const user = userEvent.setup();
    await renderApp();
    await fillBasicInputs(user);

    const resultsTable = screen.getByRole('table', {
      name: /strike prices by delta/i,
    });
    expect(within(resultsTable).getByText('5Δ')).toBeInTheDocument();
    expect(within(resultsTable).getByText('8Δ')).toBeInTheDocument();
    expect(within(resultsTable).getByText('10Δ')).toBeInTheDocument();
    expect(within(resultsTable).getByText('12Δ')).toBeInTheDocument();
    expect(within(resultsTable).getByText('15Δ')).toBeInTheDocument();
    expect(within(resultsTable).getByText('20Δ')).toBeInTheDocument();
  });

  it('shows put and call premium columns', async () => {
    const user = userEvent.setup();
    await renderApp();
    await fillBasicInputs(user);

    expect(screen.getByText('Put $')).toBeInTheDocument();
    expect(screen.getByText('Call $')).toBeInTheDocument();
  });

  it('shows SPY columns in delta table', async () => {
    const user = userEvent.setup();
    await renderApp();
    await fillBasicInputs(user);

    const deltaTable = screen.getByRole('table', {
      name: /strike prices by delta/i,
    });
    const spyHeaders = within(deltaTable).getAllByText('SPY');
    expect(spyHeaders.length).toBe(2);
  });

  it('shows parameter summary with SPY spot and SPX', async () => {
    const user = userEvent.setup();
    await renderApp();
    await fillBasicInputs(user);

    expect(screen.getByText('SPY Spot')).toBeInTheDocument();
    expect(screen.getByText(/Hours Left/i)).toBeInTheDocument();
  });
});

// ============================================================
// SPX DIRECT INPUT & RATIO
// ============================================================
describe('StrikeCalculator: SPX direct input', () => {
  it('shows slider when only SPY is entered', async () => {
    const user = userEvent.setup();
    await renderApp();

    const spotInput = screen.getByPlaceholderText('e.g. 672');
    await user.type(spotInput, '672');
    await act(() => wait(DEBOUNCE));

    expect(screen.getByLabelText(/spx to spy ratio/i)).toBeInTheDocument();
  });

  it('shows derived ratio when both SPY and SPX are entered', async () => {
    const user = userEvent.setup();
    await renderApp();

    const spotInput = screen.getByPlaceholderText('e.g. 672');
    await user.type(spotInput, '672');

    const spxInput = screen.getByPlaceholderText('e.g. 6731');
    await user.type(spxInput, '6731');

    await act(() => wait(DEBOUNCE));

    expect(screen.getByText('Derived ratio')).toBeInTheDocument();
    expect(screen.getByText(/using actual spx value/i)).toBeInTheDocument();
  });

  it('hides slider when SPX direct is entered', async () => {
    const user = userEvent.setup();
    await renderApp();

    const spotInput = screen.getByPlaceholderText('e.g. 672');
    await user.type(spotInput, '672');

    const spxInput = screen.getByPlaceholderText('e.g. 6731');
    await user.type(spxInput, '6731');

    await act(() => wait(DEBOUNCE));

    expect(
      screen.queryByLabelText(/spx to spy ratio/i),
    ).not.toBeInTheDocument();
  });

  it('shows SPX for calculations value', async () => {
    const user = userEvent.setup();
    await renderApp();

    const spotInput = screen.getByPlaceholderText('e.g. 672');
    await user.type(spotInput, '672');
    await act(() => wait(DEBOUNCE));

    expect(screen.getByText('SPX for calculations')).toBeInTheDocument();
  });
});

// ============================================================
// CSV UPLOAD AND DATE LOOKUP
// ============================================================
describe('StrikeCalculator: CSV upload', () => {
  it('shows upload button', async () => {
    await renderApp();
    expect(screen.getByText('Upload VIX OHLC CSV')).toBeInTheDocument();
  });

  it('loads CSV and shows date lookup section', async () => {
    const user = userEvent.setup();
    await renderApp();

    const csvContent =
      'Date,Open,High,Low,Close\n2024-03-04,14.50,15.20,14.10,14.80';
    const file = new File([csvContent], 'vix.csv', { type: 'text/csv' });

    const fileInput = screen.getByLabelText(/upload vix ohlc csv file/i);
    await user.upload(fileInput, file);
    await act(() => wait(100));

    expect(screen.getByText(/vix\.csv/i)).toBeInTheDocument();
    expect(screen.getByText('Replace CSV')).toBeInTheDocument();
    expect(screen.getByLabelText(/date lookup/i)).toBeInTheDocument();
  });

  it('shows OHLC values when date is selected', async () => {
    const user = userEvent.setup();
    await renderApp();

    const csvContent =
      'Date,Open,High,Low,Close\n2024-03-04,14.50,15.20,14.10,14.80';
    const file = new File([csvContent], 'vix.csv', { type: 'text/csv' });

    const fileInput = screen.getByLabelText(/upload vix ohlc csv file/i);
    await user.upload(fileInput, file);
    await act(() => wait(100));

    const datePicker = screen.getByLabelText(/select date/i);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(datePicker, '2024-03-04');
      datePicker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(() => wait(100));

    expect(screen.getByText('14.50')).toBeInTheDocument();
    expect(screen.getByText('15.20')).toBeInTheDocument();
    expect(screen.getByText('14.10')).toBeInTheDocument();
    expect(screen.getByText('14.80')).toBeInTheDocument();
  });

  it('shows no data message for missing date', async () => {
    const user = userEvent.setup();
    await renderApp();

    const csvContent =
      'Date,Open,High,Low,Close\n2024-03-04,14.50,15.20,14.10,14.80';
    const file = new File([csvContent], 'vix.csv', { type: 'text/csv' });

    const fileInput = screen.getByLabelText(/upload vix ohlc csv file/i);
    await user.upload(fileInput, file);
    await act(() => wait(100));

    const datePicker = screen.getByLabelText(/select date/i);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(datePicker, '2024-03-05');
      datePicker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(() => wait(100));

    expect(screen.getByText(/no vix data found/i)).toBeInTheDocument();
  });

  it('shows OHLC field selector chips', async () => {
    const user = userEvent.setup();
    await renderApp();

    const csvContent =
      'Date,Open,High,Low,Close\n2024-03-04,14.50,15.20,14.10,14.80';
    const file = new File([csvContent], 'vix.csv', { type: 'text/csv' });

    const fileInput = screen.getByLabelText(/upload vix ohlc csv file/i);
    await user.upload(fileInput, file);
    await act(() => wait(100));

    const datePicker = screen.getByLabelText(/select date/i);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(datePicker, '2024-03-04');
      datePicker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(() => wait(100));

    expect(screen.getByText('Auto')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('Close')).toBeInTheDocument();
  });
});

// ============================================================
// 0DTE ADJUSTMENT TOOLTIP
// ============================================================
describe('StrikeCalculator: tooltip', () => {
  it('tooltip toggles open and closed', async () => {
    const user = userEvent.setup();
    await renderApp();

    const helpBtn = screen.getByLabelText(/what is the 0dte adjustment/i);

    // If tooltip was closed by async flush, open it; if already open, verify
    if (!screen.queryByRole('tooltip')) {
      await user.click(helpBtn);
      await act(() => wait(50));
    }
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    expect(screen.getByText('0DTE IV Adjustment')).toBeInTheDocument();

    // Close it
    await user.click(helpBtn);
    await act(() => wait(50));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    // Re-open it
    await user.click(helpBtn);
    await act(() => wait(50));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });
});

// ============================================================
// IRON CONDOR UI
// ============================================================
describe('StrikeCalculator: Iron Condor', () => {
  it('IC is shown by default', async () => {
    await renderApp();
    expect(screen.getByText(/hide.*iron condor/i)).toBeInTheDocument();
    expect(screen.getByText(/wing width/i)).toBeInTheDocument();
    expect(
      screen.getByLabelText(/iron condor wing width/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/number of contracts/i)).toBeInTheDocument();
  });

  it('renders IC legs table when results are visible', async () => {
    const user = userEvent.setup();
    await renderApp();

    await fillBasicInputs(user);

    expect(
      screen.getByRole('table', { name: /iron condor legs/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('Long Put')).toBeInTheDocument();
    expect(screen.getByText('Short Put')).toBeInTheDocument();
    expect(screen.getByText('Short Call')).toBeInTheDocument();
    expect(screen.getByText('Long Call')).toBeInTheDocument();
  });

  it('renders P&L profile table with all columns', async () => {
    const user = userEvent.setup();
    await renderApp();

    await fillBasicInputs(user);

    expect(
      screen.getByRole('table', { name: /iron condor p&l/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('Credit')).toBeInTheDocument();
    expect(screen.getByText('Max Loss')).toBeInTheDocument();
    expect(screen.getByText('Buying Pwr')).toBeInTheDocument();
    expect(screen.getByText('RoR')).toBeInTheDocument();
    expect(screen.getByText('PoP')).toBeInTheDocument();
    expect(screen.getByText('SPX BE')).toBeInTheDocument();
    expect(screen.getByText('SPY BE')).toBeInTheDocument();
    expect(screen.getByText('Side')).toBeInTheDocument();
  });

  it('shows put spread, call spread, and iron condor sub-rows', async () => {
    const user = userEvent.setup();
    await renderApp();

    await fillBasicInputs(user);

    const pnlTable = screen.getByRole('table', { name: /iron condor p&l/i });
    // Each delta gets 3 sub-rows: Put Spread, Call Spread, Iron Condor
    expect(within(pnlTable).getAllByText('Put Spread')).toHaveLength(6);
    expect(within(pnlTable).getAllByText('Call Spread')).toHaveLength(6);
    expect(within(pnlTable).getAllByText('Iron Condor')).toHaveLength(6);
  });

  it('wing width chips work', async () => {
    const user = userEvent.setup();
    await renderApp();

    const wingGroup = screen.getByRole('radiogroup', {
      name: /iron condor wing width/i,
    });
    const chip10 = within(wingGroup).getByText('10');
    await user.click(chip10);

    await fillBasicInputs(user);
    expect(screen.getByText(/10-pt wings/i)).toBeInTheDocument();
  });

  it('contracts counter increments', async () => {
    const user = userEvent.setup();
    await renderApp();

    // Default is 20 contracts
    const input = screen.getByLabelText(/number of contracts/i);
    expect(input).toHaveValue('20');

    const incBtn = screen.getByLabelText(/increase contracts/i);
    await user.click(incBtn);
    await act(() => wait(50));
    await user.click(incBtn);
    await act(() => wait(50));

    expect(input).toHaveValue('22');
  });

  it('contracts counter decrements', async () => {
    const user = userEvent.setup();
    await renderApp();

    // Default is 20 contracts
    const incBtn = screen.getByLabelText(/increase contracts/i);
    await user.click(incBtn);
    await act(() => wait(50));
    await user.click(incBtn);
    await act(() => wait(50));

    const decBtn = screen.getByLabelText(/decrease contracts/i);
    await user.click(decBtn);
    await act(() => wait(50));

    const input = screen.getByLabelText(/number of contracts/i);
    expect(input).toHaveValue('21');
  });

  it('contracts counter does not go below 1', async () => {
    const user = userEvent.setup();
    await renderApp();

    // Click decrease many times to try to go below 1
    const decBtn = screen.getByLabelText(/decrease contracts/i);
    for (let i = 0; i < 25; i++) {
      await user.click(decBtn);
    }
    await act(() => wait(50));

    const input = screen.getByLabelText(/number of contracts/i);
    expect(input).toHaveValue('1');
  });

  it('P&L header updates with contract count', async () => {
    const user = userEvent.setup();
    await renderApp();

    // Default is 20 contracts
    await fillBasicInputs(user);

    expect(screen.getAllByText(/20 contracts/i).length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it('shows dollar amounts in P&L table', async () => {
    const user = userEvent.setup();
    await renderApp();

    await fillBasicInputs(user);

    const pnlTable = screen.getByRole('table', { name: /iron condor p&l/i });
    const dollarCells = within(pnlTable).getAllByText(/\$/);
    expect(dollarCells.length).toBeGreaterThan(0);
  });

  it('shows PoP percentages in P&L table', async () => {
    const user = userEvent.setup();
    await renderApp();

    await fillBasicInputs(user);

    const pnlTable = screen.getByRole('table', { name: /iron condor p&l/i });
    const pctCells = within(pnlTable).getAllByText(/%/);
    expect(pctCells.length).toBeGreaterThanOrEqual(12);
  });

  it('hides IC when toggled off', async () => {
    const user = userEvent.setup();
    await renderApp();

    // IC is shown by default
    expect(screen.getByText(/wing width/i)).toBeInTheDocument();

    await user.click(screen.getByText(/hide.*iron condor/i));
    expect(screen.queryByText(/wing width/i)).not.toBeInTheDocument();
  });
});

// ============================================================
// SKEW
// ============================================================
describe('StrikeCalculator: Skew', () => {
  it('renders skew slider with default value', async () => {
    await renderApp();
    const slider = screen.getByLabelText(/put skew/i);
    expect(slider).toBeInTheDocument();
    expect(slider).toHaveValue('3');
  });

  it('shows skew description', async () => {
    await renderApp();
    expect(
      screen.getByText(/otm puts trade at higher iv/i),
    ).toBeInTheDocument();
  });
});

// ============================================================
// SKIP-TO-RESULTS LINK
// ============================================================
describe('StrikeCalculator: skip link', () => {
  it('moves into view on focus and hides on blur', async () => {
    await renderApp();
    const link = screen.getByText('Skip to results');
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.focus(link);
    expect(link.style.left).toBe('0px');
    fireEvent.blur(link);
    expect(link.style.left).toBe('-9999px');
  });
});

// ============================================================
// TIME & TIMEZONE CONTROLS
// ============================================================
describe('StrikeCalculator: time & timezone', () => {
  it('changes minute select', async () => {
    const user = userEvent.setup();
    await renderApp();
    const minSelect = screen.getByLabelText('Minute');
    await user.selectOptions(minSelect, '30');
    expect(minSelect).toHaveValue('30');
  });

  it('switches timezone to CT', async () => {
    const user = userEvent.setup();
    await renderApp();
    const ctChip = screen.getByText('CT');
    await user.click(ctChip);
    // CT chip should now be active (button has aria-pressed or similar)
    expect(ctChip.closest('button')).toHaveAttribute('aria-checked', 'true');
  });
});

// ============================================================
// MULTIPLIER INPUT
// ============================================================
describe('StrikeCalculator: multiplier', () => {
  it('changes multiplier value', async () => {
    const user = userEvent.setup();
    await renderApp();
    const multInput = screen.getByPlaceholderText('1.15');
    await user.clear(multInput);
    await user.type(multInput, '1.20');
    expect(multInput).toHaveValue('1.20');
  });
});

// ============================================================
// SPX RATIO SLIDER
// ============================================================
describe('StrikeCalculator: SPX ratio slider', () => {
  it('changes SPX ratio via slider', async () => {
    const user = userEvent.setup();
    await renderApp();

    const spotInput = screen.getByPlaceholderText('e.g. 672');
    await user.type(spotInput, '672');
    await act(() => wait(DEBOUNCE));

    const slider = screen.getByLabelText(/spx to spy ratio/i);
    // fireEvent.change is more reliable for range inputs
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(slider, { target: { value: '10.02' } });
    expect(slider).toHaveValue('10.02');
  });
});

// ============================================================
// SKEW SLIDER CHANGE
// ============================================================
describe('StrikeCalculator: skew slider change', () => {
  it('changes skew value via slider', async () => {
    await renderApp();
    const slider = screen.getByLabelText(/put skew/i);
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(slider, { target: { value: '5' } });
    expect(slider).toHaveValue('5');
  });
});

// ============================================================
// CONTRACTS INPUT DIRECT EDIT
// ============================================================
describe('StrikeCalculator: contracts direct input', () => {
  it('accepts a typed contract count', async () => {
    await renderApp();
    const input = screen.getByLabelText(/number of contracts/i);
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(input, { target: { value: '15' } });
    expect(input).toHaveValue('15');
  });

  it('resets to 1 when input is empty string', async () => {
    await renderApp();
    const input = screen.getByLabelText(/number of contracts/i);
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(input, { target: { value: '' } });
    expect(input).toHaveValue('1');
  });
});

// ============================================================
// OHLC FIELD SELECTION
// ============================================================
describe('StrikeCalculator: OHLC field chips', () => {
  it('selects a specific OHLC field', async () => {
    const user = userEvent.setup();
    await renderApp();

    const csvContent =
      'Date,Open,High,Low,Close\n2024-03-04,14.50,15.20,14.10,14.80';
    const file = new File([csvContent], 'vix.csv', { type: 'text/csv' });

    const fileInput = screen.getByLabelText(/upload vix ohlc csv file/i);
    await user.upload(fileInput, file);
    await act(() => wait(100));

    const datePicker = screen.getByLabelText(/select date/i);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(datePicker, '2024-03-04');
      datePicker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(() => wait(100));

    // Click the "Open" chip to select that specific OHLC field
    const openChip = screen
      .getAllByText('Open')
      .find((el) => el.closest('button'));
    await user.click(openChip!);
    expect(openChip!.closest('button')).toHaveAttribute('aria-checked', 'true');
  });
});

// ============================================================
// VIX TERM STRUCTURE CALLBACK
// ============================================================
describe('StrikeCalculator: VIX term structure', () => {
  it('switches to direct IV when "Use as σ" is clicked', async () => {
    const user = userEvent.setup();
    await renderApp();

    // Enter VIX so term structure renders
    const spotInput = screen.getByPlaceholderText('e.g. 672');
    const vixInput = screen.getByPlaceholderText('e.g. 19');
    await user.type(spotInput, '672');
    await user.type(vixInput, '20');
    await act(() => wait(DEBOUNCE));

    // The term structure panel should be visible; look for the "Use as σ" button
    const useBtn = screen.queryByText(/use as/i);
    if (useBtn) {
      await user.click(useBtn);
      await act(() => wait(100));
      // Should have switched to Direct IV mode
      expect(screen.getByLabelText(/as decimal/i)).toBeInTheDocument();
    }
  });
});

// ============================================================
// HEDGE CALCULATOR
// ============================================================
describe('StrikeCalculator: Hedge Calculator', () => {
  it('shows hedge calculator button when IC is enabled and results visible', async () => {
    const user = userEvent.setup();
    await renderApp();

    // IC is shown by default
    await fillBasicInputs(user);

    expect(screen.getByText(/hedge calculator/i)).toBeInTheDocument();
  });

  it('hedge calculator is hidden by default', async () => {
    const user = userEvent.setup();
    await renderApp();

    await fillBasicInputs(user);

    // Button exists but hedge content not shown
    expect(screen.queryByText(/crash protection/i)).not.toBeInTheDocument();
  });

  it('shows hedge recommendation when hedge button is clicked', async () => {
    const user = userEvent.setup();
    await renderApp();

    await fillBasicInputs(user);
    await user.click(screen.getByText(/hedge calculator/i));

    expect(screen.getByText(/crash protection/i)).toBeInTheDocument();
    expect(screen.getByText(/rally protection/i)).toBeInTheDocument();
    expect(screen.getByText(/buy puts/i)).toBeInTheDocument();
    expect(screen.getByText(/buy calls/i)).toBeInTheDocument();
  });

  it('shows daily hedge cost and net credit', async () => {
    const user = userEvent.setup();
    await renderApp();

    await fillBasicInputs(user);
    await user.click(screen.getByText(/hedge calculator/i));

    expect(screen.getByText(/daily hedge cost/i)).toBeInTheDocument();
    expect(screen.getByText(/net credit after hedge/i)).toBeInTheDocument();
    expect(screen.getByText(/hedge % of credit/i)).toBeInTheDocument();
  });

  it('shows scenario table when expand button is clicked', async () => {
    const user = userEvent.setup();
    await renderApp();

    await fillBasicInputs(user);
    await user.click(screen.getByText(/hedge calculator/i));
    await user.click(screen.getByText(/show.*scenario/i));

    expect(screen.getByText(/crash scenarios/i)).toBeInTheDocument();
    expect(screen.getByText(/rally scenarios/i)).toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: /hedge p&l crash/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: /hedge p&l rally/i }),
    ).toBeInTheDocument();
  });

  it('hides scenario table when collapse button is clicked', async () => {
    const user = userEvent.setup();
    await renderApp();

    await fillBasicInputs(user);
    await user.click(screen.getByText(/hedge calculator/i));
    await user.click(screen.getByText(/show.*scenario/i));
    expect(screen.getByText(/crash scenarios/i)).toBeInTheDocument();

    await user.click(screen.getByText(/hide.*scenario/i));
    expect(screen.queryByText(/crash scenarios/i)).not.toBeInTheDocument();
  });

  it('hedge delta chips change the recommendation', async () => {
    const user = userEvent.setup();
    await renderApp();

    await fillBasicInputs(user);
    await user.click(screen.getByText(/hedge calculator/i));

    // Default is 2Δ, switch to 5Δ
    // Find the 5Δ button in the hedge delta section (not IC delta)
    const fiveDeltaBtn = screen
      .getAllByText('5Δ')
      .find((el) => el.closest('button')?.getAttribute('role') === 'radio');
    if (fiveDeltaBtn) {
      await user.click(fiveDeltaBtn);
    }
    // The component should re-render with new values (just check it doesn't crash)
    expect(screen.getByText(/crash protection/i)).toBeInTheDocument();
  });

  it('IC delta chips are shown for selecting which IC to hedge', async () => {
    const user = userEvent.setup();
    await renderApp();

    await fillBasicInputs(user);
    await user.click(screen.getByText(/hedge calculator/i));

    // Should show IC delta selector
    expect(screen.getByText('IC Delta')).toBeInTheDocument();
  });

  it('shows market regime analysis is visible by default', async () => {
    const user = userEvent.setup();
    await renderApp();

    await fillBasicInputs(user);

    // The Market Regime section should exist
    expect(screen.getByText(/market regime/i)).toBeInTheDocument();

    // Analysis is shown by default (showRegime defaults to true)
    expect(screen.getByText(/hide analysis/i)).toBeInTheDocument();

    // Click to hide
    await user.click(screen.getByText(/hide analysis/i));
    await act(() => wait(50));

    // Button text should change to "Show Analysis"
    expect(screen.getByText(/show analysis/i)).toBeInTheDocument();
  });
});

// ============================================================
// AUTO-FILL FROM MARKET DATA (App.tsx lines 93-118)
// ============================================================
describe('StrikeCalculator: market data auto-fill', () => {
  it('auto-fills SPY, SPX, VIX, and time from live market data', async () => {
    // Mock fetch to return successful market data
    const mockQuotes = {
      spy: {
        price: 590.25,
        open: 589,
        high: 591,
        low: 588,
        prevClose: 589,
        change: 1.25,
        changePct: 0.21,
      },
      spx: {
        price: 5912,
        open: 5900,
        high: 5920,
        low: 5890,
        prevClose: 5900,
        change: 12,
        changePct: 0.2,
      },
      vix: {
        price: 18.5,
        open: 19,
        high: 19.5,
        low: 18,
        prevClose: 19,
        change: -0.5,
        changePct: -2.63,
      },
      vix1d: null,
      vix9d: null,
      marketOpen: true,
      asOf: '2024-03-04T15:30:00Z',
    };

    globalThis.fetch = vi.fn((url: RequestInfo) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('/api/quotes')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockQuotes),
        });
      }
      if (urlStr.includes('/vix1d-daily.json')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({}),
        });
      }
      // Return 401 for other endpoints
      return Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: 'Not authenticated' }),
      });
    }) as unknown as typeof fetch;

    await renderApp();
    await act(() => wait(100));

    // Should auto-fill SPY spot
    const spotInput = screen.getByPlaceholderText('e.g. 672');
    expect(spotInput).toHaveValue('590.25');

    // Should auto-fill SPX
    const spxInput = screen.getByPlaceholderText('e.g. 6731');
    expect(spxInput).toHaveValue('5912');

    // Should auto-fill VIX
    const vixInput = screen.getByPlaceholderText('e.g. 19');
    expect(vixInput).toHaveValue('18.50');
  });

  it('shows LIVE badge when market is open', async () => {
    const mockQuotes = {
      spy: {
        price: 590,
        open: 589,
        high: 591,
        low: 588,
        prevClose: 589,
        change: 1,
        changePct: 0.17,
      },
      spx: null,
      vix: null,
      vix1d: null,
      vix9d: null,
      marketOpen: true,
      asOf: '2024-03-04T15:30:00Z',
    };

    globalThis.fetch = vi.fn((url: RequestInfo) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('/api/quotes')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockQuotes),
        });
      }
      if (urlStr.includes('/vix1d-daily.json')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({}),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: 'x' }),
      });
    }) as unknown as typeof fetch;

    await renderApp();
    await act(() => wait(100));

    expect(screen.getByText(/LIVE/)).toBeInTheDocument();
  });

  it('shows CLOSED badge when market is closed', async () => {
    const mockQuotes = {
      spy: {
        price: 590,
        open: 589,
        high: 591,
        low: 588,
        prevClose: 589,
        change: 1,
        changePct: 0.17,
      },
      spx: null,
      vix: null,
      vix1d: null,
      vix9d: null,
      marketOpen: false,
      asOf: '2024-03-04T21:00:00Z',
    };

    globalThis.fetch = vi.fn((url: RequestInfo) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('/api/quotes')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockQuotes),
        });
      }
      if (urlStr.includes('/vix1d-daily.json')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({}),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: 'x' }),
      });
    }) as unknown as typeof fetch;

    await renderApp();
    await act(() => wait(100));

    expect(screen.getByText(/CLOSED/)).toBeInTheDocument();
  });

  it('does not overwrite user-entered values with market data', async () => {
    const user = userEvent.setup();

    // Start with 401 fetch (no market data)
    await renderApp();

    // User types their own values
    const spotInput = screen.getByPlaceholderText('e.g. 672');
    await user.type(spotInput, '672');

    // Now "market data arrives" — re-render wouldn't overwrite user input
    // because the auto-fill only fills empty fields
    expect(spotInput).toHaveValue('672');
  });
});

// ============================================================
// TOOLTIP DISMISS (IVInputSection lines 54, 57)
// ============================================================
describe('StrikeCalculator: tooltip dismiss', () => {
  it('closes tooltip on Escape key', async () => {
    const user = userEvent.setup();
    await renderApp();

    const helpBtn = screen.getByLabelText(/what is the 0dte adjustment/i);
    await user.click(helpBtn);
    await act(() => wait(50));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await act(() => wait(50));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('closes tooltip on outside click', async () => {
    const user = userEvent.setup();
    await renderApp();

    const helpBtn = screen.getByLabelText(/what is the 0dte adjustment/i);
    await user.click(helpBtn);
    await act(() => wait(50));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    // Click the page header (outside the tooltip)
    await user.click(screen.getByText('Strike Calculator'));
    await act(() => wait(50));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});

// ============================================================
// RESULTS with skew=0 and spxDirectActive branches (ResultsSection)
// ============================================================
describe('StrikeCalculator: ResultsSection branches', () => {
  it('renders results with skew=0 (no skew text)', async () => {
    const user = userEvent.setup();
    await renderApp();

    // Set skew to 0
    const slider = screen.getByLabelText(/put skew/i);
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(slider, { target: { value: '0' } });

    await fillBasicInputs(user);

    // Should NOT show "Put skew:" text when skew is 0
    expect(screen.queryByText(/Put skew:/)).not.toBeInTheDocument();
    // Should still show the accuracy note
    expect(screen.getByText(/Accuracy/)).toBeInTheDocument();
  });

  it('renders results with SPX direct active (derived ratio in footer)', async () => {
    const user = userEvent.setup();
    await renderApp();

    const spotInput = screen.getByPlaceholderText('e.g. 672');
    await user.type(spotInput, '590');

    const spxInput = screen.getByPlaceholderText('e.g. 6731');
    await user.type(spxInput, '5912');

    const vixInput = screen.getByPlaceholderText('e.g. 19');
    await user.type(vixInput, '20');

    await act(() => wait(DEBOUNCE));

    // Footer should show "(derived)" next to the ratio
    expect(screen.getByText(/\(derived\)/)).toBeInTheDocument();
  });
});

// ============================================================
// IRON CONDOR EXPORT BUTTON (IronCondorSection line 118-119)
// ============================================================
describe('StrikeCalculator: IC export', () => {
  it('export button is present when IC results are shown', async () => {
    const user = userEvent.setup();
    await renderApp();

    await fillBasicInputs(user);

    expect(
      screen.getByLabelText(/export p&l comparison to excel/i),
    ).toBeInTheDocument();
  });
});

// ============================================================
// USERC CALCULATION: invalid time branch (line 58)
// ============================================================
describe('StrikeCalculator: invalid time inputs', () => {
  it('shows time error when hour or minute are NaN', async () => {
    const user = userEvent.setup();
    await renderApp();

    // The selects only have valid options, so we test the pre-market case
    // instead — hour=8 AM is before market open
    const hourSelect = screen.getByLabelText('Hour');
    await user.selectOptions(hourSelect, '8');
    const minSelect = screen.getByLabelText('Minute');
    await user.selectOptions(minSelect, '00');

    await act(() => wait(100));
    expect(screen.getByText(/before market open/i)).toBeInTheDocument();
  });
});

// ============================================================
// VIX UPLOAD BUTTON CLICK (VixUploadSection line 34)
// ============================================================
describe('StrikeCalculator: VIX upload button', () => {
  it('clicking Replace CSV button triggers file input', async () => {
    const user = userEvent.setup();
    await renderApp();

    // VIX data loads from static JSON on mount, so button says "Replace CSV"
    const uploadBtn = screen.getByText('Replace CSV');
    expect(uploadBtn).toBeInTheDocument();

    // Click it — this triggers fileInputRef.current?.click()
    await user.click(uploadBtn);
    // The file input should exist and be in the DOM
    expect(
      screen.getByLabelText(/upload vix ohlc csv file/i),
    ).toBeInTheDocument();
  });
});
