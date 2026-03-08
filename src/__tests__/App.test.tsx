import { describe, it, expect } from 'vitest';
import { render, screen, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import StrikeCalculator from '../App';

const DEBOUNCE = 300;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  it('renders the header', () => {
    render(<StrikeCalculator />);
    expect(screen.getByText('Strike Calculator')).toBeInTheDocument();
  });

  it('renders empty state when no inputs', () => {
    render(<StrikeCalculator />);
    expect(screen.getByText(/enter spy spot price/i)).toBeInTheDocument();
  });

  it('renders all input sections', () => {
    render(<StrikeCalculator />);
    expect(screen.getByPlaceholderText('e.g. 672')).toBeInTheDocument();
    expect(screen.getByLabelText(/entry time/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/implied volatility/i)).toBeInTheDocument();
  });

  it('renders dark mode toggle', () => {
    render(<StrikeCalculator />);
    expect(screen.getByLabelText(/switch to dark mode/i)).toBeInTheDocument();
  });

  it('renders SPX direct input field', () => {
    render(<StrikeCalculator />);
    expect(screen.getByPlaceholderText('e.g. 6731')).toBeInTheDocument();
  });

  it('renders the Advanced section', () => {
    render(<StrikeCalculator />);
    expect(screen.getByLabelText(/advanced/i)).toBeInTheDocument();
  });

  it('renders put skew slider', () => {
    render(<StrikeCalculator />);
    expect(screen.getByLabelText(/put skew/i)).toBeInTheDocument();
  });
});

// ============================================================
// DARK MODE
// ============================================================
describe('StrikeCalculator: dark mode toggle', () => {
  it('toggles dark mode and updates aria-label', async () => {
    const user = userEvent.setup();
    render(<StrikeCalculator />);

    const toggle = screen.getByLabelText(/switch to dark mode/i);
    await user.click(toggle);
    expect(screen.getByLabelText(/switch to light mode/i)).toBeInTheDocument();
  });

  it('toggles back to light mode', async () => {
    const user = userEvent.setup();
    render(<StrikeCalculator />);

    await user.click(screen.getByLabelText(/switch to dark mode/i));
    await user.click(screen.getByLabelText(/switch to light mode/i));
    expect(screen.getByLabelText(/switch to dark mode/i)).toBeInTheDocument();
  });
});

// ============================================================
// IV MODE SWITCHING
// ============================================================
describe('StrikeCalculator: IV mode switching', () => {
  it('shows VIX input by default', () => {
    render(<StrikeCalculator />);
    expect(screen.getByLabelText(/vix value/i)).toBeInTheDocument();
  });

  it('switches to direct IV input', async () => {
    const user = userEvent.setup();
    render(<StrikeCalculator />);

    await user.click(screen.getByText('Direct IV'));
    expect(screen.getByLabelText(/as decimal/i)).toBeInTheDocument();
  });

  it('switches back to VIX mode', async () => {
    const user = userEvent.setup();
    render(<StrikeCalculator />);

    await user.click(screen.getByText('Direct IV'));
    await user.click(screen.getByText('VIX'));
    expect(screen.getByLabelText(/vix value/i)).toBeInTheDocument();
  });

  it('calculates results using direct IV mode', async () => {
    const user = userEvent.setup();
    render(<StrikeCalculator />);

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
    render(<StrikeCalculator />);

    const spotInput = screen.getByPlaceholderText('e.g. 672');
    await user.type(spotInput, 'abc');
    await act(() => wait(DEBOUNCE));

    expect(screen.getByText('Enter a positive number')).toBeInTheDocument();
  });

  it('shows time error for pre-market time', async () => {
    const user = userEvent.setup();
    render(<StrikeCalculator />);

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
    render(<StrikeCalculator />);
    await fillBasicInputs(user);
    expect(screen.getByText('All Delta Strikes')).toBeInTheDocument();
  });

  it('renders all 6 delta rows in results', async () => {
    const user = userEvent.setup();
    render(<StrikeCalculator />);
    await fillBasicInputs(user);

    expect(screen.getByText('5Δ')).toBeInTheDocument();
    expect(screen.getByText('8Δ')).toBeInTheDocument();
    expect(screen.getByText('10Δ')).toBeInTheDocument();
    expect(screen.getByText('12Δ')).toBeInTheDocument();
    expect(screen.getByText('15Δ')).toBeInTheDocument();
    expect(screen.getByText('20Δ')).toBeInTheDocument();
  });

  it('shows put and call premium columns', async () => {
    const user = userEvent.setup();
    render(<StrikeCalculator />);
    await fillBasicInputs(user);

    expect(screen.getByText('Put $')).toBeInTheDocument();
    expect(screen.getByText('Call $')).toBeInTheDocument();
  });

  it('shows SPY columns in delta table', async () => {
    const user = userEvent.setup();
    render(<StrikeCalculator />);
    await fillBasicInputs(user);

    const deltaTable = screen.getByRole('table', { name: /strike prices by delta/i });
    const spyHeaders = within(deltaTable).getAllByText('SPY');
    expect(spyHeaders.length).toBe(2);
  });

  it('shows parameter summary with SPY spot and SPX', async () => {
    const user = userEvent.setup();
    render(<StrikeCalculator />);
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
    render(<StrikeCalculator />);

    const spotInput = screen.getByPlaceholderText('e.g. 672');
    await user.type(spotInput, '672');
    await act(() => wait(DEBOUNCE));

    expect(screen.getByLabelText(/spx to spy ratio/i)).toBeInTheDocument();
  });

  it('shows derived ratio when both SPY and SPX are entered', async () => {
    const user = userEvent.setup();
    render(<StrikeCalculator />);

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
    render(<StrikeCalculator />);

    const spotInput = screen.getByPlaceholderText('e.g. 672');
    await user.type(spotInput, '672');

    const spxInput = screen.getByPlaceholderText('e.g. 6731');
    await user.type(spxInput, '6731');

    await act(() => wait(DEBOUNCE));

    expect(screen.queryByLabelText(/spx to spy ratio/i)).not.toBeInTheDocument();
  });

  it('shows SPX for calculations value', async () => {
    const user = userEvent.setup();
    render(<StrikeCalculator />);

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
  it('shows upload button', () => {
    render(<StrikeCalculator />);
    expect(screen.getByText('Upload VIX OHLC CSV')).toBeInTheDocument();
  });

  it('loads CSV and shows date lookup section', async () => {
    const user = userEvent.setup();
    render(<StrikeCalculator />);

    const csvContent = 'Date,Open,High,Low,Close\n2024-03-04,14.50,15.20,14.10,14.80';
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
    render(<StrikeCalculator />);

    const csvContent = 'Date,Open,High,Low,Close\n2024-03-04,14.50,15.20,14.10,14.80';
    const file = new File([csvContent], 'vix.csv', { type: 'text/csv' });

    const fileInput = screen.getByLabelText(/upload vix ohlc csv file/i);
    await user.upload(fileInput, file);
    await act(() => wait(100));

    const datePicker = screen.getByLabelText(/select date/i);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
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
    render(<StrikeCalculator />);

    const csvContent = 'Date,Open,High,Low,Close\n2024-03-04,14.50,15.20,14.10,14.80';
    const file = new File([csvContent], 'vix.csv', { type: 'text/csv' });

    const fileInput = screen.getByLabelText(/upload vix ohlc csv file/i);
    await user.upload(fileInput, file);
    await act(() => wait(100));

    const datePicker = screen.getByLabelText(/select date/i);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(datePicker, '2024-03-05');
      datePicker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(() => wait(100));

    expect(screen.getByText(/no vix data found/i)).toBeInTheDocument();
  });

  it('shows OHLC field selector chips', async () => {
    const user = userEvent.setup();
    render(<StrikeCalculator />);

    const csvContent = 'Date,Open,High,Low,Close\n2024-03-04,14.50,15.20,14.10,14.80';
    const file = new File([csvContent], 'vix.csv', { type: 'text/csv' });

    const fileInput = screen.getByLabelText(/upload vix ohlc csv file/i);
    await user.upload(fileInput, file);
    await act(() => wait(100));

    const datePicker = screen.getByLabelText(/select date/i);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
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
  it('shows tooltip when ? button is clicked', async () => {
    const user = userEvent.setup();
    render(<StrikeCalculator />);

    const helpBtn = screen.getByLabelText(/what is the 0dte adjustment/i);
    await user.click(helpBtn);

    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    expect(screen.getByText('0DTE IV Adjustment')).toBeInTheDocument();
  });

  it('closes tooltip on second click', async () => {
    const user = userEvent.setup();
    render(<StrikeCalculator />);

    const helpBtn = screen.getByLabelText(/what is the 0dte adjustment/i);
    await user.click(helpBtn);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    await user.click(helpBtn);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});

// ============================================================
// IRON CONDOR UI
// ============================================================
describe('StrikeCalculator: Iron Condor', () => {
  it('IC is hidden by default', () => {
    render(<StrikeCalculator />);
    expect(screen.getByText(/show.*iron condor/i)).toBeInTheDocument();
    expect(screen.queryByText(/wing width/i)).not.toBeInTheDocument();
  });

  it('shows IC controls when toggled on', async () => {
    const user = userEvent.setup();
    render(<StrikeCalculator />);

    await user.click(screen.getByText(/show.*iron condor/i));
    expect(screen.getByText(/wing width/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/iron condor wing width/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/number of contracts/i)).toBeInTheDocument();
  });

  it('renders IC legs table when results are visible', async () => {
    const user = userEvent.setup();
    render(<StrikeCalculator />);

    await user.click(screen.getByText(/show.*iron condor/i));
    await fillBasicInputs(user);

    expect(screen.getByRole('table', { name: /iron condor legs/i })).toBeInTheDocument();
    expect(screen.getByText('Long Put')).toBeInTheDocument();
    expect(screen.getByText('Short Put')).toBeInTheDocument();
    expect(screen.getByText('Short Call')).toBeInTheDocument();
    expect(screen.getByText('Long Call')).toBeInTheDocument();
  });

  it('renders P&L profile table with all columns', async () => {
    const user = userEvent.setup();
    render(<StrikeCalculator />);

    await user.click(screen.getByText(/show.*iron condor/i));
    await fillBasicInputs(user);

    expect(screen.getByRole('table', { name: /iron condor p&l/i })).toBeInTheDocument();
    expect(screen.getByText('Credit')).toBeInTheDocument();
    expect(screen.getByText('Max Profit')).toBeInTheDocument();
    expect(screen.getByText('Max Loss')).toBeInTheDocument();
    expect(screen.getByText('Buying Power')).toBeInTheDocument();
    expect(screen.getByText('RoR')).toBeInTheDocument();
    expect(screen.getByText('PoP')).toBeInTheDocument();
    expect(screen.getByText('BE Low')).toBeInTheDocument();
    expect(screen.getByText('BE High')).toBeInTheDocument();
  });

  it('wing width chips work', async () => {
    const user = userEvent.setup();
    render(<StrikeCalculator />);

    await user.click(screen.getByText(/show.*iron condor/i));

    const wingGroup = screen.getByRole('radiogroup', { name: /iron condor wing width/i });
    const chip10 = within(wingGroup).getByText('10');
    await user.click(chip10);

    await fillBasicInputs(user);
    expect(screen.getByText(/10-pt wings/i)).toBeInTheDocument();
  });

  it('contracts counter increments', async () => {
    const user = userEvent.setup();
    render(<StrikeCalculator />);

    await user.click(screen.getByText(/show.*iron condor/i));

    const incBtn = screen.getByLabelText(/increase contracts/i);
    await user.click(incBtn);
    await user.click(incBtn);

    const input = screen.getByLabelText(/number of contracts/i);
    expect(input).toHaveValue('3');
  });

  it('contracts counter decrements', async () => {
    const user = userEvent.setup();
    render(<StrikeCalculator />);

    await user.click(screen.getByText(/show.*iron condor/i));

    const incBtn = screen.getByLabelText(/increase contracts/i);
    await user.click(incBtn);
    await user.click(incBtn);

    const decBtn = screen.getByLabelText(/decrease contracts/i);
    await user.click(decBtn);

    const input = screen.getByLabelText(/number of contracts/i);
    expect(input).toHaveValue('2');
  });

  it('contracts counter does not go below 1', async () => {
    const user = userEvent.setup();
    render(<StrikeCalculator />);

    await user.click(screen.getByText(/show.*iron condor/i));

    const decBtn = screen.getByLabelText(/decrease contracts/i);
    await user.click(decBtn);
    await user.click(decBtn);

    const input = screen.getByLabelText(/number of contracts/i);
    expect(input).toHaveValue('1');
  });

  it('P&L header updates with contract count', async () => {
    const user = userEvent.setup();
    render(<StrikeCalculator />);

    await user.click(screen.getByText(/show.*iron condor/i));

    const incBtn = screen.getByLabelText(/increase contracts/i);
    await user.click(incBtn);
    await user.click(incBtn);
    await user.click(incBtn);
    await user.click(incBtn);

    await fillBasicInputs(user);

    expect(screen.getAllByText(/5 contracts/i).length).toBeGreaterThanOrEqual(1);
  });

  it('shows dollar amounts in P&L table', async () => {
    const user = userEvent.setup();
    render(<StrikeCalculator />);

    await user.click(screen.getByText(/show.*iron condor/i));
    await fillBasicInputs(user);

    const pnlTable = screen.getByRole('table', { name: /iron condor p&l/i });
    const dollarCells = within(pnlTable).getAllByText(/\$/);
    expect(dollarCells.length).toBeGreaterThan(0);
  });

  it('shows PoP percentages in P&L table', async () => {
    const user = userEvent.setup();
    render(<StrikeCalculator />);

    await user.click(screen.getByText(/show.*iron condor/i));
    await fillBasicInputs(user);

    const pnlTable = screen.getByRole('table', { name: /iron condor p&l/i });
    const pctCells = within(pnlTable).getAllByText(/%/);
    expect(pctCells.length).toBeGreaterThanOrEqual(12);
  });

  it('hides IC when toggled off', async () => {
    const user = userEvent.setup();
    render(<StrikeCalculator />);

    await user.click(screen.getByText(/show.*iron condor/i));
    expect(screen.getByText(/wing width/i)).toBeInTheDocument();

    await user.click(screen.getByText(/hide.*iron condor/i));
    expect(screen.queryByText(/wing width/i)).not.toBeInTheDocument();
  });
});

// ============================================================
// SKEW
// ============================================================
describe('StrikeCalculator: Skew', () => {
  it('renders skew slider with default value', () => {
    render(<StrikeCalculator />);
    const slider = screen.getByLabelText(/put skew/i);
    expect(slider).toBeInTheDocument();
    expect(slider).toHaveValue('3');
  });

  it('shows skew description', () => {
    render(<StrikeCalculator />);
    expect(screen.getByText(/otm puts trade at higher iv/i)).toBeInTheDocument();
  });
});
