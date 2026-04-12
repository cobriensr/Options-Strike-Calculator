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
  const [refreshing, setRefreshing] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [deletingDate, setDeletingDate] = useState<string | null>(null);

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

      const exists = predictions.some((p) => p.date === date);
      if (exists && !confirmOverwrite) {
        setConfirmOverwrite(true);
        return;
      }

      setSubmitting(true);
      setSubmitError('');
      setSaved(false);
      setConfirmOverwrite(false);
      try {
        const res = await fetch('/api/trace/prediction', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date, predicted_close: value, confidence }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
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
    [
      date,
      predictedClose,
      confidence,
      confirmOverwrite,
      predictions,
      loadPredictions,
    ],
  );

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetch('/api/trace/refresh-actuals', { method: 'POST' });
      void loadPredictions();
    } finally {
      setRefreshing(false);
    }
  }, [loadPredictions]);

  const handleDelete = useCallback(
    async (dateToDelete: string) => {
      setDeletingDate(dateToDelete);
      try {
        await fetch(`/api/trace/prediction?date=${dateToDelete}`, {
          method: 'DELETE',
        });
        void loadPredictions();
      } finally {
        setDeletingDate(null);
      }
    },
    [loadPredictions],
  );

  return (
    <div
      className="border-edge mt-4 rounded-lg border p-4"
      style={{ backgroundColor: tint(theme.surfaceAlt, '40') }}
    >
      <div className="mb-3 flex items-center justify-between">
        <h3
          className="font-sans text-[12px] font-semibold tracking-wider uppercase"
          style={{ color: theme.textMuted }}
        >
          Log TRACE Pin Prediction
        </h3>
        <button
          type="button"
          onClick={() => void handleRefresh()}
          disabled={refreshing}
          className="rounded px-2 py-1 font-sans text-[10px] transition-opacity disabled:opacity-40"
          style={{
            backgroundColor: tint(theme.accent, '15'),
            color: theme.accent,
            border: `1px solid ${tint(theme.accent, '35')}`,
          }}
        >
          {refreshing ? 'Refreshing…' : 'Refresh Actuals'}
        </button>
      </div>

      <form
        onSubmit={handleSubmit}
        className="mb-4 flex flex-wrap items-end gap-3"
      >
        <label className="flex flex-col gap-1">
          <span
            className="font-sans text-[10px] tracking-wide uppercase"
            style={{ color: theme.textMuted }}
          >
            Date
          </span>
          <input
            type="date"
            value={date}
            max={todayLocal()}
            onChange={(e) => {
              setDate(e.target.value);
              setConfirmOverwrite(false);
            }}
            className="border-edge rounded border bg-transparent px-2 py-1.5 font-mono text-[12px]"
            style={{ color: theme.text }}
            required
          />
        </label>

        <label className="flex flex-col gap-1">
          <span
            className="font-sans text-[10px] tracking-wide uppercase"
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
            className="font-sans text-[10px] tracking-wide uppercase"
            style={{ color: theme.textMuted }}
          >
            Confidence
          </span>
          <select
            value={confidence}
            onChange={(e) => setConfidence(e.target.value as Confidence)}
            className="border-edge rounded border px-2 py-1.5 font-sans text-[12px]"
            style={{ color: theme.text, backgroundColor: theme.surfaceAlt }}
          >
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </label>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={submitting || !predictedClose}
              className="rounded px-3 py-1.5 font-sans text-[12px] font-semibold transition-opacity disabled:opacity-40"
              style={{
                backgroundColor: confirmOverwrite ? theme.red : theme.accent,
                color: '#fff',
              }}
            >
              {submitting ? 'Saving…' : confirmOverwrite ? 'Overwrite' : 'Save'}
            </button>
            {confirmOverwrite && (
              <button
                type="button"
                onClick={() => setConfirmOverwrite(false)}
                className="rounded px-3 py-1.5 font-sans text-[12px] font-semibold"
                style={{ color: theme.textMuted }}
              >
                Cancel
              </button>
            )}
            {saved && (
              <span
                className="font-sans text-[11px]"
                style={{ color: theme.green }}
              >
                Saved
              </span>
            )}
            {submitError && (
              <span
                className="font-sans text-[11px]"
                style={{ color: theme.red }}
              >
                {submitError}
              </span>
            )}
          </div>
          {confirmOverwrite && (
            <span
              className="font-sans text-[10px]"
              style={{ color: theme.red }}
            >
              Entry for {date} already exists — click Overwrite to replace it.
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
        <div
          className="max-h-[320px] overflow-auto"
          style={{ scrollbarWidth: 'thin' }}
        >
          <table className="w-full border-collapse">
            <thead>
              <tr
                className="border-edge border-b text-left"
                style={{ color: theme.textMuted }}
              >
                {['Date', 'Open', 'Predicted', 'Actual', 'Error', 'Conf', ''].map(
                  (h) => (
                    <th
                      key={h}
                      className="sticky top-0 pr-4 pb-1.5 font-sans text-[10px] font-medium tracking-wide uppercase last:pr-0"
                      style={{ backgroundColor: tint(theme.surfaceAlt, '40') }}
                    >
                      {h}
                    </th>
                  ),
                )}
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
                const dayBullish =
                  p.actual_close != null && p.current_price != null
                    ? p.actual_close > p.current_price
                    : null;
                const rowBg =
                  dayBullish === true
                    ? tint(theme.green, '08')
                    : dayBullish === false
                      ? tint(theme.red, '08')
                      : 'transparent';
                return (
                  <tr
                    key={p.date}
                    className="border-edge border-b last:border-0"
                    style={{ backgroundColor: rowBg }}
                  >
                    <td
                      className="py-1.5 pr-4 font-mono text-[11px]"
                      style={{ color: theme.text }}
                    >
                      {p.date}
                    </td>
                    <td
                      className="py-1.5 pr-4 font-mono text-[11px]"
                      style={{ color: theme.textMuted }}
                    >
                      {p.current_price != null
                        ? p.current_price.toFixed(0)
                        : '—'}
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
                    <td className="py-1.5 pl-2">
                      <button
                        type="button"
                        onClick={() => void handleDelete(p.date)}
                        disabled={deletingDate === p.date}
                        className="cursor-pointer font-sans text-[10px] opacity-30 transition-opacity hover:opacity-80 disabled:opacity-20"
                        style={{ color: theme.red }}
                        aria-label={`Delete prediction for ${p.date}`}
                      >
                        {deletingDate === p.date ? '…' : '×'}
                      </button>
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
