/**
 * TracePinForm — Manual entry for TRACE Delta Pressure EOD pin predictions.
 *
 * Read the zero-delta black band level from SpotGamma's TRACE Delta Pressure
 * chart at 8:30 AM CT, enter it here. Actual closes are filled by the
 * nightly pipeline.
 */

import { useState, useEffect, useCallback } from 'react';
import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';

type Confidence = 'high' | 'medium' | 'low';

interface TracePrediction {
  date: string;
  predicted_close: number;
  confidence: Confidence;
  notes: string | null;
  actual_close: number | null;
  current_price: number | null;
}

function todayLocal(): string {
  const d = new Date();
  return [
    String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

export default function TracePinForm() {
  const [date, setDate] = useState(todayLocal);
  const [predictedClose, setPredictedClose] = useState('');
  const [confidence, setConfidence] = useState<Confidence>('medium');
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [predictions, setPredictions] = useState<TracePrediction[]>([]);
  const [loading, setLoading] = useState(true);

  const loadPredictions = useCallback(async () => {
    try {
      const res = await fetch('/api/trace/prediction');
      if (res.ok) {
        const data = (await res.json()) as TracePrediction[];
        setPredictions(data);
      }
    } catch {
      // non-critical — table may not exist yet before first migration run
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPredictions();
  }, [loadPredictions]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const value = Number.parseFloat(predictedClose);
      if (!date || Number.isNaN(value)) return;
      setSubmitting(true);
      setSubmitError('');
      setSaved(false);
      try {
        const res = await fetch('/api/trace/prediction', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date, predicted_close: value, confidence }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setSubmitError(data.error ?? 'Save failed');
        } else {
          setSaved(true);
          setPredictedClose('');
          void loadPredictions();
        }
      } catch {
        setSubmitError('Network error');
      } finally {
        setSubmitting(false);
      }
    },
    [date, predictedClose, confidence, loadPredictions],
  );

  return (
    <div
      className="border-edge mt-4 rounded-lg border p-4"
      style={{ backgroundColor: tint(theme.surfaceAlt, '40') }}
    >
      <h3
        className="mb-3 font-sans text-[12px] font-semibold uppercase tracking-wider"
        style={{ color: theme.textMuted }}
      >
        Log TRACE Pin Prediction
      </h3>

      <form onSubmit={handleSubmit} className="mb-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span
            className="font-sans text-[10px] uppercase tracking-wide"
            style={{ color: theme.textMuted }}
          >
            Date
          </span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="border-edge rounded border bg-transparent px-2 py-1.5 font-mono text-[12px]"
            style={{ color: theme.text }}
            required
          />
        </label>

        <label className="flex flex-col gap-1">
          <span
            className="font-sans text-[10px] uppercase tracking-wide"
            style={{ color: theme.textMuted }}
          >
            Predicted Close
          </span>
          <input
            type="number"
            value={predictedClose}
            onChange={(e) => setPredictedClose(e.target.value)}
            placeholder="e.g. 6920"
            step="0.5"
            min="0"
            className="border-edge w-28 rounded border bg-transparent px-2 py-1.5 font-mono text-[12px]"
            style={{ color: theme.text }}
            required
          />
        </label>

        <label className="flex flex-col gap-1">
          <span
            className="font-sans text-[10px] uppercase tracking-wide"
            style={{ color: theme.textMuted }}
          >
            Confidence
          </span>
          <select
            value={confidence}
            onChange={(e) =>
              setConfidence(e.target.value as Confidence)
            }
            className="border-edge rounded border px-2 py-1.5 font-sans text-[12px]"
            style={{ color: theme.text, backgroundColor: theme.surfaceAlt }}
          >
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </label>

        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={submitting || !predictedClose}
            className="rounded px-3 py-1.5 font-sans text-[12px] font-semibold transition-opacity disabled:opacity-40"
            style={{ backgroundColor: theme.accent, color: '#fff' }}
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
          {saved && (
            <span className="font-sans text-[11px]" style={{ color: theme.green }}>
              Saved
            </span>
          )}
          {submitError && (
            <span className="font-sans text-[11px]" style={{ color: theme.red }}>
              {submitError}
            </span>
          )}
        </div>
      </form>

      {loading ? (
        <p
          className="animate-pulse font-sans text-[11px]"
          style={{ color: theme.textMuted }}
        >
          Loading…
        </p>
      ) : predictions.length === 0 ? (
        <p className="font-sans text-[11px]" style={{ color: theme.textMuted }}>
          No predictions yet.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr
                className="border-edge border-b text-left"
                style={{ color: theme.textMuted }}
              >
                {['Date', 'Predicted', 'Actual', 'Error', 'Conf'].map((h) => (
                  <th
                    key={h}
                    className="pb-1.5 pr-4 font-sans text-[10px] font-medium uppercase tracking-wide last:pr-0"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {predictions.map((p) => {
                const err =
                  p.actual_close != null
                    ? p.actual_close - p.predicted_close
                    : null;
                const errColor =
                  err == null
                    ? theme.textMuted
                    : Math.abs(err) <= 5
                      ? theme.green
                      : Math.abs(err) <= 15
                        ? theme.text
                        : theme.red;
                return (
                  <tr key={p.date} className="border-edge border-b last:border-0">
                    <td
                      className="py-1.5 pr-4 font-mono text-[11px]"
                      style={{ color: theme.text }}
                    >
                      {p.date}
                    </td>
                    <td
                      className="py-1.5 pr-4 font-mono text-[11px]"
                      style={{ color: theme.text }}
                    >
                      {p.predicted_close.toFixed(0)}
                    </td>
                    <td
                      className="py-1.5 pr-4 font-mono text-[11px]"
                      style={{ color: theme.textMuted }}
                    >
                      {p.actual_close != null ? p.actual_close.toFixed(2) : '—'}
                    </td>
                    <td
                      className="py-1.5 pr-4 font-mono text-[11px]"
                      style={{ color: errColor }}
                    >
                      {err != null
                        ? `${err >= 0 ? '+' : ''}${err.toFixed(1)}`
                        : '—'}
                    </td>
                    <td
                      className="py-1.5 font-sans text-[10px]"
                      style={{ color: theme.textMuted }}
                    >
                      {p.confidence}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
