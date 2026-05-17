/**
 * ContractTable — renders a list of TrackerContract rows grouped by
 * Ticker or Expiration. The grouping toggle is a 2-way chip selector.
 *
 * Rows themselves are rendered via ContractRow which is independently
 * memoized so a single-row update doesn't re-render the whole table.
 */

import { memo, useMemo } from 'react';

import { ContractRow } from './ContractRow.js';
import type {
  ContractUpdateInput,
  TrackerAlert,
  TrackerContract,
} from './types.js';
import { formatExpiryMD } from './helpers.js';

export type GroupMode = 'expiration' | 'ticker';

interface Props {
  contracts: TrackerContract[];
  alerts: TrackerAlert[];
  groupBy: GroupMode;
  onGroupByChange: (mode: GroupMode) => void;
  onUpdate: (id: number, body: ContractUpdateInput) => Promise<void>;
  onClose: (id: number, closedPrice: number) => Promise<void>;
}

interface Group {
  key: string;
  label: string;
  rows: TrackerContract[];
}

function groupContracts(
  contracts: TrackerContract[],
  mode: GroupMode,
): Group[] {
  const map = new Map<string, Group>();
  for (const c of contracts) {
    const key = mode === 'expiration' ? c.expiry : c.ticker;
    const label =
      mode === 'expiration'
        ? `${formatExpiryMD(c.expiry)} (${c.expiry})`
        : c.ticker;
    const existing = map.get(key);
    if (existing) {
      existing.rows.push(c);
    } else {
      map.set(key, { key, label, rows: [c] });
    }
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export const ContractTable = memo(function ContractTable({
  contracts,
  alerts,
  groupBy,
  onGroupByChange,
  onUpdate,
  onClose,
}: Props) {
  const groups = useMemo(
    () => groupContracts(contracts, groupBy),
    [contracts, groupBy],
  );

  const unreadByContract = useMemo(() => {
    const set = new Set<number>();
    for (const a of alerts) set.add(a.contract_id);
    return set;
  }, [alerts]);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div
          role="radiogroup"
          aria-label="Group rows by"
          className="flex items-center gap-1"
        >
          <span className="text-tertiary mr-1 font-sans text-[11px] font-semibold uppercase">
            Group by
          </span>
          {(['expiration', 'ticker'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={groupBy === m}
              onClick={() => onGroupByChange(m)}
              className={
                'cursor-pointer rounded-full border px-2 py-0.5 font-sans text-[11px] font-semibold capitalize ' +
                (groupBy === m
                  ? 'text-accent border-accent bg-accent-bg'
                  : 'border-edge text-secondary')
              }
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {contracts.length === 0 ? (
        <div className="text-tertiary py-6 text-center font-sans text-[13px] italic">
          No contracts.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-edge bg-table-header border-b">
                <th className="text-tertiary px-2 py-1.5 text-left font-sans text-[11px] font-semibold uppercase">
                  Ticker
                </th>
                <th className="text-tertiary px-2 py-1.5 text-left font-sans text-[11px] font-semibold uppercase">
                  Contract
                </th>
                <th className="text-tertiary px-2 py-1.5 text-right font-sans text-[11px] font-semibold uppercase">
                  Entry
                </th>
                <th className="text-tertiary px-2 py-1.5 text-right font-sans text-[11px] font-semibold uppercase">
                  Current
                </th>
                <th className="text-tertiary px-2 py-1.5 text-right font-sans text-[11px] font-semibold uppercase">
                  Δ$
                </th>
                <th className="text-tertiary px-2 py-1.5 text-right font-sans text-[11px] font-semibold uppercase">
                  Δ%
                </th>
                <th className="text-tertiary px-2 py-1.5 text-right font-sans text-[11px] font-semibold uppercase">
                  DTE
                </th>
                <th className="text-tertiary px-2 py-1.5 text-right font-sans text-[11px] font-semibold uppercase">
                  Size
                </th>
                <th className="text-tertiary px-2 py-1.5 text-left font-sans text-[11px] font-semibold uppercase">
                  Notes
                </th>
                <th className="text-tertiary px-2 py-1.5 text-right font-sans text-[11px] font-semibold uppercase">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <GroupBlock
                  key={g.key}
                  label={g.label}
                  rows={g.rows}
                  unreadByContract={unreadByContract}
                  onUpdate={onUpdate}
                  onClose={onClose}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
});

interface GroupBlockProps {
  label: string;
  rows: TrackerContract[];
  unreadByContract: Set<number>;
  onUpdate: (id: number, body: ContractUpdateInput) => Promise<void>;
  onClose: (id: number, closedPrice: number) => Promise<void>;
}

const GroupBlock = memo(function GroupBlock({
  label,
  rows,
  unreadByContract,
  onUpdate,
  onClose,
}: GroupBlockProps) {
  return (
    <>
      <tr className="bg-surface-alt">
        <td
          colSpan={10}
          className="text-tertiary px-2 py-1 font-sans text-[11px] font-semibold uppercase"
        >
          {label}
          <span className="text-tertiary ml-2 normal-case opacity-70">
            ({rows.length})
          </span>
        </td>
      </tr>
      {rows.map((c) => (
        <ContractRow
          key={c.id}
          contract={c}
          hasUnreadAlert={unreadByContract.has(c.id)}
          onUpdate={onUpdate}
          onClose={onClose}
        />
      ))}
    </>
  );
});
