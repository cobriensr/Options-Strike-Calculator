import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AlertBanner from '../../components/AlertBanner';
import type { MarketAlert } from '../../hooks/useAlertPolling';

// ── Helpers ───────────────────────────────────────────────

function makeAlert(overrides: Partial<MarketAlert> = {}): MarketAlert {
  return {
    id: 1,
    type: 'iv_spike',
    severity: 'warning',
    direction: 'BEARISH',
    title: 'IV Spike: +3.5 vol pts in 5min',
    body: 'ATM 0DTE IV expanded rapidly',
    current_values: { iv: 0.277 },
    delta_values: { ivDelta: 0.035 },
    created_at: '2026-03-24T17:30:00Z',
    acknowledged: false,
    ...overrides,
  };
}

// ============================================================
// RENDERING — EMPTY / ACKNOWLEDGED
// ============================================================

describe('AlertBanner: empty states', () => {
  it('renders nothing when alerts array is empty', () => {
    const { container } = render(
      <AlertBanner alerts={[]} onAcknowledge={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when all alerts are acknowledged', () => {
    const alerts = [
      makeAlert({ id: 1, acknowledged: true }),
      makeAlert({ id: 2, acknowledged: true }),
    ];
    const { container } = render(
      <AlertBanner alerts={alerts} onAcknowledge={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });
});

// ============================================================
// RENDERING — ALERT CONTENT
// ============================================================

describe('AlertBanner: alert content', () => {
  it('renders alert with title, body, and direction badge', () => {
    const alert = makeAlert();
    render(<AlertBanner alerts={[alert]} onAcknowledge={vi.fn()} />);

    expect(
      screen.getByText('IV Spike: +3.5 vol pts in 5min'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('ATM 0DTE IV expanded rapidly'),
    ).toBeInTheDocument();
    expect(screen.getByText('BEARISH')).toBeInTheDocument();
  });

  it('shows BEARISH direction badge with danger color', () => {
    const alert = makeAlert({ direction: 'BEARISH' });
    render(<AlertBanner alerts={[alert]} onAcknowledge={vi.fn()} />);

    const badge = screen.getByText('BEARISH');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('style');
    expect(badge.style.color).toContain('var(--color-danger)');
  });

  it('shows BULLISH direction badge with success color', () => {
    const alert = makeAlert({ direction: 'BULLISH' });
    render(<AlertBanner alerts={[alert]} onAcknowledge={vi.fn()} />);

    const badge = screen.getByText('BULLISH');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('style');
    expect(badge.style.color).toContain('var(--color-success)');
  });

  it('shows NEUTRAL direction badge with muted color', () => {
    const alert = makeAlert({ direction: 'NEUTRAL' });
    render(<AlertBanner alerts={[alert]} onAcknowledge={vi.fn()} />);

    const badge = screen.getByText('NEUTRAL');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('style');
    expect(badge.style.color).toContain('var(--color-muted)');
  });
});

// ============================================================
// RENDERING — MAX 3 ALERTS
// ============================================================

describe('AlertBanner: display limit', () => {
  it('shows max 3 alerts even when more are passed', () => {
    const alerts = [
      makeAlert({ id: 1, title: 'Alert One' }),
      makeAlert({ id: 2, title: 'Alert Two' }),
      makeAlert({ id: 3, title: 'Alert Three' }),
      makeAlert({ id: 4, title: 'Alert Four' }),
      makeAlert({ id: 5, title: 'Alert Five' }),
    ];
    render(<AlertBanner alerts={alerts} onAcknowledge={vi.fn()} />);

    expect(screen.getByText('Alert One')).toBeInTheDocument();
    expect(screen.getByText('Alert Two')).toBeInTheDocument();
    expect(screen.getByText('Alert Three')).toBeInTheDocument();
    expect(screen.queryByText('Alert Four')).not.toBeInTheDocument();
    expect(screen.queryByText('Alert Five')).not.toBeInTheDocument();
  });

  it('only counts unacknowledged alerts toward the limit', () => {
    const alerts = [
      makeAlert({ id: 1, acknowledged: true, title: 'Acked' }),
      makeAlert({ id: 2, title: 'Active One' }),
      makeAlert({ id: 3, title: 'Active Two' }),
      makeAlert({ id: 4, title: 'Active Three' }),
      makeAlert({ id: 5, title: 'Active Four' }),
    ];
    render(<AlertBanner alerts={alerts} onAcknowledge={vi.fn()} />);

    // Acknowledged alert should not render
    expect(screen.queryByText('Acked')).not.toBeInTheDocument();
    // Only 3 of the 4 active ones should show
    expect(screen.getByText('Active One')).toBeInTheDocument();
    expect(screen.getByText('Active Two')).toBeInTheDocument();
    expect(screen.getByText('Active Three')).toBeInTheDocument();
    expect(screen.queryByText('Active Four')).not.toBeInTheDocument();
  });
});

// ============================================================
// DISMISS INTERACTION
// ============================================================

describe('AlertBanner: dismiss button', () => {
  it('calls onAcknowledge with correct id when dismiss button is clicked', async () => {
    const user = userEvent.setup();
    const onAck = vi.fn().mockResolvedValue(undefined);
    const alert = makeAlert({ id: 99 });

    render(<AlertBanner alerts={[alert]} onAcknowledge={onAck} />);

    const dismissBtn = screen.getByRole('button', {
      name: 'Dismiss alert',
    });
    await user.click(dismissBtn);

    expect(onAck).toHaveBeenCalledTimes(1);
    expect(onAck).toHaveBeenCalledWith(99);
  });

  it('renders a dismiss button for each active alert', () => {
    const alerts = [
      makeAlert({ id: 1, title: 'A1' }),
      makeAlert({ id: 2, title: 'A2' }),
    ];
    render(<AlertBanner alerts={alerts} onAcknowledge={vi.fn()} />);

    const buttons = screen.getAllByRole('button', {
      name: 'Dismiss alert',
    });
    expect(buttons).toHaveLength(2);
  });
});

// ============================================================
// ACCESSIBILITY
// ============================================================

describe('AlertBanner: accessibility', () => {
  it('has role="alert" for accessibility', () => {
    const alert = makeAlert();
    render(<AlertBanner alerts={[alert]} onAcknowledge={vi.fn()} />);

    const alertEl = screen.getByRole('alert');
    expect(alertEl).toBeInTheDocument();
  });

  it('each alert has its own role="alert"', () => {
    const alerts = [
      makeAlert({ id: 1 }),
      makeAlert({ id: 2 }),
      makeAlert({ id: 3 }),
    ];
    render(<AlertBanner alerts={alerts} onAcknowledge={vi.fn()} />);

    const alertEls = screen.getAllByRole('alert');
    expect(alertEls).toHaveLength(3);
  });

  it('dismiss buttons have aria-label="Dismiss alert"', () => {
    const alert = makeAlert();
    render(<AlertBanner alerts={[alert]} onAcknowledge={vi.fn()} />);

    expect(screen.getByLabelText('Dismiss alert')).toBeInTheDocument();
  });
});

// ============================================================
// SEVERITY STYLING
// ============================================================

describe('AlertBanner: severity styling', () => {
  it('applies warning severity styles', () => {
    const alert = makeAlert({ severity: 'warning' });
    render(<AlertBanner alerts={[alert]} onAcknowledge={vi.fn()} />);

    const alertEl = screen.getByRole('alert');
    expect(alertEl).toHaveAttribute('style');
    expect(alertEl.style.color).toContain('var(--color-caution)');
  });

  it('applies critical severity styles', () => {
    const alert = makeAlert({ severity: 'critical' });
    render(<AlertBanner alerts={[alert]} onAcknowledge={vi.fn()} />);

    const alertEl = screen.getByRole('alert');
    expect(alertEl).toHaveAttribute('style');
    expect(alertEl.style.color).toContain('var(--color-danger)');
  });

  it('applies extreme severity styles with animate-pulse', () => {
    const alert = makeAlert({ severity: 'extreme' });
    render(<AlertBanner alerts={[alert]} onAcknowledge={vi.fn()} />);

    const alertEl = screen.getByRole('alert');
    expect(alertEl).toHaveAttribute('style');
    expect(alertEl.style.color).toContain('var(--color-danger)');
    expect(alertEl.className).toContain('animate-pulse');
  });
});

// ============================================================
// ALERT TYPE VARIANTS
// ============================================================

describe('AlertBanner: alert type variants', () => {
  it('renders ratio_surge type alert', () => {
    const alert = makeAlert({
      type: 'ratio_surge',
      title: 'Put/Call Ratio Surge',
      body: 'Ratio spiked above 1.5',
    });
    render(<AlertBanner alerts={[alert]} onAcknowledge={vi.fn()} />);

    expect(screen.getByText('Put/Call Ratio Surge')).toBeInTheDocument();
    expect(screen.getByText('Ratio spiked above 1.5')).toBeInTheDocument();
  });

  it('renders combined type alert', () => {
    const alert = makeAlert({
      type: 'combined',
      title: 'Combined: IV + Ratio Alert',
      direction: 'BULLISH',
    });
    render(<AlertBanner alerts={[alert]} onAcknowledge={vi.fn()} />);

    expect(screen.getByText('Combined: IV + Ratio Alert')).toBeInTheDocument();
    expect(screen.getByText('BULLISH')).toBeInTheDocument();
  });
});
