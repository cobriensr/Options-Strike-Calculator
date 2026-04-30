import { useMemo, useState } from 'react';
import { SectionBox } from '../ui/SectionBox.js';
import { useWhaleAnomalies } from '../../hooks/useWhaleAnomalies.js';
import { WhaleRow } from './WhaleRow.js';
import { WHALE_TICKERS, type WhaleAnomaly } from './types.js';

interface WhaleAnomaliesSectionProps {
  marketOpen: boolean;
}

const todayCt = (): string => {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date());
};

export function WhaleAnomaliesSection({
  marketOpen,
}: WhaleAnomaliesSectionProps) {
  const [date, setDate] = useState<string>(todayCt());
  const [tickerFilter, setTickerFilter] = useState<string | null>(null);
  const [scrubAt, setScrubAt] = useState<string | null>(null);

  const { whales, loading, error, fetchedAt } = useWhaleAnomalies({
    date,
    at: scrubAt,
    marketOpen,
    ticker: tickerFilter,
  });

  // Per-ticker counts for the tab badges (un-filtered counts of the day).
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const w of whales) c[w.ticker] = (c[w.ticker] ?? 0) + 1;
    return c;
  }, [whales]);

  // Filtered list (the ticker tabs apply on the API side; this is a no-op
  // unless we also want client-side filtering — keeping it simple).
  const visible = whales;

  // Time-scrub bounds: span the day's whale firings.
  const scrubBounds = useMemo(() => {
    if (whales.length === 0) return null;
    const sorted = [...whales].sort((a, b) =>
      a.first_ts.localeCompare(b.first_ts),
    );
    return {
      min: sorted[0]!.first_ts,
      max: sorted.at(-1)!.first_ts,
    };
  }, [whales]);

  const handleScrubChange = (value: string) => {
    if (value === 'live') {
      setScrubAt(null);
    } else {
      setScrubAt(value);
    }
  };

  const isLive = scrubAt == null;

  return (
    <SectionBox label="Whale Anomalies" collapsible>
      <div className="space-y-3">
        <p className="text-[11px] text-neutral-500">
          Hand-derived checklist (per-ticker p95 premium, ≥85% one-sided, ≥5
          trades, ≤14 DTE, ≤5% moneyness, no simultaneous synthetic).
        </p>
        {/* Date + scrub controls */}
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-1.5">
            <span className="text-neutral-400">date</span>
            <input
              type="date"
              value={date}
              max={todayCt()}
              onChange={(e) => {
                setDate(e.target.value);
                setScrubAt(null);
              }}
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-white"
              aria-label="Select date"
            />
          </label>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className={`rounded border px-2 py-1 text-xs font-semibold ${
                isLive
                  ? 'border-green-500 bg-green-950/40 text-green-200'
                  : 'border-neutral-700 bg-neutral-900 text-neutral-400 hover:text-white'
              }`}
              onClick={() => setScrubAt(null)}
            >
              {date === todayCt() ? 'Live' : 'Latest'}
            </button>
            {scrubBounds && (
              <input
                type="range"
                min={Date.parse(scrubBounds.min)}
                max={Date.parse(scrubBounds.max)}
                step={60_000}
                value={(() => {
                  // Defensive clamp: a date-input change followed by a
                  // pending scrubAt from the prior day can otherwise leave
                  // the slider value briefly outside the new bounds before
                  // the next render reconciles state.
                  const lo = Date.parse(scrubBounds.min);
                  const hi = Date.parse(scrubBounds.max);
                  const raw = scrubAt ? Date.parse(scrubAt) : hi;
                  return Math.max(lo, Math.min(hi, raw));
                })()}
                onChange={(e) =>
                  handleScrubChange(
                    new Date(Number(e.target.value)).toISOString(),
                  )
                }
                className="w-48"
                aria-label="Time scrubber"
              />
            )}
            {scrubAt && (
              <span className="font-mono text-xs text-neutral-300">
                @{' '}
                {new Date(scrubAt).toLocaleTimeString('en-US', {
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                  timeZone: 'America/Chicago',
                })}{' '}
                CT
              </span>
            )}
          </div>
          {fetchedAt != null && (
            <span className="ml-auto text-[10px] text-neutral-500">
              updated{' '}
              {new Date(fetchedAt).toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false,
                timeZone: 'America/Chicago',
              })}{' '}
              CT
            </span>
          )}
        </div>

        {/* Ticker tabs */}
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            className={`rounded border px-2 py-1 text-xs font-semibold ${
              tickerFilter == null
                ? 'border-blue-500 bg-blue-950/40 text-blue-200'
                : 'border-neutral-700 bg-neutral-900 text-neutral-400 hover:text-white'
            }`}
            onClick={() => setTickerFilter(null)}
          >
            All <span className="text-[10px]">{whales.length}</span>
          </button>
          {WHALE_TICKERS.map((t) => {
            const n = counts[t] ?? 0;
            const active = tickerFilter === t;
            return (
              <button
                key={t}
                type="button"
                className={`rounded border px-2 py-1 text-xs font-semibold ${
                  active
                    ? 'border-blue-500 bg-blue-950/40 text-blue-200'
                    : n === 0
                      ? 'border-neutral-800 bg-neutral-950 text-neutral-600'
                      : 'border-neutral-700 bg-neutral-900 text-neutral-300 hover:text-white'
                }`}
                onClick={() => setTickerFilter(active ? null : t)}
              >
                {t} <span className="text-[10px]">{n}</span>
              </button>
            );
          })}
        </div>

        {/* Body */}
        {loading && whales.length === 0 ? (
          <div className="text-sm text-neutral-500">Loading whales…</div>
        ) : error ? (
          <div
            className="rounded border border-red-500/40 bg-red-950/30 p-3 text-sm text-red-200"
            role="alert"
          >
            Error: {error}
          </div>
        ) : visible.length === 0 ? (
          <div className="rounded border border-neutral-800 bg-neutral-950 p-3 text-sm text-neutral-400">
            No whales matched the checklist for {date}
            {tickerFilter ? ` on ${tickerFilter}` : ''}. The strict criteria
            mean some days will be empty — that's expected.
          </div>
        ) : (
          <div className="space-y-2">
            {visible.map((w: WhaleAnomaly) => (
              <WhaleRow key={w.id} whale={w} />
            ))}
          </div>
        )}
      </div>
    </SectionBox>
  );
}
