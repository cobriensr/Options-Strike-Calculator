import { useMemo, useState } from 'react';
import { SectionBox } from '../ui/SectionBox.js';
import { useLotteryFinder } from '../../hooks/useLotteryFinder.js';
import { LotteryRow } from './LotteryRow.js';
import {
  EXIT_POLICY_LABELS,
  EXIT_POLICY_TOOLTIPS,
  type ExitPolicy,
  type LotteryFire,
  type LotteryMode,
} from './types.js';

interface LotteryFinderSectionProps {
  marketOpen: boolean;
}

const EXIT_POLICIES: ExitPolicy[] = [
  'realizedTrail30_10Pct',
  'realizedHard30mPct',
  'realizedTier50HoldEodPct',
];

const MODE_FILTERS: Array<{ value: LotteryMode | null; label: string }> = [
  { value: null, label: 'All modes' },
  { value: 'A_intraday_0DTE', label: 'Mode A (0DTE)' },
  { value: 'B_multi_day_DTE1_3', label: 'Mode B (DTE 1-3)' },
];

const todayCt = (): string => {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date());
};

const formatTimeCT = (iso: string): string => {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Chicago',
  });
};

export function LotteryFinderSection({
  marketOpen,
}: LotteryFinderSectionProps) {
  const [date, setDate] = useState<string>(todayCt());
  const [scrubAt, setScrubAt] = useState<string | null>(null);
  const [exitPolicy, setExitPolicy] = useState<ExitPolicy>(
    'realizedTrail30_10Pct',
  );
  const [reloadOnly, setReloadOnly] = useState<boolean>(false);
  const [cheapCallPmOnly, setCheapCallPmOnly] = useState<boolean>(false);
  const [modeFilter, setModeFilter] = useState<LotteryMode | null>(null);

  const { fires, loading, error, fetchedAt } = useLotteryFinder({
    date,
    at: scrubAt,
    marketOpen,
    reload: reloadOnly ? true : null,
    cheapCallPm: cheapCallPmOnly ? true : null,
    mode: modeFilter,
  });

  // Time-scrub bounds: span the day's fires (chronological).
  const scrubBounds = useMemo(() => {
    if (fires.length === 0) return null;
    const sorted = [...fires].sort((a, b) =>
      a.triggerTimeCt.localeCompare(b.triggerTimeCt),
    );
    return {
      min: sorted[0]!.triggerTimeCt,
      max: sorted.at(-1)!.triggerTimeCt,
    };
  }, [fires]);

  const isLive = scrubAt == null && date === todayCt();
  const dayFires = fires.length;
  const reloadCount = useMemo(
    () => fires.filter((f) => f.tags.reload).length,
    [fires],
  );
  const cheapPmCount = useMemo(
    () => fires.filter((f) => f.tags.cheapCallPm).length,
    [fires],
  );

  return (
    <SectionBox label="Lottery Finder" collapsible>
      <div className="space-y-3">
        <p className="text-[11px] text-neutral-500">
          Signal detector — not a backtested profitable strategy. Most days
          lose; wins come from rare explosive moves. Edge concentrated in 1-2
          outlier days per 15 in the cheap-call-PM RE-LOAD subset.{' '}
          <a
            className="text-neutral-400 underline hover:text-white"
            href="/docs/superpowers/specs/lottery-finder-2026-05-02.md"
            target="_blank"
            rel="noreferrer"
          >
            methodology
          </a>
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
              aria-label="Select trading day"
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
                  const lo = Date.parse(scrubBounds.min);
                  const hi = Date.parse(scrubBounds.max);
                  const raw = scrubAt ? Date.parse(scrubAt) : hi;
                  return Math.max(lo, Math.min(hi, raw));
                })()}
                onChange={(e) =>
                  setScrubAt(new Date(Number(e.target.value)).toISOString())
                }
                className="w-48"
                aria-label="Time scrubber"
              />
            )}
            {scrubAt && (
              <span className="font-mono text-xs text-neutral-300">
                @ {formatTimeCT(scrubAt)} CT
              </span>
            )}
          </div>
          {fetchedAt != null && (
            <span className="ml-auto text-[10px] text-neutral-500">
              updated {formatTimeCT(new Date(fetchedAt).toISOString())} CT
            </span>
          )}
        </div>

        {/* Filter chips */}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setReloadOnly(!reloadOnly)}
            className={`rounded border px-2 py-1 text-xs font-semibold ${
              reloadOnly
                ? 'border-amber-500 bg-amber-950/40 text-amber-200'
                : 'border-neutral-700 bg-neutral-900 text-neutral-400 hover:text-white'
            }`}
            title="Show only fires tagged RE-LOAD (burst ≥2× prior AND entry dropped ≥30%)."
          >
            RE-LOAD only{' '}
            <span className="text-[10px]">{reloadCount}</span>
          </button>
          <button
            type="button"
            onClick={() => setCheapCallPmOnly(!cheapCallPmOnly)}
            className={`rounded border px-2 py-1 text-xs font-semibold ${
              cheapCallPmOnly
                ? 'border-fuchsia-500 bg-fuchsia-950/40 text-fuchsia-200'
                : 'border-neutral-700 bg-neutral-900 text-neutral-400 hover:text-white'
            }`}
            title="Show only fires tagged cheap-call-PM (call + PM session + entry < $1). The Phase 1 selection rule."
          >
            Cheap-call-PM only{' '}
            <span className="text-[10px]">{cheapPmCount}</span>
          </button>
          {MODE_FILTERS.map((m) => (
            <button
              key={m.label}
              type="button"
              onClick={() => setModeFilter(m.value)}
              className={`rounded border px-2 py-1 text-xs font-semibold ${
                modeFilter === m.value
                  ? 'border-blue-500 bg-blue-950/40 text-blue-200'
                  : 'border-neutral-700 bg-neutral-900 text-neutral-400 hover:text-white'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* Exit policy selector */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-neutral-400">realized exit:</span>
          {EXIT_POLICIES.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setExitPolicy(p)}
              className={`rounded border px-2 py-1 text-xs font-semibold ${
                exitPolicy === p
                  ? 'border-purple-500 bg-purple-950/40 text-purple-200'
                  : 'border-neutral-700 bg-neutral-900 text-neutral-400 hover:text-white'
              }`}
              title={EXIT_POLICY_TOOLTIPS[p]}
            >
              {EXIT_POLICY_LABELS[p]}
            </button>
          ))}
        </div>

        {/* Body */}
        {loading && fires.length === 0 ? (
          <div className="text-sm text-neutral-500">Loading lottery feed…</div>
        ) : error ? (
          <div
            className="rounded border border-red-500/40 bg-red-950/30 p-3 text-sm text-red-200"
            role="alert"
          >
            Error: {error}
          </div>
        ) : fires.length === 0 ? (
          <div className="rounded border border-neutral-800 bg-neutral-950 p-3 text-sm text-neutral-400">
            No fires for {date}
            {(reloadOnly || cheapCallPmOnly || modeFilter) &&
              ' matching the active filters'}
            . The detector emits during market hours; expect 0–5 cheap-call-PM
            RE-LOAD fires per day (most days are zero).
          </div>
        ) : (
          <div className="space-y-2">
            <div className="text-[11px] text-neutral-500">
              {dayFires} fire{dayFires === 1 ? '' : 's'} for {date}
            </div>
            {fires.map((f: LotteryFire) => (
              <LotteryRow key={f.id} fire={f} exitPolicy={exitPolicy} />
            ))}
          </div>
        )}
      </div>
    </SectionBox>
  );
}
