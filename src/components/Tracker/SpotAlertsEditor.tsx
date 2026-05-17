/**
 * SpotAlertsEditor — per-contract underlying-price alerts like
 * "SPY >= 595". Each row is `{ op, level }`. Add via the inline form,
 * remove via the chip.
 *
 * Calls `onChange` with the new list; the parent debounces the PATCH
 * to /api/tracker/contracts/:id.
 */

import { memo, useState, type FormEvent } from 'react';

import type { SpotAlert, SpotAlertOp } from './types.js';

const OPS: SpotAlertOp[] = ['>=', '<=', '>', '<'];

interface Props {
  ticker: string;
  spotAlerts: SpotAlert[] | null;
  onChange: (next: SpotAlert[] | null) => void;
}

export const SpotAlertsEditor = memo(function SpotAlertsEditor({
  ticker,
  spotAlerts,
  onChange,
}: Props) {
  const [op, setOp] = useState<SpotAlertOp>('>=');
  const [levelDraft, setLevelDraft] = useState('');

  const current = spotAlerts ?? [];

  function addAlert(e: FormEvent) {
    e.preventDefault();
    const n = Number.parseFloat(levelDraft);
    if (!Number.isFinite(n)) return;
    const next = [...current, { op, level: n }];
    onChange(next);
    setLevelDraft('');
  }

  function removeAlert(idx: number) {
    const next = current.filter((_, i) => i !== idx);
    onChange(next.length === 0 ? null : next);
  }

  return (
    <div>
      <div className="text-tertiary mb-1.5 font-sans text-[11px] font-semibold uppercase">
        Spot-price alerts ({ticker})
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {current.length === 0 && (
          <span className="text-tertiary font-sans text-[11px] italic">
            None set
          </span>
        )}
        {current.map((a, idx) => (
          <button
            type="button"
            key={`${a.op}-${String(a.level)}-${String(idx)}`}
            onClick={() => removeAlert(idx)}
            aria-label={`Remove ${ticker} ${a.op} ${String(a.level)} alert`}
            className="text-accent bg-accent-bg flex cursor-pointer items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold transition-opacity hover:opacity-70"
          >
            {ticker} {a.op} {a.level}
            <span aria-hidden="true">&#x2715;</span>
          </button>
        ))}
        <form onSubmit={addAlert} className="flex items-center gap-1">
          <select
            value={op}
            onChange={(e) => setOp(e.target.value as SpotAlertOp)}
            aria-label="Spot alert comparison operator"
            className="border-edge bg-surface focus:border-accent rounded border px-1.5 py-0.5 font-mono text-[11px] outline-none"
          >
            {OPS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={levelDraft}
            onChange={(e) => setLevelDraft(e.target.value)}
            placeholder="595"
            aria-label="Spot alert level"
            className="border-edge bg-surface focus:border-accent w-20 rounded border px-1.5 py-0.5 font-mono text-[11px] outline-none"
          />
          <button
            type="submit"
            className="text-accent hover:bg-accent-bg cursor-pointer rounded px-1.5 py-0.5 font-sans text-[11px] font-semibold"
            aria-label="Add spot alert"
          >
            Add
          </button>
        </form>
      </div>
    </div>
  );
});
