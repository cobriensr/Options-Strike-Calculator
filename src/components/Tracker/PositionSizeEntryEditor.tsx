/**
 * PositionSizeEntryEditor — edit the most fundamental fields on a
 * tracked contract: size (integer contracts) and entry price (dollars).
 *
 * UX decisions:
 *
 *   - Always-visible inputs, mirroring `ThresholdsEditor` / `SpotAlertsEditor`.
 *   - Explicit Save button (not debounced auto-save). Entry price and
 *     size are higher-stakes than thresholds; a typo here changes PnL,
 *     so the click-to-commit gesture is intentional.
 *   - Save is gated to dirty + valid inputs. Pristine state shows the
 *     pre-filled values so users can read current size/entry at a glance.
 *   - Errors render inline (role="alert"); successful saves clear them.
 */

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';

/**
 * Minimum entry price the database can store without underflow. The
 * `entry_price NUMERIC(10,4)` column rounds anything below 5e-5 to 0,
 * which corrupts PnL math downstream. Reject values like `1e-12`
 * client-side so the server never sees them.
 */
const MIN_ENTRY_DOLLARS = 0.0001;

interface Props {
  quantity: number;
  /** Entry price as a string straight off the API (NUMERIC column). */
  entryPrice: string;
  /**
   * Async save callback. Parent maps this to
   * `update(id, { quantity, entry_price })`.
   */
  onSave: (next: { quantity: number; entryPrice: number }) => Promise<void>;
}

export const PositionSizeEntryEditor = memo(function PositionSizeEntryEditor({
  quantity,
  entryPrice,
  onSave,
}: Props) {
  // The API entry_price is a NUMERIC string ("4.3000"). Trim trailing
  // zeros for the input default so users see "4.3" not "4.3000".
  const formattedEntry = formatEntry(entryPrice);

  const [qtyDraft, setQtyDraft] = useState(String(quantity));
  const [entryDraft, setEntryDraft] = useState(formattedEntry);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track the last-seen prop values so we can resync drafts ONLY when
  // either (a) the user hasn't dirtied the inputs (drafts still match
  // the previous props), or (b) the parent genuinely changed contract
  // (different row mounted). Without this, a 30s tracker poll firing
  // mid-edit would silently clobber the user's typed-but-unsaved draft.
  const lastProps = useRef({ quantity, formattedEntry });
  useEffect(() => {
    const prev = lastProps.current;
    const propsChanged =
      prev.quantity !== quantity || prev.formattedEntry !== formattedEntry;
    if (!propsChanged) return;

    // Draft is "pristine" iff it still matches the prior props we
    // last synced from. If so, accept the new props transparently.
    // Otherwise, the user is mid-edit — leave their draft alone.
    const pristine =
      qtyDraft === String(prev.quantity) && entryDraft === prev.formattedEntry;
    if (pristine) {
      setQtyDraft(String(quantity));
      setEntryDraft(formattedEntry);
      setError(null);
    }
    lastProps.current = { quantity, formattedEntry };
  }, [quantity, formattedEntry, qtyDraft, entryDraft]);

  const parsedQty = Number.parseInt(qtyDraft, 10);
  const parsedEntry = Number.parseFloat(entryDraft);
  const qtyValid =
    Number.isFinite(parsedQty) &&
    parsedQty >= 1 &&
    parsedQty === Number(qtyDraft);
  // Reject anything below the column's effective precision floor —
  // `1e-12` is a finite positive number but rounds to 0 on the
  // NUMERIC(10,4) column, corrupting realized PnL.
  const entryValid =
    Number.isFinite(parsedEntry) && parsedEntry >= MIN_ENTRY_DOLLARS;
  const dirty =
    parsedQty !== quantity ||
    Math.abs(parsedEntry - Number.parseFloat(entryPrice)) > 1e-9;
  const canSave = qtyValid && entryValid && dirty && !saving;

  const handleSave = useCallback(async () => {
    setError(null);
    if (!qtyValid) {
      setError('Size must be a positive integer');
      return;
    }
    if (!entryValid) {
      setError(`Entry price must be at least $${MIN_ENTRY_DOLLARS}`);
      return;
    }
    setSaving(true);
    try {
      await onSave({ quantity: parsedQty, entryPrice: parsedEntry });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [qtyValid, entryValid, parsedQty, parsedEntry, onSave]);

  return (
    <div className="border-edge border-b pb-3">
      <div className="text-tertiary mb-1.5 font-sans text-[11px] font-semibold uppercase">
        Position size &amp; entry
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5">
          <span className="text-tertiary font-sans text-[11px]">Size</span>
          <input
            type="number"
            min="1"
            step="1"
            value={qtyDraft}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setQtyDraft(e.target.value)
            }
            aria-label="Position size (contracts)"
            className="border-edge bg-surface focus:border-accent w-20 rounded border px-1.5 py-0.5 font-mono text-[11px] outline-none"
          />
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-tertiary font-sans text-[11px]">Entry $</span>
          <input
            type="number"
            min={MIN_ENTRY_DOLLARS}
            step="0.01"
            value={entryDraft}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setEntryDraft(e.target.value)
            }
            aria-label="Entry price (dollars)"
            className="border-edge bg-surface focus:border-accent w-24 rounded border px-1.5 py-0.5 font-mono text-[11px] outline-none"
          />
        </label>
        <button
          type="button"
          onClick={() => {
            void handleSave();
          }}
          disabled={!canSave}
          className="bg-accent cursor-pointer rounded px-3 py-1 font-sans text-[12px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {error && (
          <span role="alert" className="text-danger font-sans text-[11px]">
            {error}
          </span>
        )}
      </div>
    </div>
  );
});

/**
 * Strip trailing zeros from a NUMERIC string so "4.3000" → "4.3" but
 * "4.00" → "4". Falls back to the raw string if parsing fails so we
 * never silently lose precision.
 */
function formatEntry(raw: string): string {
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return raw;
  // Strip trailing zeros without losing precision via Number.toString().
  // "4.3000" → 4.3 → "4.3"; "4.00" → 4 → "4"; "4.25" → "4.25".
  return String(n);
}
