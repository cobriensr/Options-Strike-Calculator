/**
 * POST /api/iv-anomalies-cross-asset
 *
 * Bulk endpoint that returns cross-asset confluence context per active
 * anomaly key. Drives the Phase F pills in `AnomalyRow`:
 *   - regime: chop / mild|strong|extreme x up|down
 *   - tape alignment: NQ/ES/RTY/SPX direction over last 15min vs alert side
 *   - DP cluster: dark-pool premium concentration at the alert strike (SPXW only)
 *   - GEX zone: nearest top-3 abs_gex strike position vs spot (SPX-family only)
 *   - VIX direction: 30-min change in VIX
 *
 * Strictly read-only / advisory. The pills are visual cues; no logic
 * elsewhere depends on this endpoint's output.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from './_lib/db.js';
import { Sentry } from './_lib/sentry.js';
import logger from './_lib/logger.js';
import {
  checkBot,
  rejectIfNotOwner,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { ivAnomaliesCrossAssetBodySchema } from './_lib/validation.js';
import {
  REGIME_THRESHOLDS,
  TAPE_WINDOW_MIN,
  VIX_WINDOW_MIN,
  DP_BUCKETS,
  DP_AT_STRIKE_BAND_PTS,
} from './_lib/constants.js';

export type AnomalyRegime =
  | 'chop'
  | 'mild_trend_up'
  | 'mild_trend_down'
  | 'strong_trend_up'
  | 'strong_trend_down'
  | 'extreme_up'
  | 'extreme_down'
  | 'unknown';

export type TapeAlignment = 'aligned' | 'contradicted' | 'neutral' | 'missing';
export type DPCluster = 'none' | 'small' | 'medium' | 'large' | 'na';
export type GEXZone = 'above_spot' | 'below_spot' | 'at_spot' | 'na';
export type VIXDirection = 'rising' | 'flat' | 'falling' | 'unknown';

export interface AnomalyCrossAssetContext {
  regime: AnomalyRegime;
  tapeAlignment: TapeAlignment;
  dpCluster: DPCluster;
  gexZone: GEXZone;
  vixDirection: VIXDirection;
}

export interface IVAnomaliesCrossAssetResponse {
  contexts: Record<string, AnomalyCrossAssetContext>;
}

// Regime thresholds, tape/VIX windows, and DP bucket cutoffs live in
// api/_lib/constants.ts so the ML scripts that compute these for backfill
// and this live endpoint use identical values.
const SPX_FAMILY = new Set(['SPXW', 'SPY', 'QQQ', 'NDXP', 'IWM']);
const DP_TICKERS = new Set(['SPXW']);

function compoundKey(
  ticker: string,
  strike: number,
  side: string,
  expiry: string,
): string {
  return `${ticker}:${strike}:${side}:${expiry}`;
}

function regimeLabel(pct: number): AnomalyRegime {
  if (!Number.isFinite(pct)) return 'unknown';
  const a = Math.abs(pct);
  if (a < REGIME_THRESHOLDS.chop) return 'chop';
  const dir = pct > 0 ? 'up' : 'down';
  if (a < REGIME_THRESHOLDS.mild) return `mild_trend_${dir}` as AnomalyRegime;
  if (a < REGIME_THRESHOLDS.strong)
    return `strong_trend_${dir}` as AnomalyRegime;
  return `extreme_${dir}` as AnomalyRegime;
}

function dpBucket(premium: number): DPCluster {
  if (!Number.isFinite(premium) || premium <= 0) return 'none';
  if (premium < DP_BUCKETS.small) return 'small';
  if (premium < DP_BUCKETS.medium) return 'medium';
  return 'large';
}

function ymd(iso: string | Date): string {
  if (iso instanceof Date) return iso.toISOString().slice(0, 10);
  return iso.slice(0, 10);
}

function num(v: string | number | null | undefined): number {
  if (v == null) return Number.NaN;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
}

function isoTs(v: string | Date | null | undefined): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Resolve the UTC offset (in minutes, as a positive number) that
 * America/Chicago has on the given calendar date. Handles DST
 * transitions correctly: April–November returns 300 (CDT, UTC-5),
 * November–March returns 360 (CST, UTC-6).
 */
function chicagoOffsetMinutes(ymdDate: string): number {
  // Probe at noon UTC on that date — enough buffer to land on the
  // correct calendar day in Chicago regardless of DST.
  const probe = new Date(`${ymdDate}T12:00:00Z`);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    timeZoneName: 'shortOffset',
  });
  const parts = fmt.formatToParts(probe);
  const tz = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-6';
  const m = /GMT([+-]\d+)/.exec(tz);
  if (!m || !m[1]) return 360; // Fall back to CST if Intl returns something weird
  const hours = Number.parseInt(m[1], 10);
  return -hours * 60;
}

function parseEntryTimeUtc(ymdDate: string, entryTime: string): number | null {
  // Strip optional " CT" suffix, then match a strict HH:MM AM|PM shape.
  // Anchored regex with no nested quantifiers — not catastrophic-backtrack-prone.
  const cleaned = entryTime.replace(/ CT$/i, '').trim();
  const m = /^(\d\d?):(\d\d) (AM|PM)$/i.exec(cleaned);
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  let hh = Number.parseInt(m[1], 10);
  const mm = Number.parseInt(m[2], 10);
  const ampm = m[3].toUpperCase();
  if (ampm === 'PM' && hh !== 12) hh += 12;
  if (ampm === 'AM' && hh === 12) hh = 0;
  const offsetMin = chicagoOffsetMinutes(ymdDate);
  const local = new Date(`${ymdDate}T00:00:00Z`);
  local.setUTCHours(hh, mm + offsetMin, 0, 0);
  return local.getTime();
}

function pickClosestEarlier(
  map: Map<number, number>,
  targetMs: number,
): number | null {
  let best: { key: number; val: number } | null = null;
  for (const [k, v] of map) {
    if (k <= targetMs && (best == null || k > best.key))
      best = { key: k, val: v };
  }
  return best?.val ?? null;
}

interface SpotPair {
  ticker: string;
  date: string;
  firstSpot: number;
  lastSpot: number;
}
interface FuturesBar {
  symbol: string;
  ts: string | Date;
  close: string | number;
}
interface SpxBar {
  ts: string | Date;
  close: string | number;
}
interface DPLevel {
  date: string | Date;
  spx_approx: string | number;
  total_premium: string | number;
}
interface GEXStrikeRow {
  date: string | Date;
  expiry: string | Date;
  strike: string | number;
  abs_gex: string | number;
}
interface VIXSnap {
  date: string | Date;
  entry_time: string;
  vix: string | number;
}
// Raw-row shape from the bulk strike_iv_snapshots query that drives
// `spotPairs`. We pluck `first_spot` / `last_spot` off it directly via
// `num()` — no need to spell the whole shape out as a TS interface
// since each query result is read once and discarded.

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTag('endpoint', '/api/iv-anomalies-cross-asset');

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'POST only' });
    }
    const botCheck = await checkBot(req);
    if (botCheck.isBot) return res.status(403).json({ error: 'Access denied' });
    if (rejectIfNotOwner(req, res)) return;

    const parseResult = ivAnomaliesCrossAssetBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      return res
        .status(400)
        .json({ error: 'Invalid body', issues: parseResult.error.issues });
    }
    const { keys } = parseResult.data;

    try {
      const sql = getDb();
      const tickerDays = new Map<string, { ticker: string; date: string }>();
      const expirySet = new Set<string>();
      for (const k of keys) {
        const date = ymd(k.alertTs);
        tickerDays.set(`${k.ticker}|${date}`, { ticker: k.ticker, date });
        expirySet.add(k.expiry);
      }
      const tickers = [
        ...new Set([...tickerDays.values()].map((td) => td.ticker)),
      ];
      const dates = [...new Set([...tickerDays.values()].map((td) => td.date))];

      const spotPairs = (await sql`
        SELECT ticker,
               TO_CHAR((ts AT TIME ZONE 'America/Chicago')::date, 'YYYY-MM-DD') AS date,
               (ARRAY_AGG(spot ORDER BY ts ASC))[1] AS first_spot,
               (ARRAY_AGG(spot ORDER BY ts DESC))[1] AS last_spot
        FROM strike_iv_snapshots
        WHERE ticker = ANY(${tickers})
          AND TO_CHAR((ts AT TIME ZONE 'America/Chicago')::date, 'YYYY-MM-DD') = ANY(${dates})
        GROUP BY ticker, (ts AT TIME ZONE 'America/Chicago')::date
      `) as Array<{
        ticker: string;
        date: string;
        first_spot: string | number | null;
        last_spot: string | number | null;
      }>;
      const spotPairMap = new Map<string, SpotPair>();
      for (const r of spotPairs) {
        spotPairMap.set(`${r.ticker}|${r.date}`, {
          ticker: r.ticker,
          date: r.date,
          firstSpot: num(r.first_spot),
          lastSpot: num(r.last_spot),
        });
      }

      const earliestAlert = keys
        .map((k) => Date.parse(k.alertTs))
        .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
      const tapeStart = new Date(earliestAlert - TAPE_WINDOW_MIN * 60_000 * 2);
      const futuresRows = (await sql`
        SELECT symbol, ts, close
        FROM futures_bars
        WHERE symbol = ANY(${['NQ', 'ES', 'RTY']})
          AND ts >= ${tapeStart.toISOString()}
        ORDER BY symbol, ts
      `) as FuturesBar[];
      const spxRows = (await sql`
        SELECT timestamp AS ts, close
        FROM spx_candles_1m
        WHERE timestamp >= ${tapeStart.toISOString()}
        ORDER BY timestamp
      `) as SpxBar[];

      const dpRows = (await sql`
        SELECT date, spx_approx, total_premium
        FROM dark_pool_levels
        WHERE date = ANY(${dates})
      `) as DPLevel[];

      const gexRowsAll = (await sql`
        SELECT date, expiry, strike, abs_gex
        FROM greek_exposure_strike
        WHERE date = ANY(${dates})
          AND expiry = ANY(${[...expirySet]})
        ORDER BY date, expiry, abs_gex DESC
      `) as GEXStrikeRow[];
      const gexTop3 = new Map<
        string,
        Array<{ strike: number; abs_gex: number }>
      >();
      for (const r of gexRowsAll) {
        const dateStr = ymd(r.date);
        const expStr = ymd(r.expiry);
        const key = `${dateStr}|${expStr}`;
        const arr = gexTop3.get(key) ?? [];
        if (arr.length < 3) {
          arr.push({ strike: num(r.strike), abs_gex: num(r.abs_gex) });
          gexTop3.set(key, arr);
        }
      }

      const vixRows = (await sql`
        SELECT date, entry_time, vix
        FROM market_snapshots
        WHERE TO_CHAR(date, 'YYYY-MM-DD') = ANY(${dates})
          AND vix IS NOT NULL
        ORDER BY date, entry_time
      `) as VIXSnap[];
      const vixByDate = new Map<string, Array<{ tsMs: number; vix: number }>>();
      for (const r of vixRows) {
        const dateStr =
          typeof r.date === 'string' ? r.date.slice(0, 10) : ymd(r.date);
        const tsMs = parseEntryTimeUtc(dateStr, r.entry_time);
        if (tsMs == null) continue;
        const arr = vixByDate.get(dateStr) ?? [];
        arr.push({ tsMs, vix: num(r.vix) });
        vixByDate.set(dateStr, arr);
      }
      for (const arr of vixByDate.values()) arr.sort((a, b) => a.tsMs - b.tsMs);

      const futuresByMin = new Map<string, Map<number, number>>();
      for (const r of futuresRows) {
        const tsStr = isoTs(r.ts);
        if (!tsStr) continue;
        const tsMs = Date.parse(tsStr);
        if (Number.isNaN(tsMs)) continue;
        const sym = futuresByMin.get(r.symbol) ?? new Map<number, number>();
        sym.set(tsMs, num(r.close));
        futuresByMin.set(r.symbol, sym);
      }
      const spxByMin = new Map<number, number>();
      for (const r of spxRows) {
        const tsStr = isoTs(r.ts);
        if (!tsStr) continue;
        const tsMs = Date.parse(tsStr);
        if (Number.isNaN(tsMs)) continue;
        spxByMin.set(tsMs, num(r.close));
      }

      const contexts: Record<string, AnomalyCrossAssetContext> = {};
      for (const k of keys) {
        const date = ymd(k.alertTs);
        const alertMs = Date.parse(k.alertTs);
        const cKey = compoundKey(k.ticker, k.strike, k.side, k.expiry);

        const sp = spotPairMap.get(`${k.ticker}|${date}`);
        let regime: AnomalyRegime = 'unknown';
        if (
          sp &&
          Number.isFinite(sp.firstSpot) &&
          Number.isFinite(sp.lastSpot) &&
          sp.firstSpot > 0
        ) {
          const pct = ((sp.lastSpot - sp.firstSpot) / sp.firstSpot) * 100;
          regime = regimeLabel(pct);
        }

        let tapeAlignment: TapeAlignment = 'missing';
        const winStart = alertMs - TAPE_WINDOW_MIN * 60_000;
        const spxStart = pickClosestEarlier(spxByMin, winStart);
        const spxEnd = pickClosestEarlier(spxByMin, alertMs);
        if (spxStart != null && spxEnd != null && spxStart > 0) {
          const spxRet = spxEnd - spxStart;
          const futureDirs: number[] = [];
          for (const sym of ['NQ', 'ES', 'RTY']) {
            const map = futuresByMin.get(sym);
            if (!map) continue;
            const a = pickClosestEarlier(map, winStart);
            const b = pickClosestEarlier(map, alertMs);
            if (a != null && b != null) futureDirs.push(Math.sign(b - a));
          }
          const spxDir = Math.sign(spxRet);
          if (futureDirs.length === 0 || spxDir === 0) {
            tapeAlignment = 'neutral';
          } else {
            const allMatch = futureDirs.every((d) => d === spxDir);
            const wantUp = k.side === 'call';
            const tapeUp = spxDir > 0;
            if (allMatch && wantUp === tapeUp) tapeAlignment = 'aligned';
            else if (allMatch && wantUp !== tapeUp)
              tapeAlignment = 'contradicted';
            else tapeAlignment = 'neutral';
          }
        }

        let dpCluster: DPCluster = 'na';
        if (DP_TICKERS.has(k.ticker)) {
          let totalAtStrike = 0;
          for (const lvl of dpRows) {
            if (ymd(lvl.date) !== date) continue;
            const dist = Math.abs(num(lvl.spx_approx) - k.strike);
            if (dist <= DP_AT_STRIKE_BAND_PTS) {
              totalAtStrike += num(lvl.total_premium);
            }
          }
          dpCluster = dpBucket(totalAtStrike);
        }

        let gexZone: GEXZone = 'na';
        if (SPX_FAMILY.has(k.ticker)) {
          const gexKey = `${date}|${k.expiry}`;
          const top3 = gexTop3.get(gexKey);
          const spot = sp?.lastSpot;
          // Of the top-3 strikes by abs_gex on this (date, expiry), pick
          // the one closest to the alert strike, then check its position
          // vs current spot. Matches the ML script's E4 logic exactly so
          // backfill labels and live labels stay in sync.
          if (top3 && top3.length > 0 && Number.isFinite(spot)) {
            let nearestStrike = top3[0]!.strike;
            let bestDist = Math.abs(top3[0]!.strike - k.strike);
            for (const r of top3) {
              const d = Math.abs(r.strike - k.strike);
              if (d < bestDist) {
                nearestStrike = r.strike;
                bestDist = d;
              }
            }
            if (nearestStrike > (spot as number)) gexZone = 'above_spot';
            else if (nearestStrike < (spot as number)) gexZone = 'below_spot';
            else gexZone = 'at_spot';
          }
        }

        let vixDirection: VIXDirection = 'unknown';
        const vixSeries = vixByDate.get(date);
        if (vixSeries && vixSeries.length >= 2) {
          const winStartMs = alertMs - VIX_WINDOW_MIN * 60_000;
          const before = vixSeries.filter(
            (s) => s.tsMs <= alertMs && s.tsMs >= winStartMs - 10 * 60_000,
          );
          const first = before[0];
          const last = before.at(-1);
          if (first && last) {
            const delta = last.vix - first.vix;
            if (delta > 0.2) vixDirection = 'rising';
            else if (delta < -0.2) vixDirection = 'falling';
            else vixDirection = 'flat';
          }
        }

        contexts[cKey] = {
          regime,
          tapeAlignment,
          dpCluster,
          gexZone,
          vixDirection,
        };
      }

      const response: IVAnomaliesCrossAssetResponse = { contexts };
      setCacheHeaders(res, 30);
      return res.status(200).json(response);
    } catch (err) {
      logger.error({ err }, 'iv-anomalies-cross-asset failed');
      Sentry.captureException(err);
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
