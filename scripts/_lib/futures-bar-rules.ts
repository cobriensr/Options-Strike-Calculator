/**
 * What the plain futures bar backfill (`futures-bar-backfill.ts`) and its
 * `--repair` mode (`futures-bar-repair.ts`) do the same way: the rounding, the
 * bar built from a rebuilt minute, the contract a bar may carry, the four
 * price fields, and the re-run lines a run ends with. Neither of those two
 * modules imports the other; both import this one.
 */

import { resolve } from 'node:path';

import type { FuturesBarRow } from '../../api/_lib/futures-bars.js';
import {
  parseContract,
  type FuturesRoot,
} from '../../api/_lib/futures-contracts.js';
import type { FlowMinute } from '../../api/_lib/futures-flow-repair.js';
import type { BarBackfillOptions } from './futures-bar-backfill.js';
import {
  reportStoppedEarly,
  rerunArgs,
  type DayLoopResult,
  type DayPlan,
} from './futures-flow-backfill.js';

// ── Bar rules ───────────────────────────────────────────────

/**
 * Rounds a plain decimal string to 4 dp, half away from zero, as the
 * NUMERIC(12,4) column rounds what it stores (107.203125 → 107.2031).
 * Exact on the digits, so no float rounding.
 */
export function roundTo4dp(price: string): string {
  const [int = '0', frac = ''] = price.split('.');
  const kept = frac.slice(0, 4).padEnd(4, '0');
  if ((frac[4] ?? '0') < '5') return `${int}.${kept}`;
  const scaled = (BigInt(int + kept) + 1n).toString().padStart(5, '0');
  return `${scaled.slice(0, -4)}.${scaled.slice(-4)}`;
}

/**
 * The bar for a minute of the scheduled contract, or null when its prices
 * aren't known. Flow is NULL (unknown) unless some print had a known side.
 */
export function toBar(m: FlowMinute): FuturesBarRow | null {
  if (m.ohlc === null) return null;
  return {
    ts: m.ts,
    ...m.ohlc,
    volume: m.volume,
    buyVolume: m.sideSeen ? m.buyVolume : null,
    sellVolume: m.sideSeen ? m.sellVolume : null,
    buyPrints: m.sideSeen ? m.buyPrints : null,
    sellPrints: m.sideSeen ? m.sellPrints : null,
  };
}

/**
 * The scheduled contract as the column can store it. A name that is no
 * outright of the root would fail the column's CHECK for the whole 500-row
 * chunk, bars already stored included, so it is stored as NULL (unknown).
 * A decision row is canonical by construction; a bad one is warned about.
 */
export function storableContract(
  root: FuturesRoot,
  contract: string,
  tsIso: string,
): string | null {
  return parseContract(root, contract, tsIso) === null ? null : contract;
}

export const PRICE_FIELDS = ['open', 'high', 'low', 'close'] as const;

// ── Re-run lines ────────────────────────────────────────────

/**
 * The run's mode flag as `rerunArgs` appends it, with its leading space. A
 * repair's line names its work dir in full, so a re-run from another
 * directory finds the same cache and backup.
 */
function modeFlag(opts: BarBackfillOptions): string {
  if (opts.compare) return ' --compare';
  if (opts.repair) {
    const flags = ['--repair'];
    if (opts.dryRun) flags.push('--dry-run');
    if (opts.noCache) flags.push('--no-cache');
    flags.push('--work-dir', resolve(opts.workDir));
    return ` ${flags.join(' ')}`;
  }
  return opts.dryRun ? ' --dry-run' : '';
}

/**
 * Says what a re-run must still cover: every failed root-day, and every
 * date the loop never reached. Silent when the run was complete.
 */
export function reportIncomplete(
  opts: BarBackfillOptions,
  plan: readonly DayPlan[],
  loop: DayLoopResult,
): void {
  if (loop.failed.length > 0) {
    const list = loop.failed.map((f) => `${f.root} ${f.date}`).join(', ');
    const dates = [...new Set(loop.failed.map((f) => f.date))].sort();
    const failedRoots = new Set(loop.failed.map((f) => f.root));
    const roots = opts.roots.filter((r) => failedRoots.has(r));
    console.error(`Failed root-days: ${list}`);
    console.error(
      `Re-run with ${rerunArgs(opts, dates, roots, modeFlag(opts))}`,
    );
  }
  reportStoppedEarly(opts, plan, loop.stoppedBefore, modeFlag(opts));
}
