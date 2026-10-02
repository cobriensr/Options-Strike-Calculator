/**
 * Orchestration for scripts/backfill-periscope-lottery-outcomes.ts: the
 * per-day evaluation, the parity gate, the guarded batch write, and the run
 * itself. It lives here, not in the entry script, so vitest covers it
 * (scripts/_lib/**). The bar ↔ trade-tape mapping is in
 * api/_lib/periscope-lottery-outcome.ts. Design, thresholds and dry-run
 * numbers: docs/superpowers/specs/periscope-lottery-outcome-backfill-2026-10-02.md.
 */

import { isMarketHours } from '../../api/_lib/cron-helpers.js';
import { WS_OPTION_TRADES_RETENTION_DAYS } from '../../api/_lib/constants.js';
import { getDb, withDbRetry } from '../../api/_lib/db.js';
import {
  barParityMismatches,
  barTapeLive,
  outcomeFromMinuteBars,
  periscopeFireWindow,
  type BarAbstainReason,
  type BarOutcomeValues,
  type MinuteBar,
  type PeriscopeFireWindow,
  type PeriscopeLotteryFireType,
  type StoredOutcome,
} from '../../api/_lib/periscope-lottery-outcome.js';
import { UW_CONCURRENCY_CAP } from '../../api/_lib/uw-concurrency.js';
import { mapWithConcurrency } from '../../api/_lib/uw-fetch.js';
import {
  fetchContractDayBars,
  uwOptionSymbol,
} from '../../api/_lib/uw-option-contract-bars.js';

/** Fewer comparable cron fires than this cannot establish parity. */
export const PARITY_MIN_COMPARED = 20;
/** Fires per UPDATE statement (R5: batch around 500 rows). */
export const WRITE_CHUNK = 500;

// ── Types ────────────────────────────────────────────────────────────────

type DbNumeric = string | number;
type DbTimestamp = string | Date;

export interface FireRow {
  id: DbNumeric;
  fire_type: PeriscopeLotteryFireType;
  fire_time: DbTimestamp;
  expiry: string;
  trade_strike: number;
  /** NUMERIC as the driver returns it; reused verbatim in the write guard. */
  entry_px: DbNumeric;
}

export interface LockedFireRow extends FireRow {
  peak_px: DbNumeric | null;
  peak_pct: DbNumeric | null;
  peak_time: DbTimestamp | null;
  eod_close_px: DbNumeric | null;
  realized_r_peak: DbNumeric | null;
  realized_r_eod: DbNumeric | null;
}

export interface Fire {
  id: number;
  expiry: string;
  symbol: string;
  entryPx: number;
  entryPxRaw: DbNumeric;
  window: PeriscopeFireWindow;
}

export type AbstainReason =
  | BarAbstainReason
  | 'no_bars'
  | 'uw_error'
  | 'tape_tail_dead'
  | 'in_flight'
  | 'bad_entry_px';

export type FireResult =
  | { kind: 'locked'; values: BarOutcomeValues }
  | { kind: 'abstain'; reason: AbstainReason };

export interface ContractIssue {
  symbol: string;
  day: string;
  fires: number;
  detail: string;
}

export interface DayEval {
  results: Map<number, FireResult>;
  uwCalls: number;
  noBars: ContractIssue[];
  uwErrors: ContractIssue[];
}

export interface BackfillOptions {
  apply: boolean;
  /** Expiry range, inclusive; null = unbounded. */
  startDate: string | null;
  endDate: string | null;
  /** Max cron-locked fires compared by the parity gate. */
  parityLimit: number;
  /** Computed rows printed as a sample. */
  sampleSize: number;
  apiKey: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────

const toNum = (v: DbNumeric): number => (typeof v === 'number' ? v : Number(v));
const toNumOrNull = (v: DbNumeric | null): number | null =>
  v === null ? null : toNum(v);
const toDate = (v: DbTimestamp): Date => (v instanceof Date ? v : new Date(v));

export function toFire(r: FireRow): Fire {
  const optionType = r.fire_type === 'call_lottery' ? 'C' : 'P';
  return {
    // The int8 id arrives as a string from the driver.
    id: Number(r.id),
    expiry: r.expiry,
    symbol: uwOptionSymbol('SPXW', r.expiry, optionType, r.trade_strike),
    entryPx: toNum(r.entry_px),
    entryPxRaw: r.entry_px,
    window: periscopeFireWindow(r.fire_type, toDate(r.fire_time), r.expiry),
  };
}

function groupBy<T, K>(items: readonly T[], key: (t: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = out.get(k);
    if (list === undefined) out.set(k, [it]);
    else list.push(it);
  }
  return out;
}

function increment<K>(m: Map<K, number>, k: K): void {
  m.set(k, (m.get(k) ?? 0) + 1);
}

const fmtPx = (n: number | null): string => (n === null ? '—' : n.toFixed(2));
const fmtR = (n: number): string => (n >= 0 ? '+' : '') + n.toFixed(3);
const fmtIds = (ids: readonly number[], cap = 40): string =>
  ids.length <= cap
    ? ids.join(', ')
    : `${ids.slice(0, cap).join(', ')}, … (+${ids.length - cap} more)`;
/** 'reason n, reason n' */
const fmtCounts = (counts: ReadonlyMap<string, number>): string =>
  [...counts].map(([reason, n]) => reason + ' ' + String(n)).join(', ');

/** The parity rule: no mismatch, and enough comparable fires to mean it. */
export function parityPasses(compared: number, mismatched: number): boolean {
  return mismatched === 0 && compared >= PARITY_MIN_COMPARED;
}

// ── Evaluation ───────────────────────────────────────────────────────────

/**
 * Evaluate one expiry day: fetch every contract-day once (≤ the UW
 * concurrency cap in flight), then compute each fire. Every fire gets a
 * result; nothing is dropped silently.
 */
export async function evaluateDay(
  apiKey: string,
  day: string,
  fires: readonly Fire[],
  nowMs: number,
): Promise<DayEval> {
  const results = new Map<number, FireResult>();
  const noBars: ContractIssue[] = [];
  const uwErrors: ContractIssue[] = [];

  const usable = fires.filter((f) => {
    if (Number.isFinite(f.entryPx) && f.entryPx > 0) return true;
    results.set(f.id, { kind: 'abstain', reason: 'bad_entry_px' });
    return false;
  });
  const byContract = groupBy(usable, (f) => f.symbol);
  const symbols = [...byContract.keys()];
  const fetched = await mapWithConcurrency(symbols, UW_CONCURRENCY_CAP, (s) =>
    fetchContractDayBars(apiKey, s, day),
  );

  const barsBySymbol = new Map<string, MinuteBar[]>();
  const dayBars: MinuteBar[] = [];
  symbols.forEach((symbol, i) => {
    const outcome = fetched[i]!;
    const contractFires = byContract.get(symbol)!;
    if (outcome.kind === 'ok') {
      barsBySymbol.set(symbol, outcome.data);
      dayBars.push(...outcome.data);
      return;
    }
    const reason = outcome.kind === 'empty' ? 'no_bars' : 'uw_error';
    const issue = {
      symbol,
      day,
      fires: contractFires.length,
      detail: outcome.kind === 'error' ? outcome.reason : 'empty',
    };
    (reason === 'no_bars' ? noBars : uwErrors).push(issue);
    for (const f of contractFires) {
      results.set(f.id, { kind: 'abstain', reason });
    }
  });

  for (const f of usable) {
    const bars = barsBySymbol.get(f.symbol);
    if (bars === undefined) continue; // abstained above (no_bars / uw_error)
    if (f.window.settledAt.getTime() > nowMs) {
      results.set(f.id, { kind: 'abstain', reason: 'in_flight' });
    } else if (!barTapeLive(f.window, dayBars)) {
      results.set(f.id, { kind: 'abstain', reason: 'tape_tail_dead' });
    } else {
      const o = outcomeFromMinuteBars(f.window, f.entryPx, bars);
      results.set(
        f.id,
        o.kind === 'locked'
          ? { kind: 'locked', values: o.values }
          : { kind: 'abstain', reason: o.reason },
      );
    }
  }
  return { results, uwCalls: symbols.length, noBars, uwErrors };
}

// ── Write ────────────────────────────────────────────────────────────────

/**
 * ONE conditional UPDATE per ≤ WRITE_CHUNK rows. Writes only rows still
 * unlocked, with every outcome column NULL and the same entry_px the outcome
 * was computed from. RETURNING names the rows actually written.
 *
 * Ids missing from RETURNING were written by someone else: the cron, a
 * concurrent run, or a retried attempt of this very statement whose first
 * commit lost its acknowledgement (withDbRetry). In every case the row holds
 * an outcome and nothing was overwritten.
 */
export async function writeOutcomes(
  rows: readonly { fire: Fire; values: BarOutcomeValues }[],
): Promise<number[]> {
  const sql = getDb();
  const written: number[] = [];
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const chunk = rows.slice(i, i + WRITE_CHUNK);
    const ids = chunk.map((r) => r.fire.id);
    const entry = chunk.map((r) => r.fire.entryPxRaw);
    const peakPx = chunk.map((r) => r.values.peakPx);
    const peakPct = chunk.map((r) => r.values.peakPct);
    const peakTime = chunk.map((r) => r.values.peakTime?.toISOString() ?? null);
    const eodPx = chunk.map((r) => r.values.eodClosePx);
    const rPeak = chunk.map((r) => r.values.realizedRPeak);
    const rEod = chunk.map((r) => r.values.realizedREod);
    const res = (await withDbRetry(
      () => sql`
        UPDATE periscope_lottery_fires AS p SET
          peak_px = u.peak_px,
          peak_pct = u.peak_pct,
          peak_time = u.peak_time,
          eod_close_px = u.eod_close_px,
          realized_r_peak = u.realized_r_peak,
          realized_r_eod = u.realized_r_eod,
          outcome_locked = TRUE
        FROM unnest(
               ${ids}::bigint[],
               ${entry}::numeric[],
               ${peakPx}::numeric[],
               ${peakPct}::numeric[],
               ${peakTime}::timestamptz[],
               ${eodPx}::numeric[],
               ${rPeak}::numeric[],
               ${rEod}::numeric[]
             ) AS u(id, entry_px, peak_px, peak_pct, peak_time, eod_close_px,
                    realized_r_peak, realized_r_eod)
        WHERE p.id = u.id
          AND p.outcome_locked = FALSE
          AND p.entry_px = u.entry_px
          AND p.peak_px IS NULL AND p.peak_pct IS NULL AND p.peak_time IS NULL
          AND p.eod_close_px IS NULL
          AND p.realized_r_peak IS NULL AND p.realized_r_eod IS NULL
        RETURNING p.id
      `,
      2,
      30_000,
    )) as { id: DbNumeric }[];
    for (const r of res) written.push(Number(r.id));
  }
  return written;
}

// ── Parity gate ──────────────────────────────────────────────────────────

/**
 * Recompute, from UW bars, the fires the cron locked inside the retention
 * window and compare every outcome column. The backfill never writes an
 * in-retention fire, so every fire sampled here was locked by the cron.
 */
async function parityGate(
  opts: BackfillOptions,
  nowMs: number,
): Promise<{ pass: boolean; uwCalls: number; uwErrors: ContractIssue[] }> {
  const sql = getDb();
  const rows = (await withDbRetry(
    () => sql`
      SELECT id, fire_type, fire_time, expiry::text AS expiry, trade_strike,
             entry_px, peak_px, peak_pct, peak_time, eod_close_px,
             realized_r_peak, realized_r_eod
        FROM periscope_lottery_fires
       WHERE outcome_locked = TRUE
         AND entry_px IS NOT NULL
         AND fire_time >= NOW() - make_interval(days => ${WS_OPTION_TRADES_RETENTION_DAYS}::int)
       ORDER BY fire_time DESC
       LIMIT ${opts.parityLimit}
    `,
    2,
    30_000,
  )) as LockedFireRow[];

  console.log(
    '\n── Parity vs the cron (fires it locked inside the retention window) ──',
  );
  const storedById = new Map<number, StoredOutcome>();
  const fires = rows.map((r) => {
    storedById.set(Number(r.id), {
      peakPx: toNumOrNull(r.peak_px),
      peakPct: toNumOrNull(r.peak_pct),
      peakTime: r.peak_time === null ? null : toDate(r.peak_time),
      eodClosePx: toNumOrNull(r.eod_close_px),
      realizedRPeak: toNumOrNull(r.realized_r_peak),
      realizedREod: toNumOrNull(r.realized_r_eod),
    });
    return toFire(r);
  });

  let uwCalls = 0;
  let compared = 0;
  let peakTimeNull = 0;
  const abstained = new Map<AbstainReason, number>();
  const mismatches: string[] = [];
  const uwErrors: ContractIssue[] = [];
  for (const [day, dayFires] of groupBy(fires, (f) => f.expiry)) {
    const ev = await evaluateDay(opts.apiKey, day, dayFires, nowMs);
    uwCalls += ev.uwCalls;
    uwErrors.push(...ev.uwErrors);
    for (const f of dayFires) {
      const res = ev.results.get(f.id)!;
      if (res.kind === 'abstain') {
        increment(abstained, res.reason);
        continue;
      }
      compared += 1;
      if (res.values.peakTime === null) peakTimeNull += 1;
      const diffs = barParityMismatches(storedById.get(f.id)!, res.values);
      if (diffs.length > 0) {
        const detail = diffs
          .map((d) => `${d.column} cron=${d.cron} bars=${d.bars}`)
          .join('; ');
        mismatches.push(`    id ${f.id} ${day} ${f.symbol}: ${detail}`);
      }
    }
  }

  const abstainTotal = [...abstained.values()].reduce((a, b) => a + b, 0);
  console.log(
    `  sampled ${fires.length} fires · ${uwCalls} contract-day UW calls`,
  );
  console.log(
    `  compared ${compared} · matched ${compared - mismatches.length} · ` +
      `mismatched ${mismatches.length}`,
  );
  console.log(
    `  peak_time: ${compared - peakTimeNull} compared at minute precision, ` +
      `${peakTimeNull} undecidable (would be written NULL)`,
  );
  console.log(
    `  abstained ${abstainTotal}${abstainTotal > 0 ? ': ' : ''}${fmtCounts(abstained)}`,
  );

  const pass = parityPasses(compared, mismatches.length);
  if (pass) {
    console.log(
      `  PARITY PASS — 100% of ${compared} compared fires match the cron`,
    );
  } else {
    const why =
      mismatches.length > 0
        ? `${mismatches.length} of ${compared} compared fires disagree with the cron`
        : `only ${compared} comparable fires (need ${PARITY_MIN_COMPARED}); ` +
          'run after the 21:50 UTC cron on a trading day';
    const bar = '!'.repeat(72);
    console.log(`\n  ${bar}\n  PARITY FAIL: ${why}\n  ${bar}`);
    for (const line of mismatches.slice(0, 50)) console.log(line);
  }
  return { pass, uwCalls, uwErrors };
}

// ── Run ──────────────────────────────────────────────────────────────────

/**
 * Returns the process exit code: 0 only when parity passed, UW never failed,
 * and the run finished before the session opened.
 */
export async function runBackfill(opts: BackfillOptions): Promise<number> {
  // UW_CONCURRENCY_CAP (3) is UW's plan-wide in-flight limit. Each fetch
  // takes one of the crons' shared Redis slots, but a bulk run during the
  // session would still crowd the live crons, so stay out of it entirely.
  if (isMarketHours()) {
    console.error(
      'Refusing to run during market hours: UW concurrency is shared with ' +
        'the live crons. Run after the close.',
    );
    return 1;
  }

  const t0 = Date.now();
  const nowMs = t0;
  const sql = getDb();
  console.log(
    `Periscope lottery outcome backfill from UW minute bars — ${
      opts.apply ? 'APPLY (writes)' : 'DRY RUN (no writes)'
    }`,
  );

  // 1. Rows this backfill will never touch, so they are named, not dropped.
  const noEntry = (await withDbRetry(
    () => sql`
      SELECT id, expiry::text AS expiry
        FROM periscope_lottery_fires
       WHERE outcome_locked = FALSE AND entry_px IS NULL
       ORDER BY expiry, id
    `,
    2,
    30_000,
  )) as { id: DbNumeric; expiry: string }[];
  console.log(
    `\n${noEntry.length} unlocked fires have no entry_px — left untouched and unlocked:`,
  );
  for (const [day, rows] of groupBy(noEntry, (r) => r.expiry)) {
    console.log(`  ${day}: ${rows.map((r) => Number(r.id)).join(', ')}`);
  }
  const partial = (await withDbRetry(
    () => sql`
      SELECT id
        FROM periscope_lottery_fires
       WHERE outcome_locked = FALSE
         AND entry_px IS NOT NULL
         AND (peak_px IS NOT NULL OR peak_pct IS NOT NULL
              OR peak_time IS NOT NULL OR eod_close_px IS NOT NULL
              OR realized_r_peak IS NOT NULL OR realized_r_eod IS NOT NULL)
       ORDER BY id
    `,
    2,
    30_000,
  )) as { id: DbNumeric }[];
  console.log(
    `${partial.length} unlocked fires already hold some outcome column — left untouched` +
      (partial.length > 0
        ? `: ${fmtIds(partial.map((r) => Number(r.id)))}`
        : ''),
  );

  // 2. Parity gate. A UW failure during parity also blocks writes: it means
  // the sample parity passed on is not the sample that was asked for.
  const parity = await parityGate(opts, nowMs);
  if (opts.apply && (!parity.pass || parity.uwErrors.length > 0)) {
    console.error(
      parity.pass
        ? `\nRefusing to write: ${parity.uwErrors.length} parity contract-day(s) ` +
            'failed at UW. Re-run once UW is healthy.'
        : '\nRefusing to write: the parity check failed.',
    );
    return 1;
  }

  // 3. Candidate days, oldest first. The cron reads only fires inside the
  // retention window; this reads only fires older than it. Both bounds use
  // NOW() at different instants, so at the boundary the cron's unguarded
  // UPDATE can still overwrite a row written here — harmless, because the
  // tape is the source of truth.
  const days = (
    (await withDbRetry(
      () => sql`
        SELECT DISTINCT expiry::text AS d
          FROM periscope_lottery_fires
         WHERE outcome_locked = FALSE
           AND entry_px IS NOT NULL
           AND fire_time < NOW() - make_interval(days => ${WS_OPTION_TRADES_RETENTION_DAYS}::int)
           AND (${opts.startDate}::date IS NULL OR expiry >= ${opts.startDate}::date)
           AND (${opts.endDate}::date IS NULL OR expiry <= ${opts.endDate}::date)
         ORDER BY d
      `,
      2,
      30_000,
    )) as { d: string }[]
  ).map((r) => r.d);

  console.log(
    `\n── Backfill: ${days.length} day(s)${
      days.length > 0 ? ` ${days[0]} → ${days.at(-1)}` : ''
    } ──`,
  );

  let candidates = 0;
  let uwCalls = 0;
  let locked = 0;
  let lockedPeakTimeNull = 0;
  let written = 0;
  const guardSkipped: number[] = [];
  const abstainIds = new Map<AbstainReason, number[]>();
  const noBars: ContractIssue[] = [];
  const uwErrors: ContractIssue[] = [];
  const samples: { fire: Fire; values: BarOutcomeValues }[] = [];
  let stoppedBefore: string | null = null;

  for (const day of days) {
    // A run started just before the open must not carry on into the session.
    if (isMarketHours()) {
      stoppedBefore = day;
      console.error(
        `\nMarket hours began: stopping before ${day}. Days already done are ` +
          'kept; re-run after the close to resume.',
      );
      break;
    }
    const rows = (await withDbRetry(
      () => sql`
        SELECT id, fire_type, fire_time, expiry::text AS expiry,
               trade_strike, entry_px
          FROM periscope_lottery_fires
         WHERE expiry = ${day}::date
           AND outcome_locked = FALSE
           AND entry_px IS NOT NULL
           AND fire_time < NOW() - make_interval(days => ${WS_OPTION_TRADES_RETENTION_DAYS}::int)
           AND peak_px IS NULL AND peak_pct IS NULL AND peak_time IS NULL
           AND eod_close_px IS NULL
           AND realized_r_peak IS NULL AND realized_r_eod IS NULL
         ORDER BY id
      `,
      2,
      30_000,
    )) as FireRow[];
    const fires = rows.map(toFire);
    const ev = await evaluateDay(opts.apiKey, day, fires, nowMs);
    candidates += fires.length;
    uwCalls += ev.uwCalls;
    noBars.push(...ev.noBars);
    uwErrors.push(...ev.uwErrors);

    const toWrite: { fire: Fire; values: BarOutcomeValues }[] = [];
    const dayAbstain = new Map<AbstainReason, number>();
    let dayPeakTimeNull = 0;
    for (const f of fires) {
      const res = ev.results.get(f.id)!;
      if (res.kind === 'locked') {
        toWrite.push({ fire: f, values: res.values });
        if (res.values.peakTime === null) dayPeakTimeNull += 1;
        if (samples.length < opts.sampleSize) {
          samples.push({ fire: f, values: res.values });
        }
      } else {
        increment(dayAbstain, res.reason);
        const list = abstainIds.get(res.reason) ?? [];
        list.push(f.id);
        abstainIds.set(res.reason, list);
      }
    }
    locked += toWrite.length;
    lockedPeakTimeNull += dayPeakTimeNull;

    // The only write in the run, and only under --apply.
    let writeNote = '';
    if (opts.apply && toWrite.length > 0) {
      const ids = await writeOutcomes(toWrite);
      written += ids.length;
      const wrote = new Set(ids);
      const skipped = toWrite.filter((r) => !wrote.has(r.fire.id));
      guardSkipped.push(...skipped.map((r) => r.fire.id));
      const skipNote =
        skipped.length > 0 ? ` (guard skipped ${skipped.length})` : '';
      writeNote = `  wrote ${ids.length}${skipNote}`;
    }
    const abstainNote =
      dayAbstain.size === 0 ? '' : ` [${fmtCounts(dayAbstain)}]`;
    console.log(
      `  ${day}  fires ${String(fires.length).padStart(4)}  contracts ` +
        `${String(ev.uwCalls).padStart(3)}  lock ${String(toWrite.length).padStart(4)}` +
        ` (peak_time NULL ${dayPeakTimeNull})  unlocked ` +
        `${fires.length - toWrite.length}${abstainNote}${writeNote}`,
    );
  }

  // 4. Sample rows.
  console.log(`\n── Sample computed rows (first ${samples.length}) ──`);
  for (const { fire: f, values: v } of samples) {
    const peakAt = v.peakTime?.toISOString() ?? 'NULL';
    console.log(
      `  id ${f.id} ${f.expiry} ${f.symbol} fire ${f.window.fireTime.toISOString()}` +
        ` entry ${fmtPx(f.entryPx)} peak ${fmtPx(v.peakPx)} @ ${peakAt}` +
        ` eod ${fmtPx(v.eodClosePx)} R_peak ${fmtR(v.realizedRPeak)}` +
        ` R_eod ${fmtR(v.realizedREod)}`,
    );
  }

  // 5. Totals.
  console.log('\n── Totals ──');
  console.log(
    `  candidate fires     ${candidates} over ${days.length} day(s), ${uwCalls} contract-days`,
  );
  console.log(
    `  ${opts.apply ? 'locked' : 'would write'}         ${locked} ` +
      `(peak_time NULL on ${lockedPeakTimeNull})`,
  );
  if (opts.apply) {
    const skipNote =
      guardSkipped.length > 0
        ? ` · guard skipped ${guardSkipped.length} (already written): ${fmtIds(guardSkipped)}`
        : '';
    console.log(`  written             ${written}${skipNote}`);
  }
  console.log(`  left unlocked       ${candidates - locked}`);
  for (const [reason, ids] of abstainIds) {
    console.log(`    ${reason} ${ids.length}: ${fmtIds(ids)}`);
  }
  console.log(`  contract-days with no bars: ${noBars.length}`);
  for (const c of noBars) {
    console.log(`    ${c.day} ${c.symbol} (${c.fires} fires)`);
  }
  // Parity-phase failures count too: they shrink the sample parity ran on.
  const allUwErrors = [...parity.uwErrors, ...uwErrors];
  console.log(
    `  contract-days with UW errors: ${allUwErrors.length} ` +
      `(${parity.uwErrors.length} parity + ${uwErrors.length} backfill)`,
  );
  for (const c of allUwErrors) {
    console.log(`    ${c.day} ${c.symbol} (${c.fires} fires): ${c.detail}`);
  }
  console.log(
    `  UW calls            ${uwCalls + parity.uwCalls} (${uwCalls} backfill + ` +
      `${parity.uwCalls} parity; withRetry retries not counted)`,
  );
  console.log(
    `  wall time           ${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );
  const runNote =
    stoppedBefore === null ? '' : ` (stopped before ${stoppedBefore})`;
  console.log(
    opts.apply
      ? `  APPLIED${runNote}.`
      : `  DRY RUN — no rows written${runNote}. Re-run with --apply to write.`,
  );
  if (allUwErrors.length > 0) {
    console.error(
      `\n${allUwErrors.length} contract-day(s) failed at UW; those fires were ` +
        'not computed (backfill fires stay unlocked). Re-run to retry them.',
    );
  }

  // Non-zero on a failed parity check (dry run included), any UW failure
  // in either phase, or a run cut short by the open: loud, not buried.
  return parity.pass && allUwErrors.length === 0 && stoppedBefore === null
    ? 0
    : 1;
}
