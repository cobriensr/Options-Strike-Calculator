import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DataQualityAlerts from '../components/PositionMonitor/DataQualityAlerts';
import type { DataQualityWarning } from '../components/PositionMonitor/types';

// ============================================================
// FACTORIES
// ============================================================

function makeWarning(
  overrides: Partial<DataQualityWarning> = {},
): DataQualityWarning {
  return {
    code: 'MISSING_MARK',
    severity: 'warn',
    message: 'Missing mark data for 2 legs',
    ...overrides,
  };
}

function renderAlerts(warnings: readonly DataQualityWarning[]) {
  return render(<DataQualityAlerts warnings={warnings} />);
}

// ============================================================
// TESTS
// ============================================================

describe('DataQualityAlerts', () => {
  // ── Empty State ────────────────────────────────────────

  it('renders nothing when warnings array is empty', () => {
    const { container } = renderAlerts([]);
    expect(container.innerHTML).toBe('');
  });

  it('does not render region when no warnings', () => {
    renderAlerts([]);
    expect(
      screen.queryByRole('region', {
        name: 'Data quality alerts',
      }),
    ).not.toBeInTheDocument();
  });

  // ── Basic Rendering ────────────────────────────────────

  it('renders the region with correct aria label', () => {
    renderAlerts([makeWarning()]);
    expect(
      screen.getByRole('region', {
        name: 'Data quality alerts',
      }),
    ).toBeInTheDocument();
  });

  it('renders the data-testid', () => {
    renderAlerts([makeWarning()]);
    expect(
      screen.getByTestId('data-quality-alerts'),
    ).toBeInTheDocument();
  });

  it('renders a single warning message', () => {
    renderAlerts([
      makeWarning({ message: 'Something is wrong' }),
    ]);
    expect(
      screen.getByText('Something is wrong'),
    ).toBeInTheDocument();
  });

  it('renders multiple warnings', () => {
    renderAlerts([
      makeWarning({
        code: 'MISSING_MARK',
        message: 'Missing mark data',
      }),
      makeWarning({
        code: 'UNMATCHED_SHORT',
        message: 'Unmatched short leg',
      }),
      makeWarning({
        code: 'PAPER_TRADING',
        severity: 'info',
        message: 'Paper trading account',
      }),
    ]);
    expect(
      screen.getByText('Missing mark data'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Unmatched short leg'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Paper trading account'),
    ).toBeInTheDocument();
  });

  // ── Detail Text ────────────────────────────────────────

  it('renders detail text when provided', () => {
    renderAlerts([
      makeWarning({
        message: 'Balance jump',
        detail: 'Gap of $500 detected',
      }),
    ]);
    expect(
      screen.getByText('Gap of $500 detected'),
    ).toBeInTheDocument();
  });

  it('does not render detail element when detail is undefined', () => {
    renderAlerts([
      makeWarning({ message: 'Simple warning' }),
    ]);
    // Only the message should appear, no extra detail div
    expect(
      screen.queryByText('Simple warning'),
    ).toBeInTheDocument();
    // The message's parent should have exactly one child div
    // (just the message text)
    const messageEl = screen.getByText('Simple warning');
    const parent = messageEl.parentElement;
    expect(parent?.children).toHaveLength(1);
  });

  // ── Severity Styling ───────────────────────────────────

  it('applies error severity styles', () => {
    renderAlerts([
      makeWarning({
        severity: 'error',
        message: 'Critical error',
      }),
    ]);
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('border-danger');
    expect(alert.className).toContain('text-danger');
  });

  it('applies warn severity styles', () => {
    renderAlerts([
      makeWarning({
        severity: 'warn',
        message: 'Something concerning',
      }),
    ]);
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('border-caution');
    expect(alert.className).toContain('text-caution');
  });

  it('applies info severity styles', () => {
    renderAlerts([
      makeWarning({
        severity: 'info',
        message: 'FYI note',
      }),
    ]);
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('border-accent');
    expect(alert.className).toContain('text-accent');
  });

  it('renders correct severity icon for error', () => {
    renderAlerts([
      makeWarning({
        severity: 'error',
        message: 'Error msg',
      }),
    ]);
    // \u26D4 = no-entry icon
    expect(screen.getByText('\u26D4')).toBeInTheDocument();
  });

  it('renders correct severity icon for warn', () => {
    renderAlerts([
      makeWarning({
        severity: 'warn',
        message: 'Warn msg',
      }),
    ]);
    // \u26A0 = warning icon
    expect(screen.getByText('\u26A0')).toBeInTheDocument();
  });

  it('renders correct severity icon for info', () => {
    renderAlerts([
      makeWarning({
        severity: 'info',
        message: 'Info msg',
      }),
    ]);
    // \u2139 = info icon
    expect(screen.getByText('\u2139')).toBeInTheDocument();
  });

  // ── Dismiss Behavior ───────────────────────────────────

  it('renders dismiss button for each warning', () => {
    renderAlerts([
      makeWarning({ message: 'Alert one' }),
      makeWarning({ message: 'Alert two' }),
    ]);
    expect(
      screen.getByRole('button', {
        name: 'Dismiss Alert one',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Dismiss Alert two',
      }),
    ).toBeInTheDocument();
  });

  it('hides a warning when its dismiss button is clicked', async () => {
    const user = userEvent.setup();
    renderAlerts([
      makeWarning({ message: 'Dismissable alert' }),
    ]);

    expect(
      screen.getByText('Dismissable alert'),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', {
        name: 'Dismiss Dismissable alert',
      }),
    );

    expect(
      screen.queryByText('Dismissable alert'),
    ).not.toBeInTheDocument();
  });

  it('only dismisses the clicked warning, not others', async () => {
    const user = userEvent.setup();
    renderAlerts([
      makeWarning({
        code: 'MISSING_MARK',
        message: 'First alert',
      }),
      makeWarning({
        code: 'PAPER_TRADING',
        severity: 'info',
        message: 'Second alert',
      }),
    ]);

    await user.click(
      screen.getByRole('button', {
        name: 'Dismiss First alert',
      }),
    );

    expect(
      screen.queryByText('First alert'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText('Second alert'),
    ).toBeInTheDocument();
  });

  it('removes the entire region when all warnings are dismissed', async () => {
    const user = userEvent.setup();
    renderAlerts([
      makeWarning({ message: 'Only alert' }),
    ]);

    await user.click(
      screen.getByRole('button', {
        name: 'Dismiss Only alert',
      }),
    );

    expect(
      screen.queryByRole('region', {
        name: 'Data quality alerts',
      }),
    ).not.toBeInTheDocument();
  });

  // ── Deduplication ──────────────────────────────────────

  it('deduplicates warnings with the same message', () => {
    renderAlerts([
      makeWarning({
        code: 'UNMATCHED_SHORT',
        message: 'Unmatched short found',
      }),
      makeWarning({
        code: 'UNMATCHED_SHORT',
        message: 'Unmatched short found',
      }),
      makeWarning({
        code: 'UNMATCHED_SHORT',
        message: 'Unmatched short found',
      }),
    ]);

    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
  });

  it('keeps warnings with different messages even if same code', () => {
    renderAlerts([
      makeWarning({
        code: 'MISSING_MARK',
        message: 'Missing mark for leg A',
      }),
      makeWarning({
        code: 'MISSING_MARK',
        message: 'Missing mark for leg B',
      }),
    ]);

    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(2);
  });

  it('dismissing a deduplicated warning removes all instances', async () => {
    const user = userEvent.setup();
    renderAlerts([
      makeWarning({
        code: 'UNMATCHED_SHORT',
        message: 'Duplicate msg',
      }),
      makeWarning({
        code: 'UNMATCHED_SHORT',
        message: 'Duplicate msg',
      }),
      makeWarning({
        code: 'PAPER_TRADING',
        severity: 'info',
        message: 'Other alert',
      }),
    ]);

    // Only 2 alerts shown (deduped)
    expect(screen.getAllByRole('alert')).toHaveLength(2);

    await user.click(
      screen.getByRole('button', {
        name: 'Dismiss Duplicate msg',
      }),
    );

    // Only the other alert remains
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(
      screen.getByText('Other alert'),
    ).toBeInTheDocument();
  });
});
