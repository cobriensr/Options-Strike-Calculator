/**
 * ChainFormModal — create or edit a pyramid chain (session-level metadata).
 *
 * All feature fields are optional; only the chain `id` is strictly required
 * when creating (immutable in edit mode). Save is always enabled even with
 * partial data — the soft-pressure "Complete: XX%" meter nudges toward
 * fuller rows without hard-blocking.
 *
 * Submission model (spec "Option A"): `onSubmit` is an async callback from
 * the parent (PyramidTrackerSection) that calls the usePyramidData mutation
 * helper. The modal tracks its own `submitting` flag so the hook-level
 * `loading` revalidation after a successful write doesn't collide with the
 * form UX.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  PyramidChain,
  PyramidChainInput,
  PyramidDayType,
  PyramidDirection,
  PyramidExitReasonChain,
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
  stringToInput,
  suggestChainId,
  todayIsoDate,
} from './pyramid-form-helpers';

// ============================================================
// Props
// ============================================================

export interface ChainFormModalProps {
  readonly mode: 'create' | 'edit';
  readonly initialChain?: PyramidChain;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (values: PyramidChainInput) => Promise<void>;
}

// ============================================================
// Constants
// ============================================================

const INSTRUMENTS = ['MNQ', 'MES', 'ES', 'NQ'] as const;

const DIRECTIONS: ReadonlyArray<{ value: PyramidDirection; label: string }> = [
  { value: 'long', label: 'Long' },
  { value: 'short', label: 'Short' },
];

const EXIT_REASONS: ReadonlyArray<{
  value: PyramidExitReasonChain;
  label: string;
}> = [
  { value: 'reverse_choch', label: 'Reverse CHoCH' },
  { value: 'stopped_out', label: 'Stopped Out' },
  { value: 'manual', label: 'Manual' },
  { value: 'eod', label: 'End of Day' },
];

const DAY_TYPES: ReadonlyArray<{ value: PyramidDayType; label: string }> = [
  { value: 'trend', label: 'Trend' },
  { value: 'chop', label: 'Chop' },
  { value: 'news', label: 'News' },
  { value: 'mixed', label: 'Mixed' },
];

// ============================================================
// Form state
// ============================================================

interface ChainFormState {
  id: string;
  trade_date: string;
  instrument: string;
  direction: PyramidDirection | '';
  entry_time_ct: string;
  exit_time_ct: string;
  initial_entry_price: string;
  final_exit_price: string;
  exit_reason: PyramidExitReasonChain | '';
  total_legs: string;
  winning_legs: string;
  net_points: string;
  session_atr_pct: string;
  day_type: PyramidDayType | '';
  higher_tf_bias: string;
  notes: string;
  status: 'open' | 'closed';
}

function initialStateFromChain(
  chain: PyramidChain | undefined,
): ChainFormState {
  if (chain == null) {
    return {
      id: '',
      trade_date: todayIsoDate(),
      instrument: 'MNQ',
      direction: '',
      entry_time_ct: '',
      exit_time_ct: '',
      initial_entry_price: '',
      final_exit_price: '',
      exit_reason: '',
      total_legs: '',
      winning_legs: '',
      net_points: '',
      session_atr_pct: '',
      day_type: '',
      higher_tf_bias: '',
      notes: '',
      status: 'open',
    };
  }
  return {
    id: chain.id,
    trade_date: stringToInput(chain.trade_date),
    instrument: stringToInput(chain.instrument) || 'MNQ',
    direction: chain.direction ?? '',
    entry_time_ct: stringToInput(chain.entry_time_ct),
    exit_time_ct: stringToInput(chain.exit_time_ct),
    initial_entry_price: numberToInput(chain.initial_entry_price),
    final_exit_price: numberToInput(chain.final_exit_price),
    exit_reason: chain.exit_reason ?? '',
    total_legs: numberToInput(chain.total_legs),
    winning_legs: numberToInput(chain.winning_legs),
    net_points: numberToInput(chain.net_points),
    session_atr_pct: numberToInput(chain.session_atr_pct),
    day_type: chain.day_type ?? '',
    higher_tf_bias: stringToInput(chain.higher_tf_bias),
    notes: stringToInput(chain.notes),
    status: chain.status,
  };
}

// ============================================================
// Component
// ============================================================

export default function ChainFormModal({
  mode,
  initialChain,
  open,
  onClose,
  onSubmit,
}: ChainFormModalProps) {
  const [state, setState] = useState<ChainFormState>(() =>
    initialStateFromChain(initialChain),
  );
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Reset form whenever the modal re-opens so a closed-then-reopened create
  // modal starts fresh, and an edit modal hydrates with the latest row.
  useEffect(() => {
    if (open) {
      setState(initialStateFromChain(initialChain));
      setFormError(null);
      setSubmitting(false);
    }
  }, [open, initialChain]);

  const set = useCallback(
    <K extends keyof ChainFormState>(key: K, value: ChainFormState[K]) => {
      setState((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  // Completeness meter: all fillable fields except the identity `id` and
  // system fields (status, timestamps — timestamps aren't even in form
  // state, so just `id` to exclude here). Booleans count as filled when
  // set; empty strings don't.
  const fillValues = useMemo(
    () => [
      state.trade_date,
      state.instrument,
      state.direction,
      state.entry_time_ct,
      state.exit_time_ct,
      state.initial_entry_price,
      state.final_exit_price,
      state.exit_reason,
      state.total_legs,
      state.winning_legs,
      state.net_points,
      state.session_atr_pct,
      state.day_type,
      state.higher_tf_bias,
      state.notes,
    ],
    [state],
  );
  const filled = countFilled(fillValues);
  const total = fillValues.length;

  const handleSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (submitting) return;
      setFormError(null);

      // Build the input payload. Empty strings -> null so the server stores
      // NULL instead of the literal "". `id` is always required; in edit
      // mode it's readonly and carried through unchanged.
      const id =
        mode === 'create' && state.id.trim().length === 0
          ? suggestChainId(state.trade_date, state.instrument)
          : state.id;

      const payload: PyramidChainInput = {
        id,
        trade_date: state.trade_date.length > 0 ? state.trade_date : null,
        instrument: state.instrument.length > 0 ? state.instrument : null,
        direction: state.direction === '' ? null : state.direction,
        entry_time_ct:
          state.entry_time_ct.length > 0 ? state.entry_time_ct : null,
        exit_time_ct: state.exit_time_ct.length > 0 ? state.exit_time_ct : null,
        initial_entry_price: parseNumberInput(state.initial_entry_price),
        final_exit_price: parseNumberInput(state.final_exit_price),
        exit_reason: state.exit_reason === '' ? null : state.exit_reason,
        total_legs: parseIntInput(state.total_legs),
        winning_legs: parseIntInput(state.winning_legs),
        net_points: parseNumberInput(state.net_points),
        session_atr_pct: parseNumberInput(state.session_atr_pct),
        day_type: state.day_type === '' ? null : state.day_type,
        higher_tf_bias:
          state.higher_tf_bias.length > 0 ? state.higher_tf_bias : null,
        notes: state.notes.length > 0 ? state.notes : null,
        // Create defaults to 'open'; edit carries whatever the user picked.
        status: mode === 'create' ? 'open' : state.status,
      };

      setSubmitting(true);
      try {
        await onSubmit(payload);
        onClose();
      } catch (err) {
        if (err instanceof PyramidApiError) {
          setFormError(pyramidApiErrorMessage(err));
        } else {
          setFormError('Unexpected error — please try again.');
          // Re-throw so Sentry sees unknowns.
          throw err;
        }
      } finally {
        setSubmitting(false);
      }
    },
    [mode, state, onSubmit, onClose, submitting],
  );

  return (
    <PyramidTrackerModal
      open={open}
      onClose={onClose}
      title={mode === 'create' ? 'New Pyramid Chain' : 'Edit Pyramid Chain'}
      testId="pyramid-chain-modal"
    >
      <form
        onSubmit={handleSubmit}
        className="flex min-h-0 flex-1 flex-col"
        noValidate
      >
        <div className="border-edge flex flex-col gap-3 border-b px-5 py-3">
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

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Chain ID">
              <input
                type="text"
                value={state.id}
                readOnly={mode === 'edit'}
                placeholder={suggestChainId(state.trade_date, state.instrument)}
                onChange={(e) => set('id', e.target.value)}
                className={inputClass}
                aria-label="Chain ID"
              />
            </Field>

            <Field label="Trade Date">
              <input
                type="date"
                value={state.trade_date}
                onChange={(e) => set('trade_date', e.target.value)}
                className={inputClass}
                aria-label="Trade Date"
              />
            </Field>

            <Field label="Instrument">
              <select
                value={state.instrument}
                onChange={(e) => set('instrument', e.target.value)}
                className={inputClass}
                aria-label="Instrument"
              >
                {INSTRUMENTS.map((sym) => (
                  <option key={sym} value={sym}>
                    {sym}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Direction">
              <select
                value={state.direction}
                onChange={(e) =>
                  set('direction', e.target.value as PyramidDirection | '')
                }
                className={inputClass}
                aria-label="Direction"
              >
                <option value="">{'\u2014'}</option>
                {DIRECTIONS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Entry Time (CT)">
              <input
                type="time"
                value={state.entry_time_ct}
                onChange={(e) => set('entry_time_ct', e.target.value)}
                className={inputClass}
                aria-label="Entry Time (CT)"
              />
            </Field>

            <Field label="Exit Time (CT)">
              <input
                type="time"
                value={state.exit_time_ct}
                onChange={(e) => set('exit_time_ct', e.target.value)}
                className={inputClass}
                aria-label="Exit Time (CT)"
              />
            </Field>

            <Field label="Initial Entry Price">
              <input
                type="number"
                step="any"
                value={state.initial_entry_price}
                onChange={(e) => set('initial_entry_price', e.target.value)}
                className={inputClass}
                aria-label="Initial Entry Price"
              />
            </Field>

            <Field label="Final Exit Price">
              <input
                type="number"
                step="any"
                value={state.final_exit_price}
                onChange={(e) => set('final_exit_price', e.target.value)}
                className={inputClass}
                aria-label="Final Exit Price"
              />
            </Field>

            <Field label="Exit Reason">
              <select
                value={state.exit_reason}
                onChange={(e) =>
                  set(
                    'exit_reason',
                    e.target.value as PyramidExitReasonChain | '',
                  )
                }
                className={inputClass}
                aria-label="Exit Reason"
              >
                <option value="">{'\u2014'}</option>
                {EXIT_REASONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Day Type">
              <select
                value={state.day_type}
                onChange={(e) =>
                  set('day_type', e.target.value as PyramidDayType | '')
                }
                className={inputClass}
                aria-label="Day Type"
              >
                <option value="">{'\u2014'}</option>
                {DAY_TYPES.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Total Legs">
              <input
                type="number"
                step="1"
                min="0"
                value={state.total_legs}
                onChange={(e) => set('total_legs', e.target.value)}
                className={inputClass}
                aria-label="Total Legs"
              />
            </Field>

            <Field label="Winning Legs">
              <input
                type="number"
                step="1"
                min="0"
                value={state.winning_legs}
                onChange={(e) => set('winning_legs', e.target.value)}
                className={inputClass}
                aria-label="Winning Legs"
              />
            </Field>

            <Field label="Net Points">
              <input
                type="number"
                step="any"
                value={state.net_points}
                onChange={(e) => set('net_points', e.target.value)}
                className={inputClass}
                aria-label="Net Points"
              />
            </Field>

            <Field label="Session ATR %">
              <input
                type="number"
                step="any"
                value={state.session_atr_pct}
                onChange={(e) => set('session_atr_pct', e.target.value)}
                className={inputClass}
                aria-label="Session ATR %"
              />
            </Field>

            <Field label="Higher TF Bias" className="sm:col-span-2">
              <input
                type="text"
                value={state.higher_tf_bias}
                placeholder="e.g. bullish above 21200"
                onChange={(e) => set('higher_tf_bias', e.target.value)}
                className={inputClass}
                aria-label="Higher TF Bias"
              />
            </Field>

            {mode === 'edit' && (
              <Field label="Status">
                <select
                  value={state.status}
                  onChange={(e) =>
                    set('status', e.target.value as 'open' | 'closed')
                  }
                  className={inputClass}
                  aria-label="Status"
                >
                  <option value="open">Open</option>
                  <option value="closed">Closed</option>
                </select>
              </Field>
            )}

            <Field label="Notes" className="sm:col-span-2">
              <textarea
                value={state.notes}
                rows={3}
                onChange={(e) => set('notes', e.target.value)}
                className={inputClass + ' resize-y'}
                aria-label="Notes"
              />
            </Field>
          </div>
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
