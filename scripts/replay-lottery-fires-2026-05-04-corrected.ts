/**
 * Production-parity replay of the lottery_finder_fires detector for
 * 2026-05-04 — CORRECTED regeneration. The original 2026-05-04 replay
 * template carried a cooldown bug that emitted ~80% duplicate-drift fires
 * (a sustained trigger re-firing every minute with a drifting
 * trigger_time_ct that ON CONFLICT could not dedup). This corrected copy
 * is cloned from scripts/replay-lottery-fires-2026-06-10.ts, which fixes
 * the bug via a run-scoped per-chain last-fire Map seeded into
 * detectChainFires's 4th arg. ws_option_trades for 2026-05-04 was pruned
 * by the cleanup cron and is reloaded from the Full Tape parquet via
 * scripts/reload-ws-option-trades-from-fulltape.py before this runs.
 *
 * Walks minute-by-minute through 13:30 UTC → 20:00 UTC (8:30 → 15:00 CT),
 * scanning the same 7-min window the cron uses, and inserts qualifying
 * fires with ON CONFLICT (option_chain_id, trigger_time_ct) DO NOTHING.
 *
 * Imports the unmodified production detector logic from
 * api/_lib/lottery-finder.ts so whatever fires here is exactly what
 * detect-lottery-fires.ts would have written had it been able to run.
 *
 * GAMMA: this replay mirrors the live detect-lottery-fires.ts gamma
 * path — the TickRow SELECT extracts gamma from raw_payload via
 * `NULLIF(raw_payload->>'gamma','')::numeric`, the per-tick build
 * carries it onto OptionTradeTick.gamma, detectChainFires averages it
 * into LotteryFire.triggerGamma, and the INSERT persists it into
 * gamma_at_trigger (migration #168). The 2026-05-20 template omitted
 * gamma entirely; it is restored here to match live.
 *
 * Usage:
 *   set -a; source .env.local; set +a
 *   npx tsx scripts/replay-lottery-fires-2026-05-04-corrected.ts            # dry-run
 *   npx tsx scripts/replay-lottery-fires-2026-05-04-corrected.ts --apply    # writes
 */

import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import {
  detectChainFires,
  enrichFires,
  type LotteryFireRecord,
  type OptionTradeTick,
} from '../api/_lib/lottery-finder.ts';

loadEnv({ path: '.env.local' });

const REPLAY_DAY_ET = '2026-05-04';
const REPLAY_START_UTC = new Date('2026-05-04T13:30:00Z');
const REPLAY_END_UTC = new Date('2026-05-04T20:00:00Z');
// --apply writes to lottery_finder_fires; default is dry-run (counts only).
const APPLY = process.argv.includes('--apply');
const STEP_MS = 60_000;
const SCAN_WINDOW_MIN = 7; // mirrors detect-lottery-fires.ts
const PER_CHAIN_MIN_PRINTS = 5;

const TICKERS_WITH_GEX_STRIKE = new Set([
  'SPX',
  'SPXW',
  'NDX',
  'NDXP',
  'SPY',
  'QQQ',
]);

type DbNumeric = string | number;
type DbNullableNumeric = DbNumeric | null;
type DbTimestamp = string | Date;
type DbSide = 'ask' | 'bid' | 'mid' | 'no_side';

interface TickRow {
  ticker: string;
  option_chain: string;
  option_type: 'C' | 'P';
  strike: DbNumeric;
  expiry: string;
  executed_at: DbTimestamp;
  price: DbNumeric;
  size: number;
  underlying_price: DbNullableNumeric;
  side: DbSide;
  implied_volatility: DbNullableNumeric;
  delta: DbNullableNumeric;
  // Gamma extracted from raw_payload JSONB at SELECT time — mirrors the
  // live detect-lottery-fires.ts read (migration #168).
  gamma: DbNullableNumeric;
  open_interest: number | null;
}

interface MacroSnapshot {
  mkt_tide_ncp: number | null;
  mkt_tide_npp: number | null;
  mkt_tide_diff: number | null;
  mkt_tide_otm_diff: number | null;
  spx_flow_diff: number | null;
  spy_etf_diff: number | null;
  qqq_etf_diff: number | null;
  zero_dte_diff: number | null;
  spx_spot_gamma_oi: number | null;
  spx_spot_gamma_vol: number | null;
  spx_spot_charm_oi: number | null;
  spx_spot_vanna_oi: number | null;
  gex_strike_call_minus_put: number | null;
  gex_strike_call_ask_minus_bid: number | null;
  gex_strike_put_ask_minus_bid: number | null;
  gex_strike_actual_strike: number | null;
}

const EMPTY_MACRO: MacroSnapshot = {
  mkt_tide_ncp: null,
  mkt_tide_npp: null,
  mkt_tide_diff: null,
  mkt_tide_otm_diff: null,
  spx_flow_diff: null,
  spy_etf_diff: null,
  qqq_etf_diff: null,
  zero_dte_diff: null,
  spx_spot_gamma_oi: null,
  spx_spot_gamma_vol: null,
  spx_spot_charm_oi: null,
  spx_spot_vanna_oi: null,
  gex_strike_call_minus_put: null,
  gex_strike_call_ask_minus_bid: null,
  gex_strike_put_ask_minus_bid: null,
  gex_strike_actual_strike: null,
};

function daysBetween(fromYmd: string, toYmd: string): number {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

const DATABASE_URL =
  process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}
const db = neon(DATABASE_URL);

// Macro snapshot cache.
// Key = `${minuteBucketIso}|${ticker_with_strike_lookup ?? '_'}|${strike ?? '_'}`.
// Flow + spot are minute-level (they don't depend on ticker/strike).
// Strike lookup is per (ticker, strike) so we cache that arm separately.
const macroCache = new Map<string, MacroSnapshot>();

// ============================================================
// Cross-tick cooldown seed. The live cron (detect-lottery-fires.ts
// lines 370-401) reads each chain's last fire time from the DB at the
// start of every 1-min invocation and passes it as the 4th arg to
// detectChainFires so the detector's in-memory cooldown survives the
// invocation boundary. This replay processes every minute inside ONE
// process and (in dry-run) never writes to the DB, so there is nothing
// for a per-tick DB read to pick up. Instead we keep this run-scoped
// Map<optionChainId, lastFireMs> alive ACROSS ticks and update it from
// each tick's emitted fires — an in-memory stand-in for the live cron's
// DB-read seed. Without it the detector's cooldown resets every tick and
// a single sustained trigger emits a duplicate fire per minute with a
// drifting trigger_time_ct that ON CONFLICT (option_chain_id,
// trigger_time_ct) cannot dedup → ~10× over-generation.
const priorByChain = new Map<string, number>();

function macroCacheKey(rec: LotteryFireRecord, minuteIso: string): string {
  const wantStrike = TICKERS_WITH_GEX_STRIKE.has(rec.underlyingSymbol);
  const strikeKey = wantStrike ? `${rec.underlyingSymbol}|${rec.strike}` : '_';
  return `${minuteIso}|${strikeKey}`;
}

async function fetchMacroSnapshot(
  rec: LotteryFireRecord,
  asOf: Date,
): Promise<MacroSnapshot> {
  // Round asOf down to the minute. flow_data + spot_exposures are
  // minute-cadence, and the cron's ±30-min lookup is identical for any
  // timestamp inside the same minute → cache by minute bucket.
  const bucket = new Date(Math.floor(asOf.getTime() / 60_000) * 60_000);
  const bucketIso = bucket.toISOString();
  const cacheKey = macroCacheKey(rec, bucketIso);
  const hit = macroCache.get(cacheKey);
  if (hit) return hit;
  const flowRows = (await db`
    SELECT source, ncp, npp
    FROM flow_data
    WHERE timestamp <= ${asOf.toISOString()}
      AND timestamp >= ${asOf.toISOString()}::timestamptz - INTERVAL '30 minutes'
      AND source IN (
        'market_tide', 'market_tide_otm', 'spx_flow',
        'spy_etf_tide', 'qqq_etf_tide', 'zero_dte_greek_flow'
      )
    ORDER BY timestamp DESC
    LIMIT 200
  `) as {
    source: string;
    ncp: DbNumeric;
    npp: DbNumeric;
  }[];

  const spotRows = (await db`
    SELECT gamma_oi, gamma_vol, charm_oi, vanna_oi
    FROM spot_exposures
    WHERE ticker = 'SPX'
      AND timestamp <= ${asOf.toISOString()}
      AND timestamp >= ${asOf.toISOString()}::timestamptz - INTERVAL '30 minutes'
    ORDER BY timestamp DESC
    LIMIT 1
  `) as {
    gamma_oi: DbNullableNumeric;
    gamma_vol: DbNullableNumeric;
    charm_oi: DbNullableNumeric;
    vanna_oi: DbNullableNumeric;
  }[];

  const wantStrike = TICKERS_WITH_GEX_STRIKE.has(rec.underlyingSymbol);
  const strikeRows = wantStrike
    ? ((await db`
        SELECT
          strike,
          (call_gamma_oi - put_gamma_oi) AS call_minus_put,
          (call_gamma_ask - call_gamma_bid) AS call_ask_minus_bid,
          (put_gamma_ask - put_gamma_bid) AS put_ask_minus_bid
        FROM strike_exposures
        WHERE ticker = ${rec.underlyingSymbol}
          AND timestamp <= ${asOf.toISOString()}
          AND timestamp >= ${asOf.toISOString()}::timestamptz - INTERVAL '30 minutes'
          AND ABS(strike - ${rec.strike}::numeric) / NULLIF(${rec.strike}::numeric, 0) <= 0.01
        ORDER BY timestamp DESC, ABS(strike - ${rec.strike}::numeric) ASC
        LIMIT 1
      `) as {
        strike: DbNumeric;
        call_minus_put: DbNullableNumeric;
        call_ask_minus_bid: DbNullableNumeric;
        put_ask_minus_bid: DbNullableNumeric;
      }[])
    : [];

  const latestBySource = new Map<string, { ncp: number; npp: number }>();
  for (const r of flowRows) {
    if (latestBySource.has(r.source)) continue;
    latestBySource.set(r.source, {
      ncp: Number(r.ncp),
      npp: Number(r.npp),
    });
  }
  const tide = latestBySource.get('market_tide');
  const otm = latestBySource.get('market_tide_otm');
  const spxF = latestBySource.get('spx_flow');
  const spyE = latestBySource.get('spy_etf_tide');
  const qqqE = latestBySource.get('qqq_etf_tide');
  const zd = latestBySource.get('zero_dte_greek_flow');
  const spot = spotRows[0];
  const strikeRow = strikeRows[0];

  const snap: MacroSnapshot = {
    ...EMPTY_MACRO,
    mkt_tide_ncp: tide?.ncp ?? null,
    mkt_tide_npp: tide?.npp ?? null,
    mkt_tide_diff: tide ? tide.ncp - tide.npp : null,
    // For source='market_tide_otm', the OTM data lives in the regular
    // ncp/npp columns — otm_ncp/otm_npp are vestigial and NULL for that
    // source. Matches the corrected read in api/cron/detect-lottery-fires.ts.
    mkt_tide_otm_diff: otm ? otm.ncp - otm.npp : null,
    spx_flow_diff: spxF ? spxF.ncp - spxF.npp : null,
    spy_etf_diff: spyE ? spyE.ncp - spyE.npp : null,
    qqq_etf_diff: qqqE ? qqqE.ncp - qqqE.npp : null,
    zero_dte_diff: zd ? zd.ncp - zd.npp : null,
    spx_spot_gamma_oi:
      spot && spot.gamma_oi != null ? Number(spot.gamma_oi) : null,
    spx_spot_gamma_vol:
      spot && spot.gamma_vol != null ? Number(spot.gamma_vol) : null,
    spx_spot_charm_oi:
      spot && spot.charm_oi != null ? Number(spot.charm_oi) : null,
    spx_spot_vanna_oi:
      spot && spot.vanna_oi != null ? Number(spot.vanna_oi) : null,
    gex_strike_call_minus_put:
      strikeRow && strikeRow.call_minus_put != null
        ? Number(strikeRow.call_minus_put)
        : null,
    gex_strike_call_ask_minus_bid:
      strikeRow && strikeRow.call_ask_minus_bid != null
        ? Number(strikeRow.call_ask_minus_bid)
        : null,
    gex_strike_put_ask_minus_bid:
      strikeRow && strikeRow.put_ask_minus_bid != null
        ? Number(strikeRow.put_ask_minus_bid)
        : null,
    gex_strike_actual_strike: strikeRow ? Number(strikeRow.strike) : null,
  };
  macroCache.set(cacheKey, snap);
  return snap;
}

async function processOneCronTick(simulatedNow: Date): Promise<{
  scanned: number;
  inserted: number;
  totalFires: number;
}> {
  const windowStart = new Date(
    simulatedNow.getTime() - SCAN_WINDOW_MIN * 60_000,
  );
  const rows = (await db`
    SELECT
      ticker, option_chain, option_type, strike, expiry::text AS expiry,
      executed_at, price, size, underlying_price, side,
      implied_volatility, delta,
      NULLIF(raw_payload->>'gamma', '')::numeric AS gamma,
      open_interest
    FROM ws_option_trades
    WHERE executed_at >  ${windowStart.toISOString()}
      AND executed_at <= ${simulatedNow.toISOString()}
      AND canceled = FALSE
      AND price > 0
    ORDER BY option_chain, executed_at ASC
  `) as TickRow[];

  if (rows.length === 0) return { scanned: 0, inserted: 0, totalFires: 0 };

  interface ChainGroup {
    ticker: string;
    optionChain: string;
    optionType: 'C' | 'P';
    strike: number;
    expiry: string;
    ticks: OptionTradeTick[];
    oi: number;
  }
  const groups = new Map<string, ChainGroup>();
  for (const r of rows) {
    let g = groups.get(r.option_chain);
    if (!g) {
      g = {
        ticker: r.ticker,
        optionChain: r.option_chain,
        optionType: r.option_type,
        strike: Number(r.strike),
        expiry: r.expiry,
        ticks: [],
        oi: 0,
      };
      groups.set(r.option_chain, g);
    }
    g.ticks.push({
      executedAt: new Date(r.executed_at),
      optionChain: r.option_chain,
      optionType: r.option_type,
      strike: Number(r.strike),
      expiry: new Date(`${r.expiry}T00:00:00Z`),
      price: Number(r.price),
      size: r.size,
      underlyingPrice:
        r.underlying_price != null ? Number(r.underlying_price) : null,
      side: r.side,
      impliedVolatility:
        r.implied_volatility != null ? Number(r.implied_volatility) : null,
      delta: r.delta != null ? Number(r.delta) : null,
      gamma: r.gamma != null ? Number(r.gamma) : null,
      openInterest: r.open_interest,
    });
    if (r.open_interest != null && r.open_interest > g.oi) {
      g.oi = r.open_interest;
    }
  }

  let totalFires = 0;
  let inserted = 0;

  for (const g of groups.values()) {
    if (g.ticks.length < PER_CHAIN_MIN_PRINTS) continue;
    if (g.oi <= 0) continue;
    const dte = daysBetween(REPLAY_DAY_ET, g.expiry);

    // Seed the detector's cooldown from this chain's last emitted fire
    // (prior ticks of THIS run), mirroring the live cron's DB-read seed
    // at detect-lottery-fires.ts:540.
    const priorMs = priorByChain.get(g.optionChain) ?? null;
    const fires = detectChainFires(g.ticks, g.oi, dte, priorMs);
    if (fires.length === 0) continue;
    totalFires += fires.length;

    // Advance the cross-tick cooldown seed from this chain's emitted
    // fires (the detector already cooldown-filters its output, so every
    // returned fire is a real fire). Update in BOTH dry-run and apply so
    // the dry-run count is cron-faithful. Live updates its seed via the
    // next invocation's DB read of these same fires.
    let maxTriggerMs = priorMs ?? Number.NEGATIVE_INFINITY;
    for (const f of fires) {
      const ms = f.triggerTimeCt.getTime();
      if (ms > maxTriggerMs) maxTriggerMs = ms;
    }
    if (Number.isFinite(maxTriggerMs)) {
      priorByChain.set(g.optionChain, maxTriggerMs);
    }

    const records = enrichFires(fires, {
      date: REPLAY_DAY_ET,
      optionChainId: g.optionChain,
      underlyingSymbol: g.ticker,
      optionType: g.optionType,
      strike: g.strike,
      expiry: g.expiry,
      dte,
    });
    const inUniverse = records.filter((r) => r.mode !== 'OUT_OF_UNIVERSE');
    const firstTick = g.ticks[0]!;
    // Run all per-fire macro fetches + inserts in parallel within the
    // chain. Macro is cached by minute-bucket so the first call hits
    // the DB and subsequent calls return cached. Inserts are
    // independent rows; ON CONFLICT DO NOTHING is concurrency-safe.
    const insertResults = await Promise.all(
      inUniverse.map(async (rec) => {
        let macro: MacroSnapshot;
        try {
          macro = await fetchMacroSnapshot(rec, firstTick.executedAt);
        } catch {
          macro = EMPTY_MACRO;
        }
        if (!APPLY) {
          // Dry-run: pretend the insert succeeded (no row collision).
          return [{ id: 0 }];
        }
        return (await db`
        INSERT INTO lottery_finder_fires (
          date, trigger_time_ct, entry_time_ct, option_chain_id,
          underlying_symbol, option_type, strike, expiry, dte,
          trigger_vol_to_oi_window, trigger_vol_to_oi_cum,
          trigger_iv, trigger_delta, trigger_ask_pct,
          trigger_window_size, trigger_window_prints,
          entry_price, open_interest, spot_at_first,
          alert_seq, minutes_since_prev_fire,
          flow_quad, tod, mode,
          reload_tagged, cheap_call_pm_tagged,
          burst_ratio_vs_prev, entry_drop_pct_vs_prev,
          mkt_tide_ncp, mkt_tide_npp, mkt_tide_diff, mkt_tide_otm_diff,
          spx_flow_diff, spy_etf_diff, qqq_etf_diff, zero_dte_diff,
          spx_spot_gamma_oi, spx_spot_gamma_vol, spx_spot_charm_oi, spx_spot_vanna_oi,
          gex_strike_call_minus_put, gex_strike_call_ask_minus_bid,
          gex_strike_put_ask_minus_bid, gex_strike_actual_strike,
          gamma_at_trigger
        ) VALUES (
          ${rec.date}::date, ${rec.triggerTimeCt.toISOString()}, ${rec.entryTimeCt.toISOString()},
          ${rec.optionChainId}, ${rec.underlyingSymbol}, ${rec.optionType},
          ${rec.strike}, ${rec.expiry}::date, ${rec.dte},
          ${rec.triggerVolToOiWindow}, ${rec.triggerVolToOiCum},
          ${rec.triggerIv}, ${rec.triggerDelta}, ${rec.triggerAskPct},
          ${rec.triggerWindowSize}, ${rec.triggerWindowPrints},
          ${rec.entryPrice}, ${rec.openInterest}, ${rec.spotAtFirst},
          ${rec.alertSeq}, ${rec.minutesSincePrevFire},
          ${rec.flowQuad}, ${rec.tod}, ${rec.mode},
          ${rec.reloadTagged}, ${rec.cheapCallPmTagged},
          ${rec.burstRatioVsPrev}, ${rec.entryDropPctVsPrev},
          ${macro.mkt_tide_ncp}, ${macro.mkt_tide_npp}, ${macro.mkt_tide_diff}, ${macro.mkt_tide_otm_diff},
          ${macro.spx_flow_diff}, ${macro.spy_etf_diff}, ${macro.qqq_etf_diff}, ${macro.zero_dte_diff},
          ${macro.spx_spot_gamma_oi}, ${macro.spx_spot_gamma_vol}, ${macro.spx_spot_charm_oi}, ${macro.spx_spot_vanna_oi},
          ${macro.gex_strike_call_minus_put}, ${macro.gex_strike_call_ask_minus_bid},
          ${macro.gex_strike_put_ask_minus_bid}, ${macro.gex_strike_actual_strike},
          ${rec.triggerGamma}
        )
        ON CONFLICT (option_chain_id, trigger_time_ct) DO NOTHING
        RETURNING id
      `) as { id: number }[];
      }),
    );
    inserted += insertResults.filter((r) => r.length > 0).length;
  }

  return { scanned: rows.length, inserted, totalFires };
}

async function main(): Promise<void> {
  const t0 = Date.now();
  let totalScanned = 0;
  let totalInserted = 0;
  let totalFiresSeen = 0;

  const totalMinutes =
    (REPLAY_END_UTC.getTime() - REPLAY_START_UTC.getTime()) / STEP_MS + 1;
  console.log(
    `replay window: ${REPLAY_START_UTC.toISOString()} → ${REPLAY_END_UTC.toISOString()} ` +
      `(${totalMinutes} cron ticks, scan window ${SCAN_WINDOW_MIN} min) ` +
      `mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`,
  );

  let i = 0;
  for (
    let t = REPLAY_START_UTC.getTime();
    t <= REPLAY_END_UTC.getTime();
    t += STEP_MS
  ) {
    i += 1;
    const simulatedNow = new Date(t);
    const { scanned, inserted, totalFires } =
      await processOneCronTick(simulatedNow);
    totalScanned += scanned;
    totalInserted += inserted;
    totalFiresSeen += totalFires;

    if (i % 30 === 0 || inserted > 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(
        `  [${i}/${totalMinutes}] ${simulatedNow.toISOString()} ` +
          `scanned=${scanned} fires=${totalFires} inserted=${inserted} ` +
          `cum_inserted=${totalInserted} elapsed=${elapsed}s`,
      );
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `\nDONE: ticks=${i} scanned=${totalScanned} fires_seen=${totalFiresSeen} ` +
      `inserted=${totalInserted} in ${elapsed}s`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
