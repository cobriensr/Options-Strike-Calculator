import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LegFormModal from '../../../components/PyramidTracker/LegFormModal';
import type { PyramidLeg, PyramidLegInput } from '../../../types/pyramid';
import { PyramidApiError } from '../../../hooks/usePyramidData';

// ============================================================
// Fixtures
// ============================================================

const fullLeg: PyramidLeg = {
  id: '2026-04-16-MNQ-1-L2',
  chain_id: '2026-04-16-MNQ-1',
  leg_number: 2,
  signal_type: 'BOS',
  entry_time_ct: '10:15',
  entry_price: 21210,
  stop_price: 21198,
  stop_distance_pts: 12,
  stop_compression_ratio: 0.8,
  vwap_at_entry: 21205,
  vwap_1sd_upper: 21212,
  vwap_1sd_lower: 21198,
  vwap_band_position: 'inside',
  vwap_band_distance_pts: 3,
  minutes_since_chain_start: 45,
  minutes_since_prior_bos: 20,
  ob_quality: 4,
  relative_volume: 5,
  session_phase: 'morning_drive',
  session_high_at_entry: 21215,
  session_low_at_entry: 21180,
  retracement_extreme_before_entry: 21200,
  exit_price: 21230,
  exit_reason: 'trailed_stop',
  points_captured: 20,
  r_multiple: 1.67,
  was_profitable: true,
  notes: 'Clean BOS continuation.',
  ob_high: 21208,
  ob_low: 21200,
  ob_poc_price: 21204,
  ob_poc_pct: 32,
  ob_secondary_node_pct: 24,
  ob_tertiary_node_pct: 18,
  ob_total_volume: 38914,
  created_at: '2026-04-16T15:15:00Z',
  updated_at: '2026-04-16T15:15:00Z',
};

function makeProps(
  overrides: Partial<React.ComponentProps<typeof LegFormModal>> = {},
) {
  const defaults = {
    mode: 'create' as const,
    chainId: '2026-04-16-MNQ-1',
    open: true,
    onClose: vi.fn(),
    onSubmit: vi.fn().mockResolvedValue(undefined),
  };
  return { ...defaults, ...overrides };
}

// ============================================================
// Tests
// ============================================================

describe('LegFormModal', () => {
  it('renders in create mode with leg_number=1 default', () => {
    render(<LegFormModal {...makeProps()} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /new pyramid leg/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/leg number/i)).toHaveValue(1);
    expect(screen.getByLabelText(/signal type/i)).toHaveValue('');
    // Chain context shown in header.
    expect(screen.getByText(/2026-04-16-MNQ-1/)).toBeInTheDocument();
  });

  it('renders nothing when open=false', () => {
    const { container } = render(
      <LegFormModal {...makeProps({ open: false })} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders in edit mode with initialLeg pre-populated', () => {
    render(
      <LegFormModal {...makeProps({ mode: 'edit', initialLeg: fullLeg })} />,
    );
    expect(
      screen.getByRole('heading', { name: /edit pyramid leg/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/leg number/i)).toHaveValue(2);
    expect(screen.getByLabelText(/signal type/i)).toHaveValue('BOS');
    expect(screen.getByLabelText(/entry time/i)).toHaveValue('10:15');
    expect(screen.getByLabelText(/^entry price$/i)).toHaveValue(21210);
    expect(screen.getByLabelText(/^stop price$/i)).toHaveValue(21198);
    expect(screen.getByLabelText(/^session phase$/i)).toHaveValue(
      'morning_drive',
    );
    expect(screen.getByLabelText(/^ob poc %$/i)).toHaveValue(32);
    expect(screen.getByLabelText(/^ob total volume$/i)).toHaveValue(38914);
    expect(screen.getByLabelText(/^was profitable$/i)).toHaveValue('yes');
  });

  it('renders the Outcome section subtitle with a real em-dash (no literal unicode escape)', () => {
    render(<LegFormModal {...makeProps()} />);
    // Regression guard: `subtitle="... \u2014 ..."` on a JSX string attribute
    // renders literally; only expressions / real characters are parsed. The
    // subtitle must contain the actual em-dash character, and must not
    // contain the literal six-character escape sequence.
    expect(
      screen.getByText(/fill after the trade closes — all fields optional/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(String.raw`\u2014`)).not.toBeInTheDocument();
  });

  it('renders all 7 OB fields inside a visible Order Block section', () => {
    render(<LegFormModal {...makeProps()} />);
    // The Section component renders the title inside a <legend> element.
    const obLegend = screen.getByText(/order block/i);
    const obFieldset = obLegend.closest('fieldset');
    expect(obFieldset).not.toBeNull();

    // The 7 OB-specific fields from Task 1C + quality + relative volume (9 in
    // total) all live inside the Order Block fieldset.
    const scoped = within(obFieldset!);
    expect(scoped.getByLabelText(/^ob high$/i)).toBeInTheDocument();
    expect(scoped.getByLabelText(/^ob low$/i)).toBeInTheDocument();
    expect(scoped.getByLabelText(/^ob poc price$/i)).toBeInTheDocument();
    expect(scoped.getByLabelText(/^ob poc %$/i)).toBeInTheDocument();
    expect(scoped.getByLabelText(/^ob secondary node %$/i)).toBeInTheDocument();
    expect(scoped.getByLabelText(/^ob tertiary node %$/i)).toBeInTheDocument();
    expect(scoped.getByLabelText(/^ob total volume$/i)).toBeInTheDocument();
    // Subjective scores live here too per the spec grouping.
    expect(scoped.getByLabelText(/^ob quality/i)).toBeInTheDocument();
    expect(scoped.getByLabelText(/^relative volume/i)).toBeInTheDocument();
  });

  it('renders all session_phase options', () => {
    render(<LegFormModal {...makeProps()} />);
    const select = screen.getByLabelText(/^session phase$/i);
    const optionValues = Array.from(select.querySelectorAll('option')).map(
      (o) => o.getAttribute('value'),
    );
    expect(optionValues).toEqual([
      '',
      'pre_open',
      'open_drive',
      'morning_drive',
      'lunch',
      'afternoon',
      'power_hour',
      'close',
    ]);
  });

  it('renders all leg exit_reason options', () => {
    render(<LegFormModal {...makeProps()} />);
    const select = screen.getByLabelText(/^exit reason$/i);
    const optionValues = Array.from(select.querySelectorAll('option')).map(
      (o) => o.getAttribute('value'),
    );
    expect(optionValues).toEqual([
      '',
      'reverse_choch',
      'trailed_stop',
      'manual',
    ]);
  });

  it('pre-populates session_phase from entry_time_ct (09:45 -> morning_drive)', async () => {
    const user = userEvent.setup();
    render(<LegFormModal {...makeProps()} />);
    const timeInput = screen.getByLabelText(/entry time/i);
    const phaseInput = screen.getByLabelText(/^session phase$/i);

    // Initially blank.
    expect(phaseInput).toHaveValue('');

    // Type a time in the morning_drive bucket.
    await user.clear(timeInput);
    await user.type(timeInput, '09:45');

    expect(phaseInput).toHaveValue('morning_drive');
  });

  it('pre-populates session_phase for several time ranges', async () => {
    const user = userEvent.setup();
    const cases: Array<[string, string]> = [
      ['08:00', 'pre_open'],
      ['08:35', 'open_drive'],
      ['12:00', 'lunch'],
      ['14:00', 'afternoon'],
      ['15:00', 'power_hour'],
      ['15:45', 'close'],
    ];
    for (const [time, expected] of cases) {
      const { unmount } = render(<LegFormModal {...makeProps()} />);
      const timeInput = screen.getByLabelText(/entry time/i);
      await user.clear(timeInput);
      await user.type(timeInput, time);
      expect(screen.getByLabelText(/^session phase$/i)).toHaveValue(expected);
      unmount();
    }
  });

  it('respects manual session_phase override (does not auto-update on time change)', async () => {
    const user = userEvent.setup();
    render(<LegFormModal {...makeProps()} />);
    const phaseInput = screen.getByLabelText(/^session phase$/i);
    const timeInput = screen.getByLabelText(/entry time/i);

    // User manually picks power_hour.
    await user.selectOptions(phaseInput, 'power_hour');
    expect(phaseInput).toHaveValue('power_hour');

    // Typing a time in a different bucket no longer changes phase.
    await user.type(timeInput, '09:45');
    expect(phaseInput).toHaveValue('power_hour');
  });

  it('saves with partial data (leg_number only)', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<LegFormModal {...makeProps({ onSubmit, onClose })} />);

    // leg_number defaults to 1; don't touch anything else.
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0]![0] as PyramidLegInput;
    expect(payload.id).toBe('2026-04-16-MNQ-1-L1');
    expect(payload.chain_id).toBe('2026-04-16-MNQ-1');
    expect(payload.leg_number).toBe(1);
    expect(payload.signal_type).toBeNull();
    expect(payload.entry_price).toBeNull();
    expect(payload.ob_poc_pct).toBeNull();
    expect(payload.was_profitable).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('rejects leg_number < 1 with inline error', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<LegFormModal {...makeProps({ onSubmit })} />);

    const legNumberInput = screen.getByLabelText(/leg number/i);
    await user.clear(legNumberInput);
    await user.type(legNumberInput, '0');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    // Form did not submit; inline error shown.
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/leg number/i);
  });

  it('rejects ob_poc_pct > 100 with inline error', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<LegFormModal {...makeProps({ onSubmit })} />);

    await user.type(screen.getByLabelText(/^ob poc %$/i), '150');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/0 and 100/);
  });

  it('submits full payload including all 7 OB fields', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <LegFormModal
        {...makeProps({ mode: 'edit', initialLeg: fullLeg, onSubmit })}
      />,
    );

    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0]![0] as PyramidLegInput;
    expect(payload.ob_high).toBe(21208);
    expect(payload.ob_low).toBe(21200);
    expect(payload.ob_poc_price).toBe(21204);
    expect(payload.ob_poc_pct).toBe(32);
    expect(payload.ob_secondary_node_pct).toBe(24);
    expect(payload.ob_tertiary_node_pct).toBe(18);
    expect(payload.ob_total_volume).toBe(38914);
    expect(payload.was_profitable).toBe(true);
    expect(payload.signal_type).toBe('BOS');
  });

  it('completeness meter reflects fill state', async () => {
    const user = userEvent.setup();
    // 31 fillable fields in the leg modal (see fillValues in component).
    render(<LegFormModal {...makeProps()} />);

    // Default: no fillable fields set (leg_number is identity, not fillable).
    expect(screen.getByTestId('completeness-percent')).toHaveTextContent(
      /Complete: 0%/,
    );

    // Fill several fields.
    await user.selectOptions(screen.getByLabelText(/signal type/i), 'CHoCH');
    await user.type(screen.getByLabelText(/entry time/i), '09:45');
    // Filling entry_time triggers session_phase auto-population => 3 filled.
    await user.type(screen.getByLabelText(/^entry price$/i), '21200');
    await user.type(screen.getByLabelText(/^stop price$/i), '21190');

    // 5/31 = 16%.
    expect(screen.getByTestId('completeness-percent')).toHaveTextContent(
      /Complete: 16%/,
    );
  });

  it('calls onClose when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<LegFormModal {...makeProps({ onClose })} />);
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when Escape is pressed', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<LegFormModal {...makeProps({ onClose })} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows leg_1_missing hint on 409 error from server', async () => {
    const user = userEvent.setup();
    const onSubmit = vi
      .fn()
      .mockRejectedValue(new PyramidApiError('Conflict', 409, 'leg_1_missing'));
    const onClose = vi.fn();
    render(<LegFormModal {...makeProps({ onSubmit, onClose })} />);

    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(screen.getByRole('alert')).toHaveTextContent(/leg 1 is missing/i);
    expect(onClose).not.toHaveBeenCalled();
  });
});
