/**
 * TRACELiveAnalogsPanel — historical analogs by embedding cosine distance.
 *
 * Fetches /api/trace-live-analogs?id=${detail.id}&k=10 once per detail.id and
 * renders the K nearest historical captures alongside the model's prediction
 * vs the actual close. Surfaces an outcome distribution next to the point
 * estimate so the trader can sanity-check predictions against what actually
 * happened on prior captures with similar embeddings.
 *
 * Lives below the SynthesisPanel and is collapsed by default — heavyweight
 * detail that the trader opens deliberately when triaging a setup, not at a
 * glance. The endpoint sets a 5-min private cache so opening / closing the
 * panel doesn't refire the request.
 */

import { memo, useEffect, useMemo, useState } from 'react';
import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import Collapsible from '../ChartAnalysis/Collapsible';
import { getErrorMessage } from '../../utils/error';
import { Tooltip } from '../ui';
import type {
  TraceLiveAnalog,
  TraceLiveAnalogsResponse,
  TraceLiveDetail,
} from './types';

const HEADER_TIPS = {
  time: (
    <>
      <strong>Historical match timestamp.</strong> The matching engine looks for
      past moments with similar gamma/charm/spot conditions to right now. Times
      are CT.
    </>
  ),
  spot: <strong>SPX spot at the matched moment.</strong>,
  regime: (
    <>
      <strong>Gamma regime label at the matched moment.</strong> &quot;Trending
      negative gamma&quot; = dealers short gamma + spot trending = move
      acceleration.
    </>
  ),
  predClose: (
    <>
      <strong>
        Naive close prediction = spot at matched time + recent drift.
      </strong>{' '}
      Baseline for comparing to actual.
    </>
  ),
  actual: (
    <>
      <strong>The actual session close on the matched day.</strong> Compare to
      Pred close to see how the day resolved.
    </>
  ),
  delta: (
    <>
      <strong>Actual minus Pred close, in points.</strong> Green = market closed
      higher than the naive forecast; red = lower. Magnitude tells you how much
      the late-session moved against the matched setup.
    </>
  ),
  distance: (
    <>
      <strong>Feature-space distance to the current setup.</strong> Lower =
      closer match. Below 0.04 is tight; above 0.10 starts being a stretch.
    </>
  ),
};

interface Props {
  readonly detail: TraceLiveDetail | null;
}

function formatCtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      month: 'short',
      day: '2-digit',
      hour: 'numeric',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return iso;
  }
}

function deltaColor(error: number | null): string {
  if (error == null) return theme.textMuted;
  const abs = Math.abs(error);
  if (abs <= 5) return theme.green;
  if (abs <= 15) return theme.caution;
  return theme.red;
}

function formatNum(v: number | null, digits = 2): string {
  return v == null ? '—' : v.toFixed(digits);
}

function formatDelta(error: number | null): string {
  if (error == null) return '—';
  const sign = error > 0 ? '+' : '';
  return `${sign}${error.toFixed(2)}`;
}

function AnalogsTable({ analogs }: Readonly<{ analogs: TraceLiveAnalog[] }>) {
  if (analogs.length === 0) {
    return (
      <div className="text-muted font-mono text-[11px]">
        No historical analogs found yet — embedding index needs more captures.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full font-mono text-[11px]">
        <thead>
          <tr className="text-muted border-edge border-b text-left">
            <th className="px-2 py-1 font-semibold">
              <Tooltip content={HEADER_TIPS.time}>
                <span className="cursor-help">Time (CT)</span>
              </Tooltip>
            </th>
            <th className="px-2 py-1 text-right font-semibold">
              <Tooltip content={HEADER_TIPS.spot}>
                <span className="cursor-help">Spot</span>
              </Tooltip>
            </th>
            <th className="px-2 py-1 font-semibold">
              <Tooltip content={HEADER_TIPS.regime}>
                <span className="cursor-help">Regime</span>
              </Tooltip>
            </th>
            <th className="px-2 py-1 text-right font-semibold">
              <Tooltip content={HEADER_TIPS.predClose}>
                <span className="cursor-help">Pred close</span>
              </Tooltip>
            </th>
            <th className="px-2 py-1 text-right font-semibold">
              <Tooltip content={HEADER_TIPS.actual}>
                <span className="cursor-help">Actual</span>
              </Tooltip>
            </th>
            <th className="px-2 py-1 text-right font-semibold">
              <Tooltip content={HEADER_TIPS.delta}>
                <span className="cursor-help">Δ</span>
              </Tooltip>
            </th>
            <th className="px-2 py-1 text-right font-semibold">
              <Tooltip content={HEADER_TIPS.distance}>
                <span className="cursor-help">Distance</span>
              </Tooltip>
            </th>
          </tr>
        </thead>
        <tbody>
          {analogs.map((a) => {
            const dColor = deltaColor(a.error);
            return (
              <tr key={a.id} className="border-edge/60 border-b last:border-0">
                <td className="text-secondary px-2 py-1 whitespace-nowrap">
                  {formatCtTime(a.capturedAt)}
                </td>
                <td className="text-tertiary px-2 py-1 text-right">
                  {formatNum(a.spot)}
                </td>
                <td className="text-secondary px-2 py-1 whitespace-nowrap">
                  {a.regime ? a.regime.replace(/_/g, ' ') : '—'}
                </td>
                <td className="text-tertiary px-2 py-1 text-right">
                  {formatNum(a.predictedClose)}
                </td>
                <td className="text-tertiary px-2 py-1 text-right">
                  {formatNum(a.actualClose)}
                </td>
                <td
                  className="rounded px-2 py-1 text-right font-semibold"
                  style={{
                    color: dColor,
                    backgroundColor:
                      a.error == null ? 'transparent' : tint(dColor, '14'),
                  }}
                >
                  {formatDelta(a.error)}
                </td>
                <td className="text-muted px-2 py-1 text-right">
                  {a.distance.toFixed(4)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const MemoAnalogsTable = memo(AnalogsTable);

function TRACELiveAnalogsPanel({ detail }: Readonly<Props>) {
  const id = detail?.id ?? null;
  const [analogs, setAnalogs] = useState<TraceLiveAnalog[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (id == null) {
      setAnalogs([]);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/trace-live-analogs?id=${id}&k=10`, {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(8_000),
    })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          if (res.status === 404) {
            setAnalogs([]);
            // 404 here means "no embedding yet" — render the empty state
            // without surfacing a scary error string.
            return;
          }
          if (res.status !== 401) {
            setError('Failed to load analogs');
          }
          return;
        }
        const data = (await res.json()) as TraceLiveAnalogsResponse;
        if (!cancelled) setAnalogs(data.analogs);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(getErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  // Memoize the rendered children so toggling the Collapsible open/closed
  // doesn't reflow the table on each render.
  const body = useMemo(() => {
    if (id == null) return null;
    if (loading && analogs.length === 0) {
      return (
        <div className="text-muted font-mono text-[11px]">Loading analogs…</div>
      );
    }
    if (error) {
      return (
        <div className="font-mono text-[11px]" style={{ color: theme.red }}>
          {error}
        </div>
      );
    }
    return <MemoAnalogsTable analogs={analogs} />;
  }, [id, loading, error, analogs]);

  if (id == null) return null;

  return (
    <div className="mt-2.5">
      <Collapsible title="Historical Analogs" color={theme.accent}>
        {body}
      </Collapsible>
    </div>
  );
}

export default memo(TRACELiveAnalogsPanel);
