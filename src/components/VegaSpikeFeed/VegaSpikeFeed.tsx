/**
 * VegaSpikeFeed — dashboard panel for the Dir Vega Spike Monitor.
 *
 * Compact feed/table of recent qualifying `dir_vega_flow` outliers in
 * SPY/QQQ surfaced by the `monitor-vega-spike` cron. Each row shows
 * time, ticker, signed Dir Vega magnitude, robust z-score, multiple of
 * prior-intraday-max, and Phase-5 forward returns at 5/15/30 minutes.
 *
 * Confluence rows (concurrent SPY+QQQ vega buys within ±60s) get a
 * highlighted ring — those are the most informative events, dealer-net-
 * short-vega across the broad market rather than a single-name pop.
 *
 * Polling cadence + view-range logic live in `useVegaSpikes`. This
 * component is purely presentational beyond the range toggle.
 */
import { memo, useMemo, useState } from 'react';
import { useVegaSpikes } from '../../hooks/useVegaSpikes';
import type { VegaSpike, VegaSpikeRange } from '../../hooks/useVegaSpikes';
import { SectionBox } from '../ui';

// ── Ticker filter ────────────────────────────────────────────

type TickerFilter = 'all' | 'SPY' | 'QQQ';

const TICKER_FILTER_OPTIONS: ReadonlyArray<{
  value: TickerFilter;
  label: string;
}> = [
  { value: 'all', label: 'All' },
  { value: 'SPY', label: 'SPY' },
  { value: 'QQQ', label: 'QQQ' },
];

interface TickerFilterToggleProps {
  value: TickerFilter;
  onChange: (next: TickerFilter) => void;
}

function TickerFilterToggle({
  value,
  onChange,
}: Readonly<TickerFilterToggleProps>) {
  return (
    <div
      className="border-edge inline-flex overflow-hidden rounded-md border"
      role="group"
      aria-label="Vega spike ticker filter"
    >
      {TICKER_FILTER_OPTIONS.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            className={[
              'focus-visible:ring-accent cursor-pointer rounded-sm px-2.5 py-1 font-sans text-[11px] font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:outline-none',
              active
                ? 'bg-accent-bg text-accent'
                : 'text-tertiary hover:text-primary',
            ].join(' ')}
            data-testid={`vega-ticker-${opt.value}`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Formatters ────────────────────────────────────────────────

const TIME_FMT_CT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const DATE_FMT_CT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  month: 'short',
  day: 'numeric',
});

function formatTimestamp(timestamp: string, range: VegaSpikeRange): string {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return timestamp;
  const time = TIME_FMT_CT.format(d);
  if (range === 'today') return time;
  return `${DATE_FMT_CT.format(d)} ${time}`;
}

/**
 * Format a signed magnitude with K/M suffix and forced sign:
 *   +5_620_000 → "+5.62M"
 *   -450_000   → "-450K"
 *   +12_345    → "+12K"
 */
function formatDirVega(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value >= 0 ? '+' : '-';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}${Math.round(abs / 1_000)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

function formatZ(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(1)}σ`;
}

function formatRatio(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(1)}×`;
}

function formatReturn(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(2)}%`;
}

function signTextClass(value: number | null): string {
  if (value == null || !Number.isFinite(value) || value === 0) {
    return 'text-muted';
  }
  return value > 0 ? 'text-success' : 'text-danger';
}

function tickerBadgeClass(ticker: string): string {
  // Distinct subtle ticker hints — both stay readable on dark/light surfaces.
  if (ticker === 'SPY') {
    return 'bg-cyan-900/40 text-cyan-300 border-cyan-500/40';
  }
  if (ticker === 'QQQ') {
    return 'bg-violet-900/40 text-violet-300 border-violet-500/40';
  }
  return 'bg-neutral-800/40 text-neutral-300 border-neutral-700/40';
}

// ── Range toggle ──────────────────────────────────────────────

const RANGE_OPTIONS: ReadonlyArray<{ value: VegaSpikeRange; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];

interface RangeToggleProps {
  value: VegaSpikeRange;
  onChange: (next: VegaSpikeRange) => void;
}

function RangeToggle({ value, onChange }: Readonly<RangeToggleProps>) {
  return (
    <div
      className="border-edge inline-flex overflow-hidden rounded-md border"
      role="group"
      aria-label="Vega spike range"
    >
      {RANGE_OPTIONS.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            className={[
              'focus-visible:ring-accent cursor-pointer rounded-sm px-2.5 py-1 font-sans text-[11px] font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:outline-none',
              active
                ? 'bg-accent-bg text-accent'
                : 'text-tertiary hover:text-primary',
            ].join(' ')}
            data-testid={`vega-range-${opt.value}`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Row ──────────────────────────────────────────────────────

interface VegaSpikeRowProps {
  spike: VegaSpike;
  range: VegaSpikeRange;
}

const VegaSpikeRow = memo(function VegaSpikeRow({
  spike,
  range,
}: Readonly<VegaSpikeRowProps>) {
  const dirVegaClass = signTextClass(spike.dirVegaFlow);
  const rowClass = [
    'border-edge border-t font-mono text-[11px]',
    spike.confluence ? 'bg-amber-500/5 ring-1 ring-amber-500/40' : '',
  ].join(' ');

  return (
    <tr
      className={rowClass}
      data-testid="vega-spike-row"
      data-confluence={spike.confluence ? 'true' : undefined}
    >
      <td className="text-secondary px-2 py-1.5 whitespace-nowrap">
        {formatTimestamp(spike.timestamp, range)}
      </td>
      <td className="px-2 py-1.5">
        <span
          className={[
            'inline-flex items-center rounded border px-1.5 py-0.5 font-sans text-[10px] font-bold',
            tickerBadgeClass(spike.ticker),
          ].join(' ')}
        >
          {spike.ticker}
        </span>
      </td>
      <td
        className={[
          'px-2 py-1.5 text-right font-semibold tabular-nums',
          dirVegaClass,
        ].join(' ')}
      >
        {formatDirVega(spike.dirVegaFlow)}
      </td>
      <td className="text-secondary px-2 py-1.5 text-right tabular-nums">
        {formatZ(spike.zScore)}
      </td>
      <td className="text-secondary px-2 py-1.5 text-right tabular-nums">
        {formatRatio(spike.vsPriorMax)}
      </td>
      <td
        className={[
          'hidden px-2 py-1.5 text-right tabular-nums md:table-cell',
          signTextClass(spike.fwdReturn5m),
        ].join(' ')}
      >
        {formatReturn(spike.fwdReturn5m)}
      </td>
      <td
        className={[
          'hidden px-2 py-1.5 text-right tabular-nums md:table-cell',
          signTextClass(spike.fwdReturn15m),
        ].join(' ')}
      >
        {formatReturn(spike.fwdReturn15m)}
      </td>
      <td
        className={[
          'hidden px-2 py-1.5 text-right tabular-nums md:table-cell',
          signTextClass(spike.fwdReturn30m),
        ].join(' ')}
      >
        {formatReturn(spike.fwdReturn30m)}
      </td>
      <td
        className={[
          'hidden px-2 py-1.5 text-right tabular-nums md:table-cell',
          signTextClass(spike.fwdReturnEoD),
        ].join(' ')}
      >
        {formatReturn(spike.fwdReturnEoD)}
      </td>
    </tr>
  );
});

// ── Panel ────────────────────────────────────────────────────

interface VegaSpikeFeedProps {
  marketOpen: boolean;
}

export default function VegaSpikeFeed({
  marketOpen,
}: Readonly<VegaSpikeFeedProps>) {
  const { spikes, loading, error, range, setRange } = useVegaSpikes(marketOpen);
  const [tickerFilter, setTickerFilter] = useState<TickerFilter>('all');

  // Client-side ticker filter — the endpoint already returns both
  // tickers' qualifying rows, so we filter in-memory instead of
  // multiplying server-side range/ticker URL combinations.
  const filteredSpikes = useMemo(
    () =>
      tickerFilter === 'all'
        ? spikes
        : spikes.filter((s) => s.ticker === tickerFilter),
    [spikes, tickerFilter],
  );

  const showInitialSpinner = loading && spikes.length === 0;

  return (
    <SectionBox
      label="Dir Vega Spikes"
      badge={`n=${filteredSpikes.length} events`}
      headerRight={
        <div className="flex items-center gap-2">
          <TickerFilterToggle value={tickerFilter} onChange={setTickerFilter} />
          <RangeToggle value={range} onChange={setRange} />
        </div>
      }
      collapsible
    >
      <span className="hidden" data-testid="vega-spike-count">
        n={filteredSpikes.length} events
      </span>

      {/* Error banner — never replaces the table, just sits above. */}
      {error && (
        <div
          className="border-edge bg-danger/5 text-danger -mx-[18px] border-y px-3 py-1.5 font-sans text-[11px]"
          role="status"
          data-testid="vega-spike-error"
        >
          {error}
        </div>
      )}

      {/* Body */}
      {showInitialSpinner ? (
        <div
          className="text-muted px-3 py-6 text-center font-sans text-[11px] italic"
          data-testid="vega-spike-loading"
          role="status"
          aria-live="polite"
        >
          Loading vega spike events…
        </div>
      ) : filteredSpikes.length === 0 ? (
        <div
          className="text-muted px-3 py-6 text-center font-sans text-[11px] italic"
          data-testid="vega-spike-empty"
          role="status"
          aria-live="polite"
        >
          {spikes.length === 0
            ? 'No spikes detected for this range'
            : `No ${tickerFilter} spikes in this range`}
        </div>
      ) : (
        <div className="-mx-[18px] overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-muted font-sans text-[10px] tracking-wider uppercase">
                <th scope="col" className="px-2 py-1.5 font-semibold">
                  Time
                </th>
                <th scope="col" className="px-2 py-1.5 font-semibold">
                  Tkr
                </th>
                <th
                  scope="col"
                  className="px-2 py-1.5 text-right font-semibold"
                >
                  Dir Vega
                </th>
                <th
                  scope="col"
                  className="px-2 py-1.5 text-right font-semibold"
                >
                  z
                </th>
                <th
                  scope="col"
                  className="px-2 py-1.5 text-right font-semibold"
                >
                  vs prior max
                </th>
                <th
                  scope="col"
                  className="hidden px-2 py-1.5 text-right font-semibold md:table-cell"
                >
                  +5m
                </th>
                <th
                  scope="col"
                  className="hidden px-2 py-1.5 text-right font-semibold md:table-cell"
                >
                  +15m
                </th>
                <th
                  scope="col"
                  className="hidden px-2 py-1.5 text-right font-semibold md:table-cell"
                >
                  +30m
                </th>
                <th
                  scope="col"
                  className="hidden px-2 py-1.5 text-right font-semibold md:table-cell"
                >
                  +EoD
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredSpikes.map((spike) => (
                <VegaSpikeRow key={spike.id} spike={spike} range={range} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionBox>
  );
}
