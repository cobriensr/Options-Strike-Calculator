/**
 * Preview script: replay the 2026-04-23 flush fixture and print every alert
 * the detector would have fired. Mirrors the E2E regression test's replay
 * logic but prints a human-readable table instead of asserting.
 *
 * Usage: npx tsx scripts/preview-flush-alerts.ts
 */

import {
  detectAnomalies,
  classifyFlowPhase,
  strikeKey,
  type StrikeSample,
  type AnomalyFlag,
} from '../api/_lib/iv-anomaly.ts';
import { Z_WINDOW_SIZE } from '../api/_lib/constants.ts';
import type { ContextSnapshot } from '../api/_lib/anomaly-context.ts';
import {
  buildFixture,
  type Fixture,
  type ContextStub,
} from '../api/__tests__/fixtures/build-2026-04-23-flush.ts';

function makeContext(stub: Partial<ContextStub> | undefined): ContextSnapshot {
  return {
    spot_delta_5m: null,
    spot_delta_15m: stub?.spot_delta_15m ?? null,
    spot_delta_60m: null,
    vwap_distance: null,
    volume_percentile: null,
    spx_delta_15m: null,
    spy_delta_15m: stub?.spy_delta_15m ?? null,
    qqq_delta_15m: stub?.qqq_delta_15m ?? null,
    iwm_delta_15m: null,
    es_delta_15m: null,
    nq_delta_15m: null,
    ym_delta_15m: null,
    rty_delta_15m: null,
    nq_ofi_1h: null,
    vix_level: stub?.vix_level ?? null,
    vix_delta_5m: null,
    vix_delta_15m: stub?.vix_delta_15m ?? null,
    vix_term_1d: null,
    vix_term_9d: null,
    vix_30d_spot: null,
    dxy_delta_15m: null,
    tlt_delta_15m: null,
    gld_delta_15m: null,
    uso_delta_15m: null,
    recent_flow_alerts: [],
    spx_recent_dark_prints: [],
    econ_release_t_minus: null,
    econ_release_t_plus: null,
    econ_release_name: null,
    institutional_program_latest: null,
    net_flow_5m: null,
    nope_current: null,
    put_premium_0dte_pctile: null,
    zero_gamma_level: null,
    zero_gamma_distance_pct: null,
  };
}

interface CollectedFlag extends AnomalyFlag {
  flow_phase: 'early' | 'mid' | 'reactive';
}

// Keep the fixture scope narrow (SPY/QQQ/SPX only) even though
// STRIKE_IV_TICKERS now includes IWM/TLT/XLF/XLE/XLK — the 2026-04-23
// flush fixture does not include synthetic data for those tickers, so
// iterating them here would just produce empty rows for every minute.
// When the fixture grows to include ETF baselines (e.g. via Option A in
// the 2026-04-24 expansion spec), revisit to widen this list or re-use
// `Object.keys(fixture.strikeSnapshots[anyTs])` directly.
const TICKERS = ['SPY', 'QQQ', 'SPX'] as const;

function replay(fixture: Fixture): CollectedFlag[] {
  const timestamps = Object.keys(fixture.strikeSnapshots).sort();
  const collected: CollectedFlag[] = [];
  const spotByTickerTs = new Map<string, number>();
  for (const ticker of TICKERS) {
    for (const row of fixture.spots[ticker] ?? []) {
      spotByTickerTs.set(`${ticker}:${row.ts}`, row.value);
    }
  }
  for (let i = 0; i < timestamps.length; i += 1) {
    const ts = timestamps[i]!;
    const minuteBucket = fixture.strikeSnapshots[ts];
    if (!minuteBucket) continue;
    for (const ticker of TICKERS) {
      const rows = minuteBucket[ticker];
      if (!rows || rows.length === 0) continue;
      const latest: StrikeSample[] = rows.map((r) => ({
        ticker: r.ticker,
        strike: r.strike,
        side: r.side,
        expiry: r.expiry,
        iv_mid: r.iv_mid,
        iv_bid: r.iv_bid,
        iv_ask: r.iv_ask,
        ts: r.ts,
      }));
      const historyByStrike = new Map<string, StrikeSample[]>();
      const startIdx = Math.max(0, i - Z_WINDOW_SIZE);
      for (let j = i - 1; j >= startIdx; j -= 1) {
        const pastTs = timestamps[j]!;
        const pastRows = fixture.strikeSnapshots[pastTs]?.[ticker];
        if (!pastRows) continue;
        for (const r of pastRows) {
          const key = strikeKey(r.ticker, r.strike, r.side, r.expiry);
          const sample: StrikeSample = {
            ticker: r.ticker,
            strike: r.strike,
            side: r.side,
            expiry: r.expiry,
            iv_mid: r.iv_mid,
            iv_bid: r.iv_bid,
            iv_ask: r.iv_ask,
            ts: r.ts,
          };
          const bucket = historyByStrike.get(key);
          if (bucket) bucket.push(sample);
          else historyByStrike.set(key, [sample]);
        }
      }
      const spot = spotByTickerTs.get(`${ticker}:${ts}`);
      if (spot == null) continue;
      const flags = detectAnomalies(latest, historyByStrike, spot);
      if (flags.length === 0) continue;
      const context = makeContext(fixture.contextAtAnomalyPoints[ts]);
      for (const flag of flags) {
        const flowPhase = classifyFlowPhase(flag, context);
        collected.push({ ...flag, flow_phase: flowPhase });
      }
    }
  }
  return collected;
}

function toCt(iso: string): string {
  const d = new Date(iso);
  const h = d.getUTCHours() - 5; // CT = UTC-5 (EST) for today's date (April pre-DST-end)
  const m = d.getUTCMinutes();
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function fmt(n: number | null, digits = 2): string {
  if (n == null) return '  -  ';
  return n.toFixed(digits).padStart(6);
}

const fixture = buildFixture();
const alerts = replay(fixture);

console.log('');
console.log(
  '  2026-04-23 flush — replayed against shipped detector (fixture → detectAnomalies → classifyFlowPhase)',
);
console.log(
  `  ${alerts.length} total alerts collected across ${Object.keys(fixture.strikeSnapshots).length} minute-buckets`,
);

// Signal quality: abs(skew_delta) >= 1.0 vol pts (= 0.01 fractional) filters
// out the first-60-min Z-score warmup noise while keeping every alert where
// the TARGET strike is genuinely diverging from its neighbors.
const SIGNAL_MIN = 0.01; // 1.0 vol pts fractional
const signalAlerts = alerts.filter(
  (f) => f.skew_delta != null && Math.abs(f.skew_delta) >= SIGNAL_MIN,
);

console.log(
  `  ${signalAlerts.length} high-signal alerts (|skew_delta| ≥ ${(SIGNAL_MIN * 100).toFixed(1)} vol pts)\n`,
);

console.log(
  '  HIGH-SIGNAL ALERTS (where the target strike actually diverges):',
);
console.log('');
const header =
  ' CT    | Ticker Strike Side |  skew_Δ    z     ask-mid | flag_reasons                        | phase   ';
const sep =
  '-------+---------------------+--------------------------+-------------------------------------+---------';
console.log(header);
console.log(sep);

for (const f of signalAlerts) {
  const reasons = f.flag_reasons.join(', ').padEnd(35);
  const phase = (f.flow_phase || '-').padEnd(7);
  const tkr = `${f.ticker} ${String(f.strike).padStart(5)} ${(f.side[0] ?? '?').toUpperCase()}   `;
  // skew_delta is fractional (0.02 = 2 vol pts); display in vol pts
  const skewVp =
    f.skew_delta == null
      ? '  -  '
      : (f.skew_delta * 100).toFixed(2).padStart(6);
  const askMidVp =
    f.ask_mid_div == null
      ? '  -  '
      : (f.ask_mid_div * 100).toFixed(2).padStart(6);
  console.log(
    ` ${toCt(f.ts)} | ${tkr} | ${skewVp}vp  ${fmt(f.z_score)}   ${askMidVp}vp | ${reasons} | ${phase}`,
  );
}

// Match expected alerts against collected
console.log('');
console.log('  EXPECTED ALERTS vs ACTUAL (from fixture):');
console.log('');
for (const e of fixture.expectedAlerts) {
  const targetMs = Date.parse(e.utc_ts);
  const toleranceMs = 2 * 60_000;
  const candidates = signalAlerts.filter(
    (f) =>
      f.ticker === e.ticker &&
      f.strike === e.strike &&
      f.side === e.side &&
      Math.abs(Date.parse(f.ts) - targetMs) <= toleranceMs,
  );
  // Pick the one with most matching reasons, tiebreak by lag
  let best: CollectedFlag | null = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    const coverage = e.required_flag_reasons.filter((r) =>
      c.flag_reasons.includes(r),
    ).length;
    const lag = Math.abs(Date.parse(c.ts) - targetMs);
    const score = coverage * 1e9 - lag;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  const label = `  ${e.ct_time} ${e.ticker} ${e.strike}${(e.side[0] ?? '?').toUpperCase()}`;
  if (!best) {
    console.log(`${label.padEnd(20)} ❌ NO MATCH within ±2min`);
  } else {
    const missing = e.required_flag_reasons.filter(
      (r) => !best!.flag_reasons.includes(r),
    );
    const ok =
      missing.length === 0 &&
      !e.expected_flow_phase_not.includes(best.flow_phase);
    const skewVp =
      best.skew_delta == null ? '-' : (best.skew_delta * 100).toFixed(2);
    const z = best.z_score == null ? '-' : best.z_score.toFixed(2);
    console.log(
      `${label.padEnd(20)} ${ok ? '✅' : '⚠️ '} at ${toCt(best.ts)}  skew=${skewVp}vp  z=${z}  phase=${best.flow_phase}  reasons=[${best.flag_reasons.join(',')}]`,
    );
  }
}
console.log('');
