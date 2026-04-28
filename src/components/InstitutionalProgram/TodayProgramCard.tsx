import { useMemo, useState } from 'react';
import type {
  DailyProgramSummary,
  InstitutionalBlock,
} from '../../hooks/useInstitutionalProgram.js';
import { getCTTime } from '../../utils/timezone.js';

interface Props {
  today: DailyProgramSummary | null;
  blocks: InstitutionalBlock[];
}

type SortKey =
  | 'time'
  | 'strike'
  | 'type'
  | 'dte'
  | 'size'
  | 'premium'
  | 'side'
  | 'cond';
type SortDir = 'asc' | 'desc';

/** Format an executed_at UTC timestamp as `HH:MM:SS.sss` in Central Time.
 * Uses `getCTTime` (Intl-backed, DST-safe) for hour/minute. Replaces an
 * earlier hardcoded `-5h` offset that was correct during CDT but ran 1
 * hour late during CST. */
function formatCTTimestamp(iso: string): string {
  const ts = new Date(iso);
  const { hour, minute } = getCTTime(ts);
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  const ss = String(ts.getUTCSeconds()).padStart(2, '0');
  const ms = String(ts.getUTCMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

/** Neon DOUBLE PRECISION comes through as a string; cast for both
 * display and sort to avoid lexical comparison bugs ('$896k' > '$1.9M'). */
function formatPremium(premium: number | string): string {
  const n = Number(premium);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `$${Math.round(n / 1000)}k`;
  return `$${(n / 1000).toFixed(1)}k`;
}

function blockSortKey(b: InstitutionalBlock, k: SortKey): number | string {
  switch (k) {
    case 'time':
      return new Date(b.executed_at).getTime();
    case 'strike':
      return Number(b.strike);
    case 'type':
      return b.option_type;
    case 'dte':
      return Number(b.dte);
    case 'size':
      return Number(b.size);
    case 'premium':
      return Number(b.premium);
    case 'side':
      return b.side ?? '';
    case 'cond':
      return b.condition;
  }
}

/**
 * Today's dominant program pair + expandable block log for the
 * ceiling track. Shows the institutional "ceiling view" of SPX
 * alongside the raw blocks that generated it.
 */
export function TodayProgramCard({ today, blocks }: Props) {
  const ceilingBlocks = blocks.filter((b) => b.program_track === 'ceiling');

  if (!today?.dominant_pair) {
    return (
      <div className="border-edge bg-surface-alt rounded-lg border p-4 text-sm text-slate-500">
        No paired institutional ceiling blocks detected today yet. (First poll
        at 08:45 CT.)
      </div>
    );
  }

  const { low_strike, high_strike, direction, total_size, total_premium } =
    today.dominant_pair;
  const spot = today.avg_spot ?? 0;
  const ceilingPct = today.ceiling_pct_above_spot ?? 0;

  // Coerce — Neon returns DOUBLE PRECISION as string.
  const totalSizeNum = Number(total_size);
  const totalPremiumNum = Number(total_premium);
  const lowStrikeNum = Number(low_strike);
  const highStrikeNum = Number(high_strike);
  const spotNum = Number(spot);
  const ceilingPctNum = Number(ceilingPct);

  return (
    <div className="grid gap-3 md:grid-cols-3">
      <Metric label="Spread" value={`${lowStrikeNum} / ${highStrikeNum}`} />
      <Metric
        label="Direction"
        value={direction.toUpperCase()}
        tone={
          direction === 'sell' ? 'green' : direction === 'buy' ? 'red' : 'gray'
        }
      />
      <Metric label="Contracts" value={totalSizeNum.toLocaleString()} />
      <Metric label="Premium" value={formatPremium(totalPremiumNum)} />
      <Metric label="Spot" value={spotNum.toFixed(2)} />
      <Metric
        label="Ceiling above spot"
        value={`${(ceilingPctNum * 100).toFixed(1)}%`}
        tone="blue"
      />
      <details className="md:col-span-3">
        <summary className="text-muted cursor-pointer text-sm">
          All ceiling blocks today ({ceilingBlocks.length})
        </summary>
        <SortableBlockTable blocks={ceilingBlocks} />
      </details>
    </div>
  );
}

function SortableBlockTable({ blocks }: { blocks: InstitutionalBlock[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('time');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const sorted = useMemo(() => {
    const arr = [...blocks];
    arr.sort((a, b) => {
      const av = blockSortKey(a, sortKey);
      const bv = blockSortKey(b, sortKey);
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return arr;
  }, [blocks, sortKey, sortDir]);

  const handleSort = (k: SortKey) => {
    if (sortKey === k) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(k);
      setSortDir('desc');
    }
  };

  return (
    <div className="mt-2 overflow-x-auto">
      <table className="text-text w-full text-xs">
        <thead>
          <tr className="border-edge text-muted border-b">
            <SortTh
              label="Time (CT)"
              k="time"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              align="left"
            />
            <SortTh
              label="Strike"
              k="strike"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              align="right"
            />
            <SortTh
              label="Type"
              k="type"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
            />
            <SortTh
              label="DTE"
              k="dte"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              align="right"
            />
            <SortTh
              label="Size"
              k="size"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              align="right"
            />
            <SortTh
              label="Premium"
              k="premium"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              align="right"
            />
            <SortTh
              label="Side"
              k="side"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
            />
            <SortTh
              label="Cond"
              k="cond"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
            />
          </tr>
        </thead>
        <tbody>
          {sorted.map((b, i) => {
            // HH:MM:SS.sss — sub-second precision disambiguates burst
            // clusters of distinct trades that share identical size /
            // price / premium but executed at different microseconds.
            const timeDisplay = formatCTTimestamp(b.executed_at);
            return (
              <tr
                key={
                  b.executed_at +
                  b.option_chain_id +
                  String(b.size) +
                  String(b.price) +
                  String(i)
                }
                className="border-edge border-b"
              >
                <td className="p-1 font-mono">{timeDisplay}</td>
                <td className="p-1 text-right font-mono">{b.strike}</td>
                <td className="p-1">{b.option_type[0]!.toUpperCase()}</td>
                <td className="p-1 text-right">{b.dte}</td>
                <td className="p-1 text-right">
                  {Number(b.size).toLocaleString()}
                </td>
                <td className="p-1 text-right">{formatPremium(b.premium)}</td>
                <td className="p-1">{b.side ?? '—'}</td>
                <td className="text-muted p-1">{b.condition}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SortTh({
  label,
  k,
  sortKey,
  sortDir,
  onSort,
  align = 'left',
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  align?: 'left' | 'right';
}) {
  const active = sortKey === k;
  const arrow = active ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
  return (
    <th
      className={`cursor-pointer p-1 select-none ${align === 'right' ? 'text-right' : 'text-left'} ${active ? 'text-text' : ''}`}
      onClick={() => onSort(k)}
      aria-sort={
        active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'
      }
    >
      {label}
      <span className="text-muted">{arrow}</span>
    </th>
  );
}

function Metric({
  label,
  value,
  tone = 'slate',
}: {
  label: string;
  value: string;
  tone?: 'slate' | 'blue' | 'green' | 'red' | 'gray';
}) {
  const toneClass = {
    slate: 'text-slate-100',
    blue: 'text-blue-300',
    green: 'text-green-300',
    red: 'text-red-300',
    gray: 'text-slate-400',
  }[tone];
  return (
    <div className="border-edge bg-surface-alt rounded-lg border p-3">
      <div className="text-xs text-slate-500 uppercase">{label}</div>
      <div className={`text-lg font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}
