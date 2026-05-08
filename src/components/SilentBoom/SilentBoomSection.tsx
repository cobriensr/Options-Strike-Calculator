import { useEffect, useMemo, useState } from 'react';
import { SectionBox } from '../ui/SectionBox.js';
import { useSilentBoomFeed } from '../../hooks/useSilentBoomFeed.js';
import { SilentBoomRow } from './SilentBoomRow.js';
import type { OptionType, SilentBoomSortMode } from './types.js';

const PAGE_SIZE = 50;
const SORT_LS_KEY = 'silentBoom.sortMode';
const MIN_VOL_OI_LS_KEY = 'silentBoom.minVolOi';
const CONVICTION_LS_KEY = 'silentBoom.convictionFloor';

/** Tier floors — must match SILENT_BOOM_TIER_THRESHOLDS in
 *  api/_lib/silent-boom-score.ts. */
const TIER1_MIN_SCORE = 21;
const TIER2_MIN_SCORE = 8;

type ConvictionFloor = 'all' | 'tier2' | 'tier1';

const CONVICTION_OPTIONS: Array<{
  value: ConvictionFloor;
  label: string;
  tooltip: string;
}> = [
  {
    value: 'all',
    label: 'all',
    tooltip: 'No score floor — show every alert including Tier 3.',
  },
  {
    value: 'tier2',
    label: '🔥🔥 Tier 2+',
    tooltip: `Tier 2 or better (score ≥ ${TIER2_MIN_SCORE}). Historical high-peak rate ~37% (vs ~8% for Tier 3).`,
  },
  {
    value: 'tier1',
    label: '🔥🔥🔥 Tier 1',
    tooltip: `Tier 1 only (score ≥ ${TIER1_MIN_SCORE}). Historical high-peak rate ~56%, ~5% of fires.`,
  },
];

const CONVICTION_TO_MIN_SCORE: Record<ConvictionFloor, number | null> = {
  all: null,
  tier2: TIER2_MIN_SCORE,
  tier1: TIER1_MIN_SCORE,
};

const VOL_OI_FLOORS: Array<{ value: number; label: string; tooltip: string }> =
  [
    {
      value: 0,
      label: 'all',
      tooltip:
        'No vol/OI floor — show every alert that cleared the detector (vol/OI ≥ 25%).',
    },
    {
      value: 0.5,
      label: '≥0.5',
      tooltip:
        'Spike traded at least 50% of the contract OI in 5 minutes. Default — actionable density without too much noise.',
    },
    {
      value: 1,
      label: '≥1.0',
      tooltip:
        'Spike volume met or exceeded the entire prior open interest in one bucket. Strongest opening-trade signal.',
    },
  ];

const SORT_OPTIONS: Array<{
  value: SilentBoomSortMode;
  label: string;
  tooltip: string;
}> = [
  {
    value: 'newest',
    label: 'newest',
    tooltip: 'Order by spike-bucket time (most recent first). Default.',
  },
  {
    value: 'spike_ratio',
    label: 'spike ratio',
    tooltip: 'Order by spike-vol / baseline-median. Most extreme bursts first.',
  },
  {
    value: 'vol_oi',
    label: 'vol/OI',
    tooltip: 'Order by spike-vol / OI. Highest single-bucket OI churn first.',
  },
  {
    value: 'peak',
    label: 'peak',
    tooltip:
      'Order by realized peak ceiling (largest move first). Post-hoc — only meaningful once enrich-silent-boom-outcomes has populated peak_ceiling_pct.',
  },
];

interface SilentBoomSectionProps {
  marketOpen: boolean;
}

const CHIP_BASE =
  'inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors';
const CHIP_INACTIVE =
  'border-neutral-800 bg-neutral-900/60 text-neutral-400 hover:border-neutral-700 hover:text-neutral-100';
const CHIP_ACTIVE: Record<
  'sky' | 'rose' | 'amber' | 'emerald' | 'green' | 'red' | 'blue' | 'neutral',
  string
> = {
  sky: 'border-sky-500/70 bg-sky-950/40 text-sky-200',
  rose: 'border-rose-500/70 bg-rose-950/40 text-rose-200',
  amber: 'border-amber-500/70 bg-amber-950/40 text-amber-200',
  emerald: 'border-emerald-500/70 bg-emerald-950/40 text-emerald-200',
  green: 'border-green-500/70 bg-green-950/40 text-green-200',
  red: 'border-red-500/70 bg-red-950/40 text-red-200',
  blue: 'border-blue-500/70 bg-blue-950/40 text-blue-200',
  neutral: 'border-neutral-500 bg-neutral-800 text-neutral-200',
};

const SECTION_LABEL =
  'text-[10px] font-semibold tracking-[0.08em] text-neutral-500 uppercase';
const TOOLBAR_DIVIDER = 'mx-1 hidden h-4 w-px bg-neutral-800 sm:block';

const todayCt = (): string => {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date());
};

const formatTimeCT = (input: number): string =>
  new Date(input).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Chicago',
  });

export function SilentBoomSection({ marketOpen }: SilentBoomSectionProps) {
  const [date, setDate] = useState<string>(todayCt());
  const [tickerFilter, setTickerFilter] = useState<string | null>(null);
  const [optionTypeFilter, setOptionTypeFilter] = useState<OptionType | null>(
    null,
  );
  const [sortMode, setSortMode] = useState<SilentBoomSortMode>(() => {
    if (typeof window === 'undefined') return 'newest';
    const stored = window.localStorage.getItem(SORT_LS_KEY);
    if (
      stored === 'newest' ||
      stored === 'spike_ratio' ||
      stored === 'vol_oi' ||
      stored === 'peak'
    ) {
      return stored;
    }
    return 'newest';
  });
  const [minVolOi, setMinVolOi] = useState<number>(() => {
    if (typeof window === 'undefined') return 0.5;
    const stored = window.localStorage.getItem(MIN_VOL_OI_LS_KEY);
    if (stored == null) return 0.5;
    const parsed = Number.parseFloat(stored);
    return Number.isFinite(parsed) ? parsed : 0.5;
  });
  const [convictionFloor, setConvictionFloor] = useState<ConvictionFloor>(
    () => {
      if (typeof window === 'undefined') return 'all';
      const stored = window.localStorage.getItem(CONVICTION_LS_KEY);
      if (stored === 'tier1' || stored === 'tier2' || stored === 'all') {
        return stored;
      }
      return 'all';
    },
  );
  const [page, setPage] = useState<number>(0);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(SORT_LS_KEY, sortMode);
    }
  }, [sortMode]);
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(MIN_VOL_OI_LS_KEY, String(minVolOi));
    }
  }, [minVolOi]);
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(CONVICTION_LS_KEY, convictionFloor);
    }
  }, [convictionFloor]);

  // Reset page on any filter change so we don't land on an empty page.
  useEffect(() => {
    setPage(0);
  }, [
    date,
    tickerFilter,
    optionTypeFilter,
    sortMode,
    minVolOi,
    convictionFloor,
  ]);

  const isHistorical = date !== todayCt();

  const { alerts, loading, error, fetchedAt, total, offset, hasMore } =
    useSilentBoomFeed({
      date,
      marketOpen,
      historical: isHistorical,
      ticker: tickerFilter,
      optionType: optionTypeFilter,
      minVolOi,
      minScore: CONVICTION_TO_MIN_SCORE[convictionFloor],
      sort: sortMode,
      page,
      pageSize: PAGE_SIZE,
    });

  // Top tickers in the current page — quick one-click scope.
  const topTickers = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of alerts) {
      counts.set(a.underlyingSymbol, (counts.get(a.underlyingSymbol) ?? 0) + 1);
    }
    return [...counts.entries()].sort((b, c) => c[1] - b[1]).slice(0, 12);
  }, [alerts]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <SectionBox label="Silent Boom" collapsible>
      <div className="space-y-3">
        <p className="text-[11px] text-neutral-500">
          Detector for chains that trade quietly for 15-20 min then print a
          single ask-side burst ≥5× the prior 4-bucket median, with vol/OI ≥
          25%, ask% ≥ 70%, and OI ≥ 100. Discretionary signal — peak-ceiling is
          a look-ahead reference, not a tradeable exit. Empirical sample (19
          days, 13.9k fires): peak +26.15% mean, 71.7% high-peak rate. Realized
          horizons average ~0%, so timing matters.{' '}
          <a
            className="text-neutral-400 underline hover:text-white"
            href="https://github.com/cobriensr/Options-Strike-Calculator/blob/main/docs/superpowers/specs/silent-boom-detector-2026-05-08.md"
            target="_blank"
            rel="noopener noreferrer"
          >
            methodology
          </a>
        </p>

        <div className="space-y-2.5 rounded-lg border border-neutral-800/80 bg-neutral-950/40 p-2.5">
          {/* Row 1: date + meta */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="flex items-center gap-1.5">
              <span className={SECTION_LABEL}>date</span>
              <input
                type="date"
                value={date}
                max={todayCt()}
                onChange={(e) => setDate(e.target.value)}
                className="rounded-md border border-neutral-800 bg-neutral-900/60 px-2 py-1 font-mono text-xs text-neutral-100 focus:border-neutral-600 focus:outline-none"
                aria-label="Select trading day"
              />
            </label>
            <div className="ml-auto flex items-center gap-1.5">
              {fetchedAt != null && !isHistorical && (
                <span className="text-[10px] text-neutral-500">
                  updated {formatTimeCT(fetchedAt)} CT
                </span>
              )}
              {isHistorical && (
                <span className="text-[10px] text-neutral-500">
                  historical replay
                </span>
              )}
            </div>
          </div>

          {/* Row 2: conviction tier */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={SECTION_LABEL}>conviction</span>
            {CONVICTION_OPTIONS.map((c) => {
              const active = convictionFloor === c.value;
              const activeColor: keyof typeof CHIP_ACTIVE =
                c.value === 'tier1'
                  ? 'rose'
                  : c.value === 'tier2'
                    ? 'amber'
                    : 'emerald';
              return (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => setConvictionFloor(c.value)}
                  className={`${CHIP_BASE} ${
                    active ? CHIP_ACTIVE[activeColor] : CHIP_INACTIVE
                  }`}
                  title={c.tooltip}
                  aria-pressed={active}
                >
                  {c.label}
                </button>
              );
            })}
          </div>

          {/* Row 3: sort + vol/OI floor */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={SECTION_LABEL}>sort</span>
            {SORT_OPTIONS.map((s) => (
              <button
                key={s.value}
                type="button"
                onClick={() => setSortMode(s.value)}
                className={`${CHIP_BASE} ${
                  sortMode === s.value ? CHIP_ACTIVE.sky : CHIP_INACTIVE
                }`}
                title={s.tooltip}
                aria-pressed={sortMode === s.value}
              >
                {s.label}
              </button>
            ))}
            <span className={TOOLBAR_DIVIDER} aria-hidden="true" />
            <span className={SECTION_LABEL}>vol/OI</span>
            {VOL_OI_FLOORS.map((f) => (
              <button
                key={f.label}
                type="button"
                onClick={() => setMinVolOi(f.value)}
                className={`${CHIP_BASE} ${
                  minVolOi === f.value ? CHIP_ACTIVE.amber : CHIP_INACTIVE
                }`}
                title={f.tooltip}
                aria-pressed={minVolOi === f.value}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* Row 3: option type */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={SECTION_LABEL}>type</span>
            {[
              { value: null, label: 'all' },
              { value: 'C' as OptionType, label: 'calls' },
              { value: 'P' as OptionType, label: 'puts' },
            ].map((o) => {
              const active = optionTypeFilter === o.value;
              const activeColor: keyof typeof CHIP_ACTIVE =
                o.value === 'C' ? 'green' : o.value === 'P' ? 'red' : 'neutral';
              return (
                <button
                  key={o.label}
                  type="button"
                  onClick={() => setOptionTypeFilter(o.value)}
                  className={`${CHIP_BASE} ${
                    active ? CHIP_ACTIVE[activeColor] : CHIP_INACTIVE
                  }`}
                  aria-pressed={active}
                >
                  {o.label}
                </button>
              );
            })}
          </div>

          {/* Row 4 (conditional): ticker chips */}
          {(topTickers.length > 0 || tickerFilter) && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={SECTION_LABEL}>ticker</span>
              <button
                type="button"
                onClick={() => setTickerFilter(null)}
                className={`${CHIP_BASE} ${
                  tickerFilter == null ? CHIP_ACTIVE.emerald : CHIP_INACTIVE
                }`}
                aria-pressed={tickerFilter == null}
              >
                all
              </button>
              {topTickers.map(([t, n]) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTickerFilter(tickerFilter === t ? null : t)}
                  className={`${CHIP_BASE} ${
                    tickerFilter === t ? CHIP_ACTIVE.emerald : CHIP_INACTIVE
                  }`}
                  title={`Filter to ${t} only (${n} alerts in current view)`}
                  aria-pressed={tickerFilter === t}
                >
                  {t} <span className="text-[10px] opacity-70">{n}</span>
                </button>
              ))}
              {tickerFilter &&
                !topTickers.some(([t]) => t === tickerFilter) && (
                  <button
                    type="button"
                    onClick={() => setTickerFilter(null)}
                    className={`${CHIP_BASE} ${CHIP_ACTIVE.emerald}`}
                    title="Filter active but no alerts for this ticker in the current view — click to clear"
                  >
                    {tickerFilter}{' '}
                    <span className="text-[10px] opacity-70">0</span>
                  </button>
                )}
            </div>
          )}
        </div>

        {/* Body */}
        {loading && alerts.length === 0 ? (
          <div className="text-sm text-neutral-500">
            Loading silent-boom feed…
          </div>
        ) : error ? (
          <div
            className="rounded border border-red-500/40 bg-red-950/30 p-3 text-sm text-red-200"
            role="alert"
          >
            Error: {error}
          </div>
        ) : alerts.length === 0 ? (
          <div className="rounded border border-neutral-800 bg-neutral-950 p-3 text-sm text-neutral-400">
            No silent-boom alerts on {date} matching the active filters. Try
            lowering the vol/OI floor or clearing the ticker / type chips.
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-neutral-500">
              <span>
                {total} alert{total === 1 ? '' : 's'} for {date}
                {total > 0 && (
                  <span className="ml-2 text-neutral-600">
                    showing {offset + 1}-{offset + alerts.length}
                  </span>
                )}
                {convictionFloor !== 'all' && (
                  <span
                    className={`ml-2 ${
                      convictionFloor === 'tier1'
                        ? 'text-rose-300/80'
                        : 'text-amber-300/80'
                    }`}
                  >
                    ({convictionFloor === 'tier1' ? 'Tier 1 only' : 'Tier 2+'})
                  </span>
                )}
                {sortMode !== 'newest' && (
                  <span className="ml-2 text-sky-300/80">
                    sorted by {sortMode.replace('_', ' ')}
                  </span>
                )}
                {minVolOi > 0 && (
                  <span className="ml-2 text-amber-300/80">
                    vol/OI ≥ {minVolOi}
                  </span>
                )}
              </span>
              {total > PAGE_SIZE && (
                <span className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                    className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-xs font-semibold text-neutral-300 enabled:hover:text-white disabled:opacity-40"
                    aria-label="Previous page"
                  >
                    ← prev
                  </button>
                  <span className="font-mono text-xs text-neutral-400">
                    {currentPage} / {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPage((p) => p + 1)}
                    disabled={!hasMore}
                    className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-xs font-semibold text-neutral-300 enabled:hover:text-white disabled:opacity-40"
                    aria-label="Next page"
                  >
                    next →
                  </button>
                </span>
              )}
            </div>
            {alerts.map((a) => (
              <SilentBoomRow
                // Key by chain+bucket — alert.id rolls if we re-detect on
                // the same bucket (we shouldn't, but ON CONFLICT DO NOTHING
                // means the row id is stable). chain+bucket is the natural
                // key the unique index is on, so it's the right identity.
                key={`${a.optionChainId}|${a.bucketCt}`}
                alert={a}
                marketOpen={marketOpen}
              />
            ))}
          </div>
        )}
      </div>
    </SectionBox>
  );
}
