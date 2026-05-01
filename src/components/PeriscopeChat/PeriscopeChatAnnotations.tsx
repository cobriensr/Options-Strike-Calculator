/**
 * Inline annotation editor — calibration stars (1-5) + regime tag
 * dropdown. PATCHes updates to /api/periscope-chat-update. The UI
 * reflects new values only after the server confirms; on error the
 * displayed value stays at the prop value (no local override flip).
 *
 * Note: the regime-tag dropdown only shows the "(unset)" option when
 * the row has no tag yet. Once a tag is set, "(unset)" is hidden —
 * the current update endpoint treats omitted/null fields as "no
 * change" (COALESCE), so there's no clear-to-null path. Adding clear
 * semantics is a follow-up endpoint change.
 *
 * Used inside PeriscopeChatDetail and reusable from any row that needs
 * to edit annotations. The parent owns the row and gets a callback
 * when the server confirms the update so its local cache can mirror.
 */

import { useCallback, useState } from 'react';
import { REGIME_TAG_OPTIONS } from './types.js';

interface AnnotationServerResponse {
  id: number;
  calibration_quality: number | null;
  regime_tag: string | null;
}

interface PeriscopeChatAnnotationsProps {
  rowId: number;
  calibrationQuality: number | null;
  regimeTag: string | null;
  onSaved: (next: AnnotationServerResponse) => void;
}

const STAR_VALUES = [1, 2, 3, 4, 5] as const;

export default function PeriscopeChatAnnotations({
  rowId,
  calibrationQuality,
  regimeTag,
  onSaved,
}: PeriscopeChatAnnotationsProps) {
  const [savingField, setSavingField] = useState<
    'calibration_quality' | 'regime_tag' | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  const update = useCallback(
    async (body: { calibration_quality?: number; regime_tag?: string }) => {
      const field =
        body.calibration_quality !== undefined
          ? 'calibration_quality'
          : 'regime_tag';
      setSavingField(field);
      setError(null);
      try {
        const res = await fetch(`/api/periscope-chat-update?id=${rowId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(errBody.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as AnnotationServerResponse;
        onSaved(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Update failed');
      } finally {
        setSavingField(null);
      }
    },
    [rowId, onSaved],
  );

  return (
    <div className="flex flex-wrap items-center gap-3 text-xs">
      {/* Calibration stars */}
      <div
        className="flex items-center gap-1"
        role="radiogroup"
        aria-label="Calibration quality"
      >
        <span className="text-muted text-[10px] tracking-wide uppercase">
          Quality
        </span>
        {STAR_VALUES.map((n) => {
          const filled = calibrationQuality != null && calibrationQuality >= n;
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={calibrationQuality === n}
              aria-label={`${n} star${n === 1 ? '' : 's'}`}
              disabled={savingField !== null}
              onClick={() => {
                void update({ calibration_quality: n });
              }}
              className={`text-base leading-none transition disabled:opacity-50 ${
                filled ? 'text-yellow-400' : 'text-muted hover:text-yellow-300'
              }`}
            >
              {filled ? '★' : '☆'}
            </button>
          );
        })}
        {calibrationQuality != null && (
          <span className="text-muted ml-1 font-mono">
            ({calibrationQuality}/5)
          </span>
        )}
      </div>

      {/* Regime tag dropdown. (unset) shown only when no tag is set yet —
          the update endpoint can't clear back to null today, so we hide
          the affordance once a value exists rather than offer a no-op. */}
      <label className="flex items-center gap-1">
        <span className="text-muted text-[10px] tracking-wide uppercase">
          Regime
        </span>
        <select
          value={regimeTag ?? ''}
          onChange={(e) => {
            const next = e.target.value;
            if (next === '') return;
            void update({ regime_tag: next });
          }}
          disabled={savingField !== null}
          className="border-edge bg-surface text-primary cursor-pointer rounded border px-2 py-0.5 font-mono text-xs focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-50"
        >
          {regimeTag == null && <option value="">(unset)</option>}
          {REGIME_TAG_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </label>

      {savingField && <span className="text-muted">Saving {savingField}…</span>}
      {error && (
        <span className="text-red-400" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
