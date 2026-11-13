/**
 * The D1 scope of Phase 5 of docs/superpowers/specs/
 * futures-contract-mix-repair-2026-11-06.md. RTY, CL, GC and ZN have no rebuild
 * source (the archive and the ticks hold ES and NQ only), so their bars in the
 * contract-mix window are deleted, except the seven days the Phase 1 detector
 * found clean. The bar delete (futures-contract-repair.ts, `--thin-roots`) and
 * the snapshot follow-up (futures-derived-recompute.ts, which lifts ruling 9
 * once no such bar is left) read the scope from here.
 */

import { getCTDateStr } from '../../src/utils/timezone.js';

/** The roots with no rebuild source. */
export const THIN_ROOTS = ['RTY', 'CL', 'GC', 'ZN'] as const;
export type ThinRoot = (typeof THIN_ROOTS)[number];

export const isThinRoot = (symbol: string): symbol is ThinRoot =>
  (THIN_ROOTS as readonly string[]).includes(symbol);

/** The first bad evening: Sunday 2026-04-05 17:00 CDT. Bars before it were never mixed. */
export const THIN_WINDOW_START_MS = Date.UTC(2026, 3, 5, 22, 0);

/**
 * Each root's last bad bar, inclusive (b-forensics.md section 4): Monday
 * 2026-06-15 09:10 CT for RTY, CL and GC, 09:11 for ZN.
 */
export const THIN_LAST_BAD_MS: Record<ThinRoot, number> = {
  RTY: Date.UTC(2026, 5, 15, 14, 10),
  CL: Date.UTC(2026, 5, 15, 14, 10),
  GC: Date.UTC(2026, 5, 15, 14, 10),
  ZN: Date.UTC(2026, 5, 15, 14, 11),
};

/** CT trading days inside the window with no flagged bar for any root. */
export const CLEAN_TRADING_DAYS: readonly string[] = [
  '2026-04-13',
  '2026-04-14',
  '2026-04-15',
  '2026-04-16',
  '2026-04-17',
  '2026-06-01',
  '2026-06-08',
];

/**
 * Phase 2's off-session junk window, [start, end): Friday 16:00 CDT to Sunday
 * 17:00 CDT (b-forensics.md 1.4). Phase 2 deleted the junk bars of all six roots
 * in it, so its backup holds thin-root deletes here too, but only here: a
 * thin-root delete outside it can only be Phase 5a's. The repair tool plans the
 * Phase 2 delete from it and the recompute tool tells the two backups apart by it.
 */
export const JUNK_WINDOW = {
  startMs: Date.UTC(2026, 3, 10, 21, 0),
  endMs: Date.UTC(2026, 3, 12, 22, 0),
} as const;

const TRADING_DAY_SHIFT_MS = 7 * 60 * 60_000;

/**
 * The CT trading day of a time, as the Phase 1 detector keys its flags: the CT
 * date of the time plus 7 hours, so the Globex session that opens at 17:00 CT
 * belongs to the next calendar day.
 */
export const ctTradingDay = (tsMs: number): string =>
  getCTDateStr(new Date(tsMs + TRADING_DAY_SHIFT_MS));

/** A bar from the first bad evening through the root's last bad bar. */
export const inThinWindow = (root: ThinRoot, tsMs: number): boolean =>
  tsMs >= THIN_WINDOW_START_MS && tsMs <= THIN_LAST_BAD_MS[root];

/** A bar the D1 delete takes: in the window, and not on a clean day. */
export const isThinDeleteBar = (root: ThinRoot, tsMs: number): boolean =>
  inThinWindow(root, tsMs) && !CLEAN_TRADING_DAYS.includes(ctTradingDay(tsMs));
