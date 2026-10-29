/**
 * GET /api/cron/fetch-futures-session-stats
 *
 * Records each CME session's official settlement, open interest and
 * session volume for the front two contracts of the six futures roots
 * uw-stream writes bars for. UW has no websocket channel for these, and
 * `/futures/{contract}/stats` has no date parameter (it returns only the
 * latest settled session), so history builds only by recording daily.
 *
 *   1. `GET /futures/contracts?days=5` once, then per root the top 2
 *      exact-product, non-spread contracts by volume
 *      (`api/_lib/futures-contracts.ts`, shared with
 *      backfill-futures-gaps): 12 contracts.
 *   2. `GET /futures/{contract}/stats` for each, 3 at a time (UW's
 *      concurrent-request cap), each through withRetry.
 *   3. One batched `INSERT … SELECT FROM unnest(…) ON CONFLICT
 *      (contract, settlement_date) DO UPDATE` into futures_session_stats.
 *
 * Stats body (probed 2026-10-29 03:34 UTC): `settlement`,
 * `settlement_date` and `session_volume` describe the SETTLED session;
 * `session_high`/`session_low` describe the IN-PROGRESS one, so they are
 * validated but never stored. Which session the open interest is as of is
 * unresolved, so the cron runs twice and upserts: 21:30 UTC Mon–Fri after
 * the settlement prints, then 12:30 UTC Tue–Sat once CME's open interest
 * for that session is out. `fetched_at` shows which run wrote the stored
 * values.
 *
 * Failures surface (R4). A contract whose call fails is a Sentry exception
 * tagged with the contract; a body that fails validation is a Sentry
 * warning; a root UW lists no contract for is a Sentry exception. Each
 * counts as one failed leg, so the run reports 'partial', or 'error' when
 * every leg failed. A contract with no settlement date yet is skipped, not
 * failed, and listed in the run metadata. A failed contract list or a
 * rejected write throws: the wrapper reports 'error' and returns 500.
 *
 * Worst case is 13 UW calls, each up to 3 attempts × 15 s timeout plus
 * backoff (~48 s): ~4 minutes with the stats calls 3 at a time, inside
 * the default 300 s limit. Typical runs finish in about a second.
 *
 * Schedule: 30 21 * * 1-5 and 30 12 * * 2-6 (UTC).
 *
 * Spec: docs/superpowers/specs/2026-10-28-uw-futures-orderflow-design.md
 * (Phase 5, as amended by probe 0a).
 *
 * Environment: CRON_SECRET, UW_API_KEY
 */

import { z } from 'zod';
import { getDb, withDbRetry } from '../_lib/db.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import { mapWithConcurrency, uwFetch, withRetry } from '../_lib/api-helpers.js';
import {
  withCronInstrumentation,
  deriveCronStatus,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import {
  FUTURES_ROOTS,
  fetchFuturesContracts,
  frontMonthCandidates,
  type FuturesRoot,
} from '../_lib/futures-contracts.js';

const JOB = 'fetch-futures-session-stats';

// ── Validation ──────────────────────────────────────────────

/** NUMERIC(18,8) holds at most 10 integer digits. */
const MAX_ABS_SETTLEMENT = 1e10;

/** UW decimal string ('7783.250000000'), stored as-is. CL can go negative. */
const DecimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/)
  .refine(
    (s) => Math.abs(Number(s)) < MAX_ABS_SETTLEMENT,
    'exceeds NUMERIC(18,8)',
  );

const Count = z.number().int().nonnegative();

const StatsBody = z.object({
  settlement: DecimalString.nullable(),
  settlement_date: z.iso.date().nullable(),
  open_interest: Count.nullable(),
  session_volume: Count.nullable(),
  // The in-progress session's range: read, never stored.
  session_high: z.string().nullish(),
  session_low: z.string().nullish(),
});

// ── Types ───────────────────────────────────────────────────

interface Target {
  contract: string;
  product: FuturesRoot;
}

interface StatsRow extends Target {
  settlementDate: string;
  settlement: string | null;
  openInterest: number | null;
  sessionVolume: number | null;
}

type Outcome =
  | { kind: 'row'; row: StatsRow }
  | { kind: 'no_settlement' }
  | { kind: 'malformed'; issues: string }
  | { kind: 'error'; err: unknown };

// ── Fetch ───────────────────────────────────────────────────

/** One contract's stats. Never throws: mapWithConcurrency would abort. */
async function fetchStats(apiKey: string, target: Target): Promise<Outcome> {
  try {
    // `data` is one object, not the usual array.
    const [body] = await withRetry(() =>
      uwFetch<unknown>(
        apiKey,
        `/futures/${encodeURIComponent(target.contract)}/stats`,
        (b) => [b.data],
      ),
    );
    const parsed = StatsBody.safeParse(body);
    if (!parsed.success) {
      return { kind: 'malformed', issues: z.prettifyError(parsed.error) };
    }
    const s = parsed.data;
    if (s.settlement_date === null) return { kind: 'no_settlement' };
    return {
      kind: 'row',
      row: {
        ...target,
        settlementDate: s.settlement_date,
        settlement: s.settlement,
        openInterest: s.open_interest,
        sessionVolume: s.session_volume,
      },
    };
  } catch (err) {
    return { kind: 'error', err };
  }
}

// ── DB write ────────────────────────────────────────────────

/** Rows written (inserted or updated). Throws on a rejected write. */
async function upsertStats(rows: StatsRow[]): Promise<number> {
  const sql = getDb();
  const written = (await withDbRetry(
    () => sql`
      INSERT INTO futures_session_stats (
        contract, product, settlement_date,
        settlement, open_interest, session_volume
      )
      SELECT t.contract, t.product, t.settlement_date,
             t.settlement, t.open_interest, t.session_volume
      FROM unnest(
        ${rows.map((r) => r.contract)}::text[],
        ${rows.map((r) => r.product)}::text[],
        ${rows.map((r) => r.settlementDate)}::date[],
        ${rows.map((r) => r.settlement)}::numeric[],
        ${rows.map((r) => r.openInterest)}::bigint[],
        ${rows.map((r) => r.sessionVolume)}::bigint[]
      ) AS t(
        contract, product, settlement_date,
        settlement, open_interest, session_volume
      )
      ON CONFLICT (contract, settlement_date) DO UPDATE SET
        settlement = EXCLUDED.settlement,
        open_interest = EXCLUDED.open_interest,
        session_volume = EXCLUDED.session_volume,
        fetched_at = now()
      RETURNING contract
    `,
    2,
    10_000,
  )) as unknown[];
  return written.length;
}

// ── Handler ─────────────────────────────────────────────────

export default withCronInstrumentation(
  JOB,
  async (ctx): Promise<CronResult> => {
    // A failure here fails the whole run: the wrapper reports 'error'.
    const contracts = await fetchFuturesContracts(ctx.apiKey);

    const failures: string[] = [];
    const targets: Target[] = [];
    const seen = new Set<string>();
    let rootsMissing = 0;
    for (const root of FUTURES_ROOTS) {
      const names = frontMonthCandidates(contracts, root);
      if (names.length === 0) {
        const err = new Error(
          `UW /futures/contracts lists no ${root} contract`,
        );
        rootsMissing += 1;
        failures.push(`${root}: ${err.message}`);
        ctx.logger.error({ symbol: root }, `${JOB}: ${err.message}`);
        Sentry.captureException(err, { tags: { cron: JOB, symbol: root } });
        continue;
      }
      // A repeated (contract, settlement_date) key would abort the upsert.
      for (const contract of names) {
        if (seen.has(contract)) continue;
        seen.add(contract);
        targets.push({ contract, product: root });
      }
    }

    const outcomes = await mapWithConcurrency(targets, 3, (t) =>
      fetchStats(ctx.apiKey, t),
    );

    const rows: StatsRow[] = [];
    const skippedNoSettlement: string[] = [];
    for (const [i, outcome] of outcomes.entries()) {
      const { contract } = targets[i]!;
      switch (outcome.kind) {
        case 'row':
          rows.push(outcome.row);
          break;
        case 'no_settlement':
          skippedNoSettlement.push(contract);
          break;
        case 'malformed':
          failures.push(`${contract}: malformed stats body`);
          ctx.logger.warn(
            { contract, issues: outcome.issues },
            `${JOB}: malformed UW stats body`,
          );
          metrics.increment('fetch_futures_session_stats.malformed');
          Sentry.captureMessage(`${JOB}: malformed UW stats body`, {
            level: 'warning',
            extra: { contract, issues: outcome.issues },
          });
          break;
        case 'error': {
          const { err } = outcome;
          const message = err instanceof Error ? err.message : String(err);
          failures.push(`${contract}: ${message}`);
          ctx.logger.error({ err, contract }, `${JOB}: stats fetch failed`);
          metrics.increment('fetch_futures_session_stats.contract_error');
          Sentry.captureException(err, { tags: { cron: JOB, contract } });
          break;
        }
      }
    }

    if (skippedNoSettlement.length > 0) {
      ctx.logger.warn(
        { contracts: skippedNoSettlement },
        `${JOB}: no settlement date yet, skipped`,
      );
      Sentry.captureMessage(`${JOB}: contracts with no settlement date`, {
        level: 'warning',
        extra: { contracts: skippedNoSettlement },
      });
    }

    // A rejected write throws past this point: never a 'success' run.
    const written = rows.length > 0 ? await upsertStats(rows) : 0;

    // Legs: every fetched contract plus every root with no contract.
    const status = deriveCronStatus(
      failures.length,
      targets.length + rootsMissing,
    );
    ctx.logger.info(
      { status, rows: written, skippedNoSettlement, failures },
      `${JOB} completed`,
    );

    return {
      status,
      rows: written,
      metadata: {
        contracts: targets.map((t) => t.contract),
        skippedNoSettlement,
        ...(failures.length > 0 ? { failures } : {}),
      },
    };
  },
  { marketHours: false },
);
