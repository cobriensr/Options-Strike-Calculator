/**
 * LegFormModal — create or edit one leg inside a pyramid chain.
 *
 * Organised into six sections so the ~30-field form stays scannable during
 * live trading:
 *   A. Identity & Timing
 *   B. Entry & Stop
 *   C. VWAP Context
 *   D. Order Block (includes the 7 new OB metrics from Task 1C)
 *   E. Session Context
 *   F. Outcome (usable in both create and edit — subtle hint says "fill
 *      after the trade closes" so users know it's optional on initial save)
 *   G. Notes
 *
 * `session_phase` auto-populates from `entry_time_ct` when the user hasn't
 * touched the phase field yet (sessionPhaseFromTime). A manual override
 * stops future auto-population for the lifetime of the modal.
 *
 * All feature fields are optional. `leg_number` is conventionally required
 * (matches the NOT NULL DB column). Save is always enabled.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  PyramidExitReasonLeg,
  PyramidLeg,
  PyramidLegInput,
  PyramidSessionPhase,
  PyramidSignalType,
  PyramidVwapBandPosition,
} from '../../types/pyramid';
import { PyramidApiError } from '../../hooks/usePyramidData';
import CompletenessMeter from './CompletenessMeter';
import PyramidTrackerModal from './PyramidTrackerModal';
import {
  countFilled,
  numberToInput,
  parseIntInput,
  parseNumberInput,
  pyramidApiErrorMessage,
  sessionPhaseFromTime,
  stringToInput,
} from './pyramid-form-helpers';

// ============================================================
// Props
// ============================================================

export interface LegFormModalProps {
  readonly mode: 'create' | 'edit';
  readonly chainId: string;
  readonly initialLeg?: PyramidLeg;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (values: PyramidLegInput) => Promise<void>;
}

// ============================================================
// Constants
// ============================================================

const SIGNAL_TYPES: ReadonlyArray<{
  value: PyramidSignalType;
  label: string;
}> = [
  { value: 'CHoCH', label: 'CHoCH (initial)' },
  { value: 'BOS', label: 'BOS (continuation)' },
];

const SESSION_PHASES: ReadonlyArray<{
  value: PyramidSessionPhase;
  label: string;
}> = [
  { value: 'pre_open', label: 'Pre-Open' },
  { value: 'open_drive', label: 'Open Drive' },
  { value: 'morning_drive', label: 'Morning Drive' },
  { value: 'lunch', label: 'Lunch' },
  { value: 'afternoon', label: 'Afternoon' },
  { value: 'power_hour', label: 'Power Hour' },
  { value: 'close', label: 'Close' },
];

const VWAP_BAND_POSITIONS: ReadonlyArray<{
  value: PyramidVwapBandPosition;
  label: string;
}> = [
  { value: 'outside_upper', label: 'Outside Upper' },
  { value: 'at_upper', label: 'At Upper' },
  { value: 'inside', label: 'Inside' },
  { value: 'at_lower', label: 'At Lower' },
  { value: 'outside_lower', label: 'Outside Lower' },
];

const LEG_EXIT_REASONS: ReadonlyArray<{
  value: PyramidExitReasonLeg;
  label: string;
}> = [
  { value: 'reverse_choch', label: 'Reverse CHoCH' },
  { value: 'trailed_stop', label: 'Trailed Stop' },
  { value: 'manual', label: 'Manual' },
];

// ============================================================
// Form state
// ============================================================

interface LegFormState {
  // A
  leg_number: string;
  signal_type: PyramidSignalType | '';
  entry_time_ct: string;
  minutes_since_chain_start: string;
  minutes_since_prior_bos: string;
  session_phase: PyramidSessionPhase | '';
  // B
  entry_price: string;
  stop_price: string;
  stop_distance_pts: string;
  // C
  vwap_at_entry: string;
  vwap_1sd_upper: string;
  vwap_1sd_lower: string;
  vwap_band_position: PyramidVwapBandPosition | '';
  vwap_band_distance_pts: string;
  // D
  ob_high: string;
  ob_low: string;
  ob_poc_price: string;
  ob_poc_pct: string;
  ob_secondary_node_pct: string;
  ob_tertiary_node_pct: string;
  ob_total_volume: string;
  ob_quality: string;
  relative_volume: string;
  // E
  session_high_at_entry: string;
  session_low_at_entry: string;
  retracement_extreme_before_entry: string;
  // F
  exit_price: string;
  exit_reason: PyramidExitReasonLeg | '';
  points_captured: string;
  r_multiple: string;
  was_profitable: 'yes' | 'no' | 'unknown';
  // G
  notes: string;
}

function initialStateFromLeg(leg: PyramidLeg | undefined): LegFormState {
  if (leg == null) {
    return {
      leg_number: '1',
      signal_type: '',
      entry_time_ct: '',
      minutes_since_chain_start: '',
      minutes_since_prior_bos: '',
      session_phase: '',
      entry_price: '',
      stop_price: '',
      stop_distance_pts: '',
      vwap_at_entry: '',
      vwap_1sd_upper: '',
      vwap_1sd_lower: '',
      vwap_band_position: '',
      vwap_band_distance_pts: '',
      ob_high: '',
      ob_low: '',
      ob_poc_price: '',
      ob_poc_pct: '',
      ob_secondary_node_pct: '',
      ob_tertiary_node_pct: '',
      ob_total_volume: '',
      ob_quality: '',
      relative_volume: '',
      session_high_at_entry: '',
      session_low_at_entry: '',
      retracement_extreme_before_entry: '',
      exit_price: '',
      exit_reason: '',
      points_captured: '',
      r_multiple: '',
      was_profitable: 'unknown',
      notes: '',
    };
  }
  return {
    leg_number: String(leg.leg_number),
    signal_type: leg.signal_type ?? '',
    entry_time_ct: stringToInput(leg.entry_time_ct),
    minutes_since_chain_start: numberToInput(leg.minutes_since_chain_start),
    minutes_since_prior_bos: numberToInput(leg.minutes_since_prior_bos),
    session_phase: leg.session_phase ?? '',
    entry_price: numberToInput(leg.entry_price),
    stop_price: numberToInput(leg.stop_price),
    stop_distance_pts: numberToInput(leg.stop_distance_pts),
    vwap_at_entry: numberToInput(leg.vwap_at_entry),
    vwap_1sd_upper: numberToInput(leg.vwap_1sd_upper),
    vwap_1sd_lower: numberToInput(leg.vwap_1sd_lower),
    vwap_band_position: leg.vwap_band_position ?? '',
    vwap_band_distance_pts: numberToInput(leg.vwap_band_distance_pts),
    ob_high: numberToInput(leg.ob_high),
    ob_low: numberToInput(leg.ob_low),
    ob_poc_price: numberToInput(leg.ob_poc_price),
    ob_poc_pct: numberToInput(leg.ob_poc_pct),
    ob_secondary_node_pct: numberToInput(leg.ob_secondary_node_pct),
    ob_tertiary_node_pct: numberToInput(leg.ob_tertiary_node_pct),
    ob_total_volume: numberToInput(leg.ob_total_volume),
    ob_quality: numberToInput(leg.ob_quality),
    relative_volume: numberToInput(leg.relative_volume),
    session_high_at_entry: numberToInput(leg.session_high_at_entry),
    session_low_at_entry: numberToInput(leg.session_low_at_entry),
    retracement_extreme_before_entry: numberToInput(
      leg.retracement_extreme_before_entry,
    ),
    exit_price: numberToInput(leg.exit_price),
    exit_reason: leg.exit_reason ?? '',
    points_captured: numberToInput(leg.points_captured),
    r_multiple: numberToInput(leg.r_multiple),
    was_profitable:
      leg.was_profitable === true
        ? 'yes'
        : leg.was_profitable === false
          ? 'no'
          : 'unknown',
    notes: stringToInput(leg.notes),
  };
}

// ============================================================
// Component
// ============================================================

export default function LegFormModal({
  mode,
  chainId,
  initialLeg,
  open,
  onClose,
  onSubmit,
}: LegFormModalProps) {
  const [state, setState] = useState<LegFormState>(() =>
    initialStateFromLeg(initialLeg),
  );
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // Tracks whether the user has manually set session_phase. Once manually
  // set, entry_time_ct changes no longer auto-update the phase — respecting
  // the override. Reset on modal open.
  const [phaseOverridden, setPhaseOverridden] = useState(false);

  // Reset when the modal opens (create) or initialLeg changes (edit).
  useEffect(() => {
    if (open) {
      setState(initialStateFromLeg(initialLeg));
      setFormError(null);
      setSubmitting(false);
      // In edit mode, the existing phase is presumed intentional — treat it
      // as already-overridden so auto-populate doesn't blow away the saved
      // value on a time change. In create mode, start fresh.
      setPhaseOverridden(
        mode === 'edit' &&
          initialLeg != null &&
          initialLeg.session_phase != null,
      );
    }
  }, [open, initialLeg, mode]);

  const set = useCallback(
    <K extends keyof LegFormState>(key: K, value: LegFormState[K]) => {
      setState((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const handleEntryTimeChange = useCallback(
    (value: string) => {
      setState((prev) => {
        const next: LegFormState = { ...prev, entry_time_ct: value };
        if (!phaseOverridden) {
          const suggestion = sessionPhaseFromTime(value);
          next.session_phase = suggestion ?? '';
        }
        return next;
      });
    },
    [phaseOverridden],
  );

  const handlePhaseChange = useCallback((value: string) => {
    setPhaseOverridden(true);
    setState((prev) => ({
      ...prev,
      session_phase: value as PyramidSessionPhase | '',
    }));
  }, []);

  // ----- Completeness meter -----
  // All fillable fields except identity (`leg_number`, `chain_id`, `id`) and
  // system timestamps. `was_profitable` counts as filled only when
  // explicitly yes/no (unknown = not filled).
  const fillValues = useMemo(
    () => [
      state.signal_type,
      state.entry_time_ct,
      state.minutes_since_chain_start,
      state.minutes_since_prior_bos,
      state.session_phase,
      state.entry_price,
      state.stop_price,
      state.stop_distance_pts,
      state.vwap_at_entry,
      state.vwap_1sd_upper,
      state.vwap_1sd_lower,
      state.vwap_band_position,
      state.vwap_band_distance_pts,
      state.ob_high,
      state.ob_low,
      state.ob_poc_price,
      state.ob_poc_pct,
      state.ob_secondary_node_pct,
      state.ob_tertiary_node_pct,
      state.ob_total_volume,
      state.ob_quality,
      state.relative_volume,
      state.session_high_at_entry,
      state.session_low_at_entry,
      state.retracement_extreme_before_entry,
      state.exit_price,
      state.exit_reason,
      state.points_captured,
      state.r_multiple,
      state.was_profitable === 'unknown' ? '' : state.was_profitable,
      state.notes,
    ],
    [state],
  );
  const filled = countFilled(fillValues);
  const total = fillValues.length;

  // Display-only: show stop distance as entry - stop when both set and the
  // user hasn't typed one themselves. Pure visual hint — doesn't overwrite
  // state.
  const stopDistanceHint = useMemo(() => {
    const entry = parseNumberInput(state.entry_price);
    const stop = parseNumberInput(state.stop_price);
    if (entry == null || stop == null) return null;
    return Math.abs(entry - stop);
  }, [state.entry_price, state.stop_price]);

  // Client-side OB-pct sanity check. Server also validates (0..100), but
  // catching it here saves a roundtrip.
  const obPctErrors = useMemo(() => {
    const errs: string[] = [];
    const check = (label: string, raw: string) => {
      const n = parseNumberInput(raw);
      if (n != null && (n < 0 || n > 100)) {
        errs.push(`${label} must be between 0 and 100.`);
      }
    };
    check('OB POC %', state.ob_poc_pct);
    check('OB secondary node %', state.ob_secondary_node_pct);
    check('OB tertiary node %', state.ob_tertiary_node_pct);
    return errs;
  }, [
    state.ob_poc_pct,
    state.ob_secondary_node_pct,
    state.ob_tertiary_node_pct,
  ]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (submitting) return;
      setFormError(null);

      if (obPctErrors.length > 0) {
        setFormError(obPctErrors.join(' '));
        return;
      }

      const legNumber = parseIntInput(state.leg_number);
      if (legNumber == null || legNumber < 1) {
        setFormError('Leg number must be 1 or greater.');
        return;
      }

      const legId =
        mode === 'edit' && initialLeg != null
          ? initialLeg.id
          : `${chainId}-L${legNumber}`;

      const wasProfitable =
        state.was_profitable === 'yes'
          ? true
          : state.was_profitable === 'no'
            ? false
            : null;

      const payload: PyramidLegInput = {
        id: legId,
        chain_id: chainId,
        leg_number: legNumber,
        signal_type: state.signal_type === '' ? null : state.signal_type,
        entry_time_ct:
          state.entry_time_ct.length > 0 ? state.entry_time_ct : null,
        entry_price: parseNumberInput(state.entry_price),
        stop_price: parseNumberInput(state.stop_price),
        stop_distance_pts: parseNumberInput(state.stop_distance_pts),
        vwap_at_entry: parseNumberInput(state.vwap_at_entry),
        vwap_1sd_upper: parseNumberInput(state.vwap_1sd_upper),
        vwap_1sd_lower: parseNumberInput(state.vwap_1sd_lower),
        vwap_band_position:
          state.vwap_band_position === '' ? null : state.vwap_band_position,
        vwap_band_distance_pts: parseNumberInput(state.vwap_band_distance_pts),
        minutes_since_chain_start: parseIntInput(
          state.minutes_since_chain_start,
        ),
        minutes_since_prior_bos: parseIntInput(state.minutes_since_prior_bos),
        ob_quality: parseIntInput(state.ob_quality),
        relative_volume: parseIntInput(state.relative_volume),
        session_phase: state.session_phase === '' ? null : state.session_phase,
        session_high_at_entry: parseNumberInput(state.session_high_at_entry),
        session_low_at_entry: parseNumberInput(state.session_low_at_entry),
        retracement_extreme_before_entry: parseNumberInput(
          state.retracement_extreme_before_entry,
        ),
        exit_price: parseNumberInput(state.exit_price),
        exit_reason: state.exit_reason === '' ? null : state.exit_reason,
        points_captured: parseNumberInput(state.points_captured),
        r_multiple: parseNumberInput(state.r_multiple),
        was_profitable: wasProfitable,
        notes: state.notes.length > 0 ? state.notes : null,
        ob_high: parseNumberInput(state.ob_high),
        ob_low: parseNumberInput(state.ob_low),
        ob_poc_price: parseNumberInput(state.ob_poc_price),
        ob_poc_pct: parseNumberInput(state.ob_poc_pct),
        ob_secondary_node_pct: parseNumberInput(state.ob_secondary_node_pct),
        ob_tertiary_node_pct: parseNumberInput(state.ob_tertiary_node_pct),
        ob_total_volume: parseNumberInput(state.ob_total_volume),
      };

      setSubmitting(true);
      try {
        await onSubmit(payload);
        onClose();
      } catch (err) {
        if (err instanceof PyramidApiError) {
          setFormError(pyramidApiErrorMessage(err));
        } else {
          setFormError('Unexpected error \u2014 please try again.');
          throw err;
        }
      } finally {
        setSubmitting(false);
      }
    },
    [
      submitting,
      state,
      obPctErrors,
      mode,
      initialLeg,
      chainId,
      onSubmit,
      onClose,
    ],
  );

  return (
    <PyramidTrackerModal
      open={open}
      onClose={onClose}
      title={mode === 'create' ? 'New Pyramid Leg' : 'Edit Pyramid Leg'}
      testId="pyramid-leg-modal"
    >
      <form
        onSubmit={handleSubmit}
        className="flex min-h-0 flex-1 flex-col"
        noValidate
      >
        <div className="border-edge flex flex-col gap-2 border-b px-5 py-3">
          <div className="text-muted font-mono text-[10px]">
            Chain: <span className="text-primary">{chainId}</span>
          </div>
          <CompletenessMeter filled={filled} total={total} />
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {formError != null && (
            <div
              role="alert"
              className="bg-surface-alt text-primary mb-3 rounded-md p-3 text-sm"
            >
              {formError}
            </div>
          )}

          {/* Section A */}
          <Section title="Identity & Timing">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Leg Number">
                <input
                  type="number"
                  step="1"
                  min="1"
                  value={state.leg_number}
                  onChange={(e) => set('leg_number', e.target.value)}
                  className={inputClass}
                  aria-label="Leg Number"
                />
              </Field>
              <Field label="Signal Type">
                <select
                  value={state.signal_type}
                  onChange={(e) =>
                    set('signal_type', e.target.value as PyramidSignalType | '')
                  }
                  className={inputClass}
                  aria-label="Signal Type"
                >
                  <option value="">{'\u2014'}</option>
                  {SIGNAL_TYPES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Entry Time (CT)">
                <input
                  type="time"
                  value={state.entry_time_ct}
                  onChange={(e) => handleEntryTimeChange(e.target.value)}
                  className={inputClass}
                  aria-label="Entry Time (CT)"
                />
              </Field>
              <Field label="Session Phase">
                <select
                  value={state.session_phase}
                  onChange={(e) => handlePhaseChange(e.target.value)}
                  className={inputClass}
                  aria-label="Session Phase"
                >
                  <option value="">{'\u2014'}</option>
                  {SESSION_PHASES.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Min Since Chain Start">
                <input
                  type="number"
                  step="1"
                  value={state.minutes_since_chain_start}
                  onChange={(e) =>
                    set('minutes_since_chain_start', e.target.value)
                  }
                  className={inputClass}
                  aria-label="Minutes Since Chain Start"
                />
              </Field>
              <Field label="Min Since Prior BOS">
                <input
                  type="number"
                  step="1"
                  value={state.minutes_since_prior_bos}
                  onChange={(e) =>
                    set('minutes_since_prior_bos', e.target.value)
                  }
                  className={inputClass}
                  aria-label="Minutes Since Prior BOS"
                />
              </Field>
            </div>
          </Section>

          {/* Section B */}
          <Section title="Entry & Stop">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Entry Price">
                <input
                  type="number"
                  step="any"
                  value={state.entry_price}
                  onChange={(e) => set('entry_price', e.target.value)}
                  className={inputClass}
                  aria-label="Entry Price"
                />
              </Field>
              <Field label="Stop Price">
                <input
                  type="number"
                  step="any"
                  value={state.stop_price}
                  onChange={(e) => set('stop_price', e.target.value)}
                  className={inputClass}
                  aria-label="Stop Price"
                />
              </Field>
              <Field label="Stop Distance (pts)">
                <input
                  type="number"
                  step="any"
                  value={state.stop_distance_pts}
                  onChange={(e) => set('stop_distance_pts', e.target.value)}
                  className={inputClass}
                  aria-label="Stop Distance (pts)"
                  placeholder={
                    stopDistanceHint != null
                      ? stopDistanceHint.toFixed(2)
                      : undefined
                  }
                />
              </Field>
            </div>
          </Section>

          {/* Section C */}
          <Section title="VWAP Context">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="VWAP at Entry">
                <input
                  type="number"
                  step="any"
                  value={state.vwap_at_entry}
                  onChange={(e) => set('vwap_at_entry', e.target.value)}
                  className={inputClass}
                  aria-label="VWAP at Entry"
                />
              </Field>
              <Field label="VWAP Band Position">
                <select
                  value={state.vwap_band_position}
                  onChange={(e) =>
                    set(
                      'vwap_band_position',
                      e.target.value as PyramidVwapBandPosition | '',
                    )
                  }
                  className={inputClass}
                  aria-label="VWAP Band Position"
                >
                  <option value="">{'\u2014'}</option>
                  {VWAP_BAND_POSITIONS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="VWAP 1sd Upper">
                <input
                  type="number"
                  step="any"
                  value={state.vwap_1sd_upper}
                  onChange={(e) => set('vwap_1sd_upper', e.target.value)}
                  className={inputClass}
                  aria-label="VWAP 1sd Upper"
                />
              </Field>
              <Field label="VWAP 1sd Lower">
                <input
                  type="number"
                  step="any"
                  value={state.vwap_1sd_lower}
                  onChange={(e) => set('vwap_1sd_lower', e.target.value)}
                  className={inputClass}
                  aria-label="VWAP 1sd Lower"
                />
              </Field>
              <Field label="Band Distance (pts)" className="sm:col-span-2">
                <input
                  type="number"
                  step="any"
                  value={state.vwap_band_distance_pts}
                  onChange={(e) =>
                    set('vwap_band_distance_pts', e.target.value)
                  }
                  className={inputClass}
                  aria-label="VWAP Band Distance (pts)"
                />
              </Field>
            </div>
          </Section>

          {/* Section D */}
          <Section title="Order Block">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="OB High">
                <input
                  type="number"
                  step="any"
                  value={state.ob_high}
                  onChange={(e) => set('ob_high', e.target.value)}
                  className={inputClass}
                  aria-label="OB High"
                />
              </Field>
              <Field label="OB Low">
                <input
                  type="number"
                  step="any"
                  value={state.ob_low}
                  onChange={(e) => set('ob_low', e.target.value)}
                  className={inputClass}
                  aria-label="OB Low"
                />
              </Field>
              <Field label="OB POC Price">
                <input
                  type="number"
                  step="any"
                  value={state.ob_poc_price}
                  onChange={(e) => set('ob_poc_price', e.target.value)}
                  className={inputClass}
                  aria-label="OB POC Price"
                />
              </Field>
              <Field label="OB POC %">
                <input
                  type="number"
                  step="any"
                  min="0"
                  max="100"
                  value={state.ob_poc_pct}
                  onChange={(e) => set('ob_poc_pct', e.target.value)}
                  className={inputClass}
                  aria-label="OB POC %"
                />
              </Field>
              <Field label="OB Secondary Node %">
                <input
                  type="number"
                  step="any"
                  min="0"
                  max="100"
                  value={state.ob_secondary_node_pct}
                  onChange={(e) => set('ob_secondary_node_pct', e.target.value)}
                  className={inputClass}
                  aria-label="OB Secondary Node %"
                />
              </Field>
              <Field label="OB Tertiary Node %">
                <input
                  type="number"
                  step="any"
                  min="0"
                  max="100"
                  value={state.ob_tertiary_node_pct}
                  onChange={(e) => set('ob_tertiary_node_pct', e.target.value)}
                  className={inputClass}
                  aria-label="OB Tertiary Node %"
                />
              </Field>
              <Field label="OB Total Volume">
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={state.ob_total_volume}
                  onChange={(e) => set('ob_total_volume', e.target.value)}
                  className={inputClass}
                  aria-label="OB Total Volume"
                />
              </Field>
              <Field label="OB Quality (1-5)">
                <input
                  type="number"
                  step="1"
                  min="1"
                  max="5"
                  value={state.ob_quality}
                  onChange={(e) => set('ob_quality', e.target.value)}
                  className={inputClass}
                  aria-label="OB Quality (1-5)"
                />
              </Field>
              <Field label="Relative Volume (1-5)">
                <input
                  type="number"
                  step="1"
                  min="1"
                  max="5"
                  value={state.relative_volume}
                  onChange={(e) => set('relative_volume', e.target.value)}
                  className={inputClass}
                  aria-label="Relative Volume (1-5)"
                />
              </Field>
            </div>
          </Section>

          {/* Section E */}
          <Section title="Session Context">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Session High at Entry">
                <input
                  type="number"
                  step="any"
                  value={state.session_high_at_entry}
                  onChange={(e) => set('session_high_at_entry', e.target.value)}
                  className={inputClass}
                  aria-label="Session High at Entry"
                />
              </Field>
              <Field label="Session Low at Entry">
                <input
                  type="number"
                  step="any"
                  value={state.session_low_at_entry}
                  onChange={(e) => set('session_low_at_entry', e.target.value)}
                  className={inputClass}
                  aria-label="Session Low at Entry"
                />
              </Field>
              <Field label="Retrace Extreme Before Entry">
                <input
                  type="number"
                  step="any"
                  value={state.retracement_extreme_before_entry}
                  onChange={(e) =>
                    set('retracement_extreme_before_entry', e.target.value)
                  }
                  className={inputClass}
                  aria-label="Retracement Extreme Before Entry"
                />
              </Field>
            </div>
          </Section>

          {/* Section F */}
          <Section
            title="Outcome"
            subtitle="Fill after the trade closes \u2014 all fields optional"
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Exit Price">
                <input
                  type="number"
                  step="any"
                  value={state.exit_price}
                  onChange={(e) => set('exit_price', e.target.value)}
                  className={inputClass}
                  aria-label="Exit Price"
                />
              </Field>
              <Field label="Exit Reason">
                <select
                  value={state.exit_reason}
                  onChange={(e) =>
                    set(
                      'exit_reason',
                      e.target.value as PyramidExitReasonLeg | '',
                    )
                  }
                  className={inputClass}
                  aria-label="Exit Reason"
                >
                  <option value="">{'\u2014'}</option>
                  {LEG_EXIT_REASONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Points Captured">
                <input
                  type="number"
                  step="any"
                  value={state.points_captured}
                  onChange={(e) => set('points_captured', e.target.value)}
                  className={inputClass}
                  aria-label="Points Captured"
                />
              </Field>
              <Field label="R Multiple">
                <input
                  type="number"
                  step="any"
                  value={state.r_multiple}
                  onChange={(e) => set('r_multiple', e.target.value)}
                  className={inputClass}
                  aria-label="R Multiple"
                />
              </Field>
              <Field label="Was Profitable" className="sm:col-span-2">
                <select
                  value={state.was_profitable}
                  onChange={(e) =>
                    set(
                      'was_profitable',
                      e.target.value as 'yes' | 'no' | 'unknown',
                    )
                  }
                  className={inputClass}
                  aria-label="Was Profitable"
                >
                  <option value="unknown">Unknown</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </Field>
            </div>
          </Section>

          {/* Section G */}
          <Section title="Notes">
            <Field label="Notes">
              <textarea
                value={state.notes}
                rows={3}
                onChange={(e) => set('notes', e.target.value)}
                className={inputClass + ' resize-y'}
                aria-label="Notes"
              />
            </Field>
          </Section>
        </div>

        <footer className="border-edge flex items-center justify-end gap-2 border-t px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="border-edge-strong bg-chip-bg text-primary hover:bg-surface-alt cursor-pointer rounded-md border-[1.5px] px-3 py-1.5 font-sans text-xs font-semibold disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="bg-accent flex items-center gap-2 rounded-md px-4 py-1.5 font-sans text-xs font-bold tracking-wider text-white uppercase disabled:opacity-50"
          >
            {submitting && (
              <span
                className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/60 border-t-white"
                aria-hidden="true"
              />
            )}
            {submitting ? 'Saving\u2026' : 'Save'}
          </button>
        </footer>
      </form>
    </PyramidTrackerModal>
  );
}

// ============================================================
// Sub-components
// ============================================================

const inputClass =
  'border-edge bg-input text-primary w-full rounded-md border px-2 py-1.5 font-mono text-[12px] outline-none focus:border-[var(--color-focus-ring)]';

function Field({
  label,
  className,
  children,
}: {
  readonly label: string;
  readonly className?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-1 ${className ?? ''}`}>
      <span className="text-muted font-sans text-[10px] tracking-wider uppercase">
        {label}
      </span>
      {children}
    </label>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <fieldset className="border-edge mt-2 mb-4 border-t pt-3 first:mt-0 first:border-t-0 first:pt-0">
      <legend className="text-tertiary font-sans text-[11px] font-bold tracking-[0.12em] uppercase">
        {title}
      </legend>
      {subtitle != null && (
        <p className="text-muted mt-0.5 mb-2 font-sans text-[10px] italic">
          {subtitle}
        </p>
      )}
      {children}
    </fieldset>
  );
}
