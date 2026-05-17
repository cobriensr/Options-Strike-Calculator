/**
 * ThresholdsEditor — per-contract override for the up/down percent
 * thresholds. Renders the current values as removable chips plus an
 * "add" input. Default thresholds are shown as a hint when the
 * server-side row has `up_thresholds=null` / `down_thresholds=null`.
 *
 * Wires up to the parent via `onChange(up, down)`. The parent debounces
 * its PATCH to /api/tracker/contracts/:id so we don't spam the server
 * on each chip add/remove.
 */

import { memo, useState, type FormEvent } from 'react';

import { DEFAULT_DOWN_THRESHOLDS, DEFAULT_UP_THRESHOLDS } from './types.js';

interface Props {
  upThresholds: number[] | null;
  downThresholds: number[] | null;
  onChange: (up: number[] | null, down: number[] | null) => void;
}

function parseChipValue(raw: string): number | null {
  const trimmed = raw.trim().replace(/%$/, '');
  const n = Number.parseFloat(trimmed);
  return Number.isFinite(n) ? n : null;
}

export const ThresholdsEditor = memo(function ThresholdsEditor({
  upThresholds,
  downThresholds,
  onChange,
}: Props) {
  const [upDraft, setUpDraft] = useState('');
  const [downDraft, setDownDraft] = useState('');

  const effectiveUp = upThresholds ?? DEFAULT_UP_THRESHOLDS;
  const effectiveDown = downThresholds ?? DEFAULT_DOWN_THRESHOLDS;
  const usingDefaultsUp = upThresholds == null;
  const usingDefaultsDown = downThresholds == null;

  function addUp(e: FormEvent) {
    e.preventDefault();
    const n = parseChipValue(upDraft);
    if (n == null || n <= 0) return;
    const next = [...effectiveUp, n].sort((a, b) => a - b);
    onChange(next, downThresholds);
    setUpDraft('');
  }

  function addDown(e: FormEvent) {
    e.preventDefault();
    const n = parseChipValue(downDraft);
    if (n == null || n >= 0) return;
    const next = [...effectiveDown, n].sort((a, b) => b - a);
    onChange(upThresholds, next);
    setDownDraft('');
  }

  function removeUp(value: number) {
    const next = effectiveUp.filter((v) => v !== value);
    onChange(next.length === 0 ? null : next, downThresholds);
  }

  function removeDown(value: number) {
    const next = effectiveDown.filter((v) => v !== value);
    onChange(upThresholds, next.length === 0 ? null : next);
  }

  return (
    <div className="space-y-3">
      <div>
        <div className="text-tertiary mb-1.5 font-sans text-[11px] font-semibold uppercase">
          Up thresholds (%){' '}
          {usingDefaultsUp && (
            <span className="text-tertiary normal-case opacity-70">
              (using defaults)
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {effectiveUp.map((v) => (
            <button
              type="button"
              key={`up-${String(v)}`}
              onClick={() => removeUp(v)}
              aria-label={`Remove up threshold ${String(v)}%`}
              className="text-success flex cursor-pointer items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold transition-opacity hover:opacity-70"
              style={{
                backgroundColor:
                  'color-mix(in srgb, var(--color-success) 15%, transparent)',
              }}
            >
              +{v}%<span aria-hidden="true">&#x2715;</span>
            </button>
          ))}
          <form onSubmit={addUp} className="flex items-center gap-1">
            <input
              type="text"
              value={upDraft}
              onChange={(e) => setUpDraft(e.target.value)}
              placeholder="+75"
              aria-label="New up threshold percentage"
              className="border-edge bg-surface focus:border-accent w-16 rounded border px-1.5 py-0.5 font-mono text-[11px] outline-none"
            />
            <button
              type="submit"
              className="text-accent hover:bg-accent-bg cursor-pointer rounded px-1.5 py-0.5 font-sans text-[11px] font-semibold"
              aria-label="Add up threshold"
            >
              Add
            </button>
          </form>
        </div>
      </div>

      <div>
        <div className="text-tertiary mb-1.5 font-sans text-[11px] font-semibold uppercase">
          Down thresholds (%){' '}
          {usingDefaultsDown && (
            <span className="text-tertiary normal-case opacity-70">
              (using defaults)
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {effectiveDown.map((v) => (
            <button
              type="button"
              key={`dn-${String(v)}`}
              onClick={() => removeDown(v)}
              aria-label={`Remove down threshold ${String(v)}%`}
              className="text-danger flex cursor-pointer items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold transition-opacity hover:opacity-70"
              style={{
                backgroundColor:
                  'color-mix(in srgb, var(--color-danger) 15%, transparent)',
              }}
            >
              {v}%<span aria-hidden="true">&#x2715;</span>
            </button>
          ))}
          <form onSubmit={addDown} className="flex items-center gap-1">
            <input
              type="text"
              value={downDraft}
              onChange={(e) => setDownDraft(e.target.value)}
              placeholder="-20"
              aria-label="New down threshold percentage"
              className="border-edge bg-surface focus:border-accent w-16 rounded border px-1.5 py-0.5 font-mono text-[11px] outline-none"
            />
            <button
              type="submit"
              className="text-accent hover:bg-accent-bg cursor-pointer rounded px-1.5 py-0.5 font-sans text-[11px] font-semibold"
              aria-label="Add down threshold"
            >
              Add
            </button>
          </form>
        </div>
      </div>
    </div>
  );
});
