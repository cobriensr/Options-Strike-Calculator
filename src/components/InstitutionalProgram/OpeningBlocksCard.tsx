import { useMemo, useState } from 'react';
import type { InstitutionalBlock } from '../../hooks/useInstitutionalProgram.js';

interface Props {
  blocks: InstitutionalBlock[];
  /** Human label for the date being shown — 'today' or a YYYY-MM-DD string. */
  dateLabel?: string;
}

type SortKey =
  | 'time'
  | 'strike'
  | 'type'
  | 'dte'
  | 'size'
  | 'premium'
  | 'mny'
  | 'cond';
type SortDir = 'asc' | 'desc';

/** Format premium in $k for sub-$1M and $M for ≥$1M. */
function formatPremium(premium: number): string {
  if (premium >= 1_000_000) {
    return `$${(premium / 1_000_000).toFixed(2)}M`;
  }
  if (premium >= 10_000) {
    return `$${Math.round(premium / 1000)}k`;
  }
  return `$${(premium / 1000).toFixed(1)}k`;
}

/**
 * First-hour near-ATM institutional blocks (opening_atm track) for the
 * selected date. Sortable columns, CT-formatted times, dynamic premium
 * units ($k under $1M, $M at or above).
 */
export function OpeningBlocksCard({ blocks, dateLabel = 'today' }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('time');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const openingBlocks = useMemo(
    () => blocks.filter((b) => b.program_track === 'opening_atm'),
    [blocks],
  );

  const sorted = useMemo(() => {
    const keyed = openingBlocks.map((b) => ({ b, values: keyFor(b) }));
    keyed.sort((a, b) => {
      const av = a.values[sortKey];
      const bv = b.values[sortKey];
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return keyed.map((x) => x.b);
  }, [openingBlocks, sortKey, sortDir]);

  const headerLabel =
    dateLabel === 'today'
      ? "Today's opening institutional blocks"
      : `Opening institutional blocks — ${dateLabel}`;

  if (!openingBlocks.length) {
    return (
      <div className="border-edge bg-surface-alt text-muted rounded-lg border p-3 text-sm">
        No opening-hour institutional blocks detected for{' '}
        {dateLabel === 'today' ? 'today' : dateLabel} (08:30-09:30 CT,
        near-ATM, mfsl/cbmo/slft).
      </div>
    );
  }

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  return (
    <div className="border-edge bg-surface-alt rounded-lg border p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-text text-sm font-semibold">{headerLabel}</h3>
        <span className="text-muted text-xs">
          {openingBlocks.length} block{openingBlocks.length === 1 ? '' : 's'}{' '}
          — 08:30-09:30 CT, near-ATM
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="text-text w-full text-xs">
          <thead>
            <tr className="border-edge text-muted border-b">
              <Th label="Time (CT)" k="time" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} align="left" />
              <Th label="Strike"    k="strike" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} align="right" />
              <Th label="Type"      k="type" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <Th label="DTE"       k="dte" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} align="right" />
              <Th label="Size"      k="size" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} align="right" />
              <Th label="Premium"   k="premium" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} align="right" />
              <Th label="Mny"       k="mny" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} align="right" />
              <Th label="Cond"      k="cond" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((b) => {
              const ct = new Date(
                new Date(b.executed_at).getTime() - 5 * 3600 * 1000,
              );
              return (
                <tr
                  key={b.executed_at + b.option_chain_id + b.size}
                  className="border-edge border-b"
                >
                  <td className="p-1 font-mono">
                    {ct.toISOString().slice(11, 19)}
                  </td>
                  <td className="p-1 text-right font-mono">{b.strike}</td>
                  <td className="p-1">{b.option_type[0]!.toUpperCase()}</td>
                  <td className="p-1 text-right">{b.dte}</td>
                  <td className="p-1 text-right">
                    {b.size.toLocaleString()}
                  </td>
                  <td className="p-1 text-right">{formatPremium(b.premium)}</td>
                  <td className="p-1 text-right">
                    {(b.moneyness_pct * 100).toFixed(2)}%
                  </td>
                  <td className="text-muted p-1">{b.condition}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── helpers ───────────────────────────────────────────────────

function Th({
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
      role="button"
      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      {label}
      <span className="text-muted">{arrow}</span>
    </th>
  );
}

type KeyValues = Record<SortKey, number | string>;

function keyFor(b: InstitutionalBlock): KeyValues {
  return {
    time: new Date(b.executed_at).getTime(),
    strike: b.strike,
    type: b.option_type,
    dte: b.dte,
    size: b.size,
    premium: b.premium,
    mny: b.moneyness_pct,
    cond: b.condition,
  };
}
