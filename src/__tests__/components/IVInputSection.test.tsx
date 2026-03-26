import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import IVInputSection from '../../components/IVInputSection';
import { theme } from '../../themes';

const th = theme;

const mockMarket = {
  data: {
    quotes: null,
    yesterday: null,
    movers: null,
    intraday: null,
    events: null,
  },
  loading: false,
  error: null,
  hasData: false,
  needsAuth: false,
  refresh: async () => {},
  lastUpdated: null,
};

function renderSection(overrides: Record<string, unknown> = {}) {
  const defaults = {
    th,
    ivMode: 'vix' as const,
    onIvModeChange: vi.fn(),
    vixInput: '',
    onVixChange: vi.fn(),
    multiplier: '1.15',
    onMultiplierChange: vi.fn(),
    directIVInput: '',
    onDirectIVChange: vi.fn(),
    dVix: '',
    results: null,
    errors: {} as Record<string, string>,
    market: mockMarket,
    onUseVix1dAsSigma: vi.fn(),
  };
  const props = { ...defaults, ...overrides };
  return { ...render(<IVInputSection {...props} />), props };
}

// ============================================================
// RENDERING
// ============================================================

describe('IVInputSection', () => {
  it('renders section heading "Implied Volatility"', () => {
    renderSection();
    expect(screen.getByText('Implied Volatility')).toBeInTheDocument();
  });

  it('renders VIX mode inputs when ivMode="vix"', () => {
    renderSection({ ivMode: 'vix' });
    expect(screen.getByLabelText('VIX Value')).toBeInTheDocument();
    expect(screen.getByLabelText('0DTE Adj.')).toBeInTheDocument();
  });

  it('renders Direct IV mode inputs when ivMode="direct"', () => {
    renderSection({ ivMode: 'direct' });
    expect(screen.getByLabelText(/Direct IV/)).toBeInTheDocument();
    expect(screen.getByLabelText('VIX (regime only)')).toBeInTheDocument();
  });

  // ============================================================
  // CALLBACKS
  // ============================================================

  it('calls onVixChange when VIX input changes', async () => {
    const user = userEvent.setup();
    const { props } = renderSection({ ivMode: 'vix' });
    await user.type(screen.getByLabelText('VIX Value'), '2');
    expect(props.onVixChange).toHaveBeenCalledWith('2');
  });

  it('calls onMultiplierChange when adj input changes', async () => {
    const user = userEvent.setup();
    const { props } = renderSection({ ivMode: 'vix' });
    await user.type(screen.getByLabelText('0DTE Adj.'), '5');
    expect(props.onMultiplierChange).toHaveBeenCalled();
  });

  it('calls onDirectIVChange when direct IV input changes', async () => {
    const user = userEvent.setup();
    const { props } = renderSection({ ivMode: 'direct' });
    await user.type(screen.getByLabelText(/Direct IV/), '0');
    expect(props.onDirectIVChange).toHaveBeenCalledWith('0');
  });

  it('calls onIvModeChange when mode chip clicked', async () => {
    const user = userEvent.setup();
    const { props } = renderSection({ ivMode: 'vix' });
    await user.click(screen.getByText('Direct IV'));
    expect(props.onIvModeChange).toHaveBeenCalledWith('direct');
  });

  // ============================================================
  // TOOLTIP
  // ============================================================

  it('shows tooltip when ? button clicked', async () => {
    const user = userEvent.setup();
    renderSection({ ivMode: 'vix' });
    const btn = screen.getByRole('button', {
      name: /what is the 0dte adjustment/i,
    });
    await user.click(btn);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    expect(screen.getByText('0DTE IV Adjustment')).toBeInTheDocument();
  });

  it('closes tooltip on outside click', async () => {
    const user = userEvent.setup();
    renderSection({ ivMode: 'vix' });
    const btn = screen.getByRole('button', {
      name: /what is the 0dte adjustment/i,
    });
    await user.click(btn);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    // Click outside the tooltip
    await user.click(document.body);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('closes tooltip on Escape key', async () => {
    const user = userEvent.setup();
    renderSection({ ivMode: 'vix' });
    const btn = screen.getByRole('button', {
      name: /what is the 0dte adjustment/i,
    });
    await user.click(btn);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('"?" tooltip button has type="button"', () => {
    renderSection({ ivMode: 'vix' });
    const tooltipBtn = screen.getByRole('button', {
      name: /what is the 0dte adjustment/i,
    });
    expect(tooltipBtn).toHaveAttribute('type', 'button');
  });

  it('calls onVixChange in direct IV mode (regime-only VIX input)', async () => {
    const user = userEvent.setup();
    const { props } = renderSection({ ivMode: 'direct' });
    await user.type(screen.getByLabelText('VIX (regime only)'), '2');
    expect(props.onVixChange).toHaveBeenCalledWith('2');
  });

  // ============================================================
  // ERRORS
  // ============================================================

  it('shows error for vix', () => {
    renderSection({ errors: { vix: 'VIX is required' } });
    expect(screen.getByText('VIX is required')).toBeInTheDocument();
  });

  it('shows error for multiplier', () => {
    renderSection({ errors: { multiplier: 'Invalid multiplier' } });
    expect(screen.getByText('Invalid multiplier')).toBeInTheDocument();
  });

  it('shows error for iv', () => {
    renderSection({ ivMode: 'direct', errors: { iv: 'IV out of range' } });
    expect(screen.getByText('IV out of range')).toBeInTheDocument();
  });

  it('does not show errors when none exist', () => {
    const { container } = renderSection({ errors: {} });
    // ErrorMsg components should not be present
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(
      screen.queryByText(/required|invalid|out of range/i),
    ).not.toBeInTheDocument();
  });

  it('VIX input references its error via aria-describedby when invalid', () => {
    renderSection({ errors: { vix: 'VIX is required' } });
    const input = screen.getByLabelText('VIX Value');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'err-vix');
    expect(screen.getByRole('alert')).toHaveTextContent('VIX is required');
  });

  it('VIX input has no aria-describedby when no error', () => {
    renderSection({ errors: {} });
    const input = screen.getByLabelText('VIX Value');
    expect(input).not.toHaveAttribute('aria-describedby');
  });

  it('multiplier input combines tooltip and error in aria-describedby when invalid', () => {
    renderSection({ errors: { multiplier: 'Invalid multiplier' } });
    const input = screen.getByLabelText('0DTE Adj.');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute(
      'aria-describedby',
      'adj-tooltip-content err-mult',
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid multiplier');
  });

  it('multiplier input references only tooltip when no error', () => {
    renderSection({ errors: {} });
    const input = screen.getByLabelText('0DTE Adj.');
    expect(input).toHaveAttribute('aria-describedby', 'adj-tooltip-content');
  });

  it('Direct IV input references its error via aria-describedby when invalid', () => {
    renderSection({
      ivMode: 'direct',
      errors: { iv: 'IV out of range' },
    });
    const input = screen.getByLabelText(/Direct IV/);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'err-iv');
    expect(screen.getByRole('alert')).toHaveTextContent('IV out of range');
  });

  it('Direct IV input has no aria-describedby when no error', () => {
    renderSection({ ivMode: 'direct', errors: {} });
    const input = screen.getByLabelText(/Direct IV/);
    expect(input).not.toHaveAttribute('aria-describedby');
  });

  // ============================================================
  // SUB-COMPONENTS
  // ============================================================

  it('renders VIXRegimeCard when dVix is valid with results and no errors', () => {
    renderSection({
      dVix: '18',
      results: {
        allDeltas: [],
        sigma: 0.15,
        T: 0.03,
        hoursRemaining: 7,
        spot: 5700,
      },
      errors: {},
    });
    // VIXRegimeCard renders regime zone content (may appear in multiple elements)
    expect(screen.getAllByText(/regime/i).length).toBeGreaterThanOrEqual(1);
  });

  it('renders Term Structure section when dVix is valid', () => {
    renderSection({ dVix: '18', errors: {} });
    expect(screen.getByText('Term Structure')).toBeInTheDocument();
  });
});
