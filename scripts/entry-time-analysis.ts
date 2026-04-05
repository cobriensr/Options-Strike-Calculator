#!/usr/bin/env npx tsx
/**
 * Entry Time Analysis: 8:45 AM CT vs 9:00 AM CT
 *
 * Run: npx tsx scripts/entry-time-analysis.ts
 *
 * Requires: your sc-owner cookie value as env var or hardcoded below.
 * Fetches ~60 days of history from your live API.
 */

const BASE_URL = 'https://theta-options.com';
const COOKIE = process.env.SC_OWNER_COOKIE || ''; // paste your cookie value here if not using env

if (!COOKIE) {
  console.error('Set SC_OWNER_COOKIE env var or paste it into the script.');
  console.error(
    'Usage: SC_OWNER_COOKIE=your_value npx tsx scripts/entry-time-analysis.ts',
  );
  process.exit(1);
}

// ============================================================
// STATIC VIX1D DATA (CBOE daily OHLC)
// ============================================================

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type Vix1dDaily = Record<
  string,
  { o: number; h: number; l: number; c: number }
>;
let vix1dStatic: Vix1dDaily = {};

function loadVix1dStatic(): void {
  const paths = [
    join(process.cwd(), 'public', 'vix1d-daily.json'),
    join(__dirname, '..', 'public', 'vix1d-daily.json'),
    join(__dirname, 'public', 'vix1d-daily.json'),
  ];
  for (const p of paths) {
    try {
      const raw = readFileSync(p, 'utf-8');
      vix1dStatic = JSON.parse(raw);
      console.log(
        `Loaded ${Object.keys(vix1dStatic).length} days of static VIX1D data from ${p}`,
      );
      return;
    } catch {
      // try next path
    }
  }
  console.warn('⚠ Could not load vix1d-daily.json — tried:');
  for (const p of paths) console.warn(`    ${p}`);
  console.warn('  Will fall back to VIX × 1.15 (strikes will be too wide)');
}

/** Get VIX1D for a date. Uses open for AM entries (before noon ET). */
function getStaticVix1d(date: string, hourET: number): number | null {
  const entry = vix1dStatic[date];
  if (!entry) return null;
  return hourET < 12 ? entry.o : entry.c;
}

// ============================================================
// BLACK-SCHOLES HELPERS
// ============================================================

function normalInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p < 0.5) return -normalInv(1 - p);
  const t = Math.sqrt(-2 * Math.log(1 - p));
  const c0 = 2.515517,
    c1 = 0.802853,
    c2 = 0.010328;
  const d1 = 1.432788,
    d2 = 0.189269,
    d3 = 0.001308;
  return (
    t - (c0 + c1 * t + c2 * t * t) / (1 + d1 * t + d2 * t * t + d3 * t * t * t)
  );
}

function calcStrike(
  spot: number,
  sigma: number,
  T: number,
  delta: number,
  skew: number,
  side: 'put' | 'call',
): number {
  const z = -normalInv(delta / 100);
  const sqrtT = Math.sqrt(T);
  const scaledSkew = ((skew / 100) * Math.min(z, 3)) / 1.28;
  const s =
    side === 'put' ? sigma * (1 + scaledSkew) : sigma * (1 - scaledSkew);
  const drift = -(s * s * T) / 2;
  return side === 'put'
    ? spot * Math.exp(-z * s * sqrtT + drift)
    : spot * Math.exp(z * s * sqrtT + drift);
}

function snapTo5(v: number): number {
  return Math.round(v / 5) * 5;
}

// ============================================================
// TYPES
// ============================================================

interface Candle {
  datetime: number;
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface HistoryResponse {
  date: string;
  spx: { candles: Candle[]; previousClose: number | null };
  vix: { candles: Candle[] };
  vix1d: { candles: Candle[] };
  vix9d: { candles: Candle[] };
  vvix: { candles: Candle[] };
  candleCount: number;
}

// ============================================================
// HELPERS
// ============================================================

const TARGET_DELTAS = [5, 8, 10, 12, 15];
const SKEW = 3;
const ANNUAL_HOURS = 6.5 * 252;

function parseTimeToMinutes(timeStr: string): number {
  // Handle "9:30 AM", "12:00 PM", "3:55 PM" etc.
  const match = /(\d{1,2}):(\d{2}) ?(AM|PM)?/i.exec(timeStr);
  if (!match) return -1;
  let h = Number(match[1]);
  const m = Number(match[2]);
  const ampm = match[3]?.toUpperCase();
  if (ampm === 'PM' && h < 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return h * 60 + m;
}

function findCandleAt(
  candles: Candle[],
  hourET: number,
  minuteET: number,
): { candle: Candle; index: number } | null {
  const targetMin = hourET * 60 + minuteET;
  let bestIdx = -1;
  for (let i = 0; i < candles.length; i++) {
    const cMin = parseTimeToMinutes(candles[i]!.time);
    if (cMin >= 0 && cMin <= targetMin) bestIdx = i;
  }
  return bestIdx >= 0 ? { candle: candles[bestIdx]!, index: bestIdx } : null;
}

function getValueAt(
  candles: Candle[],
  hourET: number,
  minuteET: number,
): number | null {
  const r = findCandleAt(candles, hourET, minuteET);
  return r ? r.candle.close : null;
}

function analyzeEntry(
  spxCandles: Candle[],
  entryIndex: number,
  spot: number,
  sigma: number,
  hoursRemaining: number,
) {
  const T = hoursRemaining / ANNUAL_HOURS;

  return TARGET_DELTAS.map((d) => {
    const putStrike = snapTo5(calcStrike(spot, sigma, T, d, SKEW, 'put'));
    const callStrike = snapTo5(calcStrike(spot, sigma, T, d, SKEW, 'call'));

    let high = -Infinity,
      low = Infinity;
    for (let i = entryIndex; i < spxCandles.length; i++) {
      if (spxCandles[i]!.high > high) high = spxCandles[i]!.high;
      if (spxCandles[i]!.low < low) low = spxCandles[i]!.low;
    }

    const settlement = spxCandles.at(-1)!.close;
    const callCushion = Math.round((callStrike - high) * 100) / 100;
    const putCushion = Math.round((low - putStrike) * 100) / 100;

    return {
      delta: d,
      putStrike,
      callStrike,
      survivedIntraday: high < callStrike && low > putStrike,
      settledSafe: settlement > putStrike && settlement < callStrike,
      callCushion,
      putCushion,
      minCushion:
        Math.round(
          Math.min(Math.abs(callCushion), Math.abs(putCushion)) * 100,
        ) / 100,
    };
  });
}

// ============================================================
// FETCH + ANALYZE
// ============================================================

function getTradingDays(count: number): string[] {
  const days: string[] = [];
  const d = new Date();
  d.setDate(d.getDate() - 1);
  while (days.length < count) {
    if (d.getDay() !== 0 && d.getDay() !== 6) {
      days.push(d.toISOString().split('T')[0]!);
    }
    d.setDate(d.getDate() - 1);
  }
  return days;
}

async function fetchDay(
  date: string,
  verbose = false,
): Promise<HistoryResponse | null> {
  try {
    const url = `${BASE_URL}/api/history?date=${date}`;
    const r = await fetch(url, {
      headers: { Cookie: `sc-owner=${COOKIE}` },
    });
    if (!r.ok) {
      console.error(`  ✗ ${date}: HTTP ${r.status} ${r.statusText}`);
      return null;
    }
    const data: HistoryResponse = await r.json();
    if (verbose) {
      console.log(
        `    ${date}: candleCount=${data.candleCount}, spx=${data.spx.candles.length}, vix=${data.vix.candles.length}`,
      );
    }
    if (data.candleCount === 0) {
      return null;
    }
    return data;
  } catch (e) {
    console.error(
      `  ✗ ${date}: ${e instanceof Error ? e.message : 'unknown error'}`,
    );
    return null;
  }
}

async function main() {
  loadVix1dStatic();

  // Preflight: test auth with a known-good endpoint
  console.log('Testing authentication...');
  try {
    const test = await fetch(`${BASE_URL}/api/quotes`, {
      headers: { Cookie: `sc-owner=${COOKIE}` },
    });
    if (test.status === 401) {
      console.error(
        '✗ Authentication failed (401). Cookie may be expired — re-authenticate at /api/auth/init',
      );
      process.exit(1);
    }
    if (!test.ok) {
      console.error(`✗ API returned ${test.status}: ${await test.text()}`);
      process.exit(1);
    }
    const q = await test.json();
    console.log(
      `✓ Authenticated. SPX: ${q.spx?.price ?? 'N/A'}, VIX: ${q.vix?.price ?? 'N/A'}\n`,
    );
  } catch (e) {
    console.error(`✗ Cannot reach API: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }

  console.log('Fetching ~70 trading days...\n');
  const days = getTradingDays(70);

  type DayRow = {
    date: string;
    dow: string;
    range: number;
    vix1d845: number | null;
    vix1d900: number | null;
    spot845: number;
    spot900: number;
    deltas: ReturnType<typeof analyzeEntry>;
    deltas900: ReturnType<typeof analyzeEntry>;
  };

  const results: DayRow[] = [];
  const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Fetch in batches of 5
  for (let i = 0; i < days.length; i += 5) {
    const batch = days.slice(i, i + 5);
    process.stdout.write(`  Fetching ${batch[0]} to ${batch.at(-1)}...`);

    const isFirstBatch = i === 0;
    if (isFirstBatch) console.log('  (verbose for first batch)');
    const fetches = await Promise.all(
      batch.map((d) => fetchDay(d, isFirstBatch)),
    );
    let count = 0;

    for (const data of fetches) {
      if (!data) continue;
      const spx = data.spx.candles;
      if (spx.length < 10) {
        if (isFirstBatch)
          console.log(`    ${data.date}: SKIP spx<10 (${spx.length})`);
        continue;
      }

      // Entry at 9:45 ET (8:45 CT)
      const e845 = findCandleAt(spx, 9, 45);
      const e900 = findCandleAt(spx, 10, 0);
      if (!e845 || !e900) {
        if (isFirstBatch)
          console.log(
            `    ${data.date}: SKIP candle miss (e845=${!!e845} e900=${!!e900} firstTime="${spx[0]?.time}" lastTime="${spx.at(-1)?.time}")`,
          );
        continue;
      }

      const vix1d845 =
        getValueAt(data.vix1d.candles, 9, 45) || getStaticVix1d(data.date, 9);
      const vix1d900 =
        getValueAt(data.vix1d.candles, 10, 0) || getStaticVix1d(data.date, 10);
      const vix845 = getValueAt(data.vix.candles, 9, 45);
      const vix900 = getValueAt(data.vix.candles, 10, 0);

      const sigma845 = vix1d845
        ? vix1d845 / 100
        : vix845
          ? (vix845 * 1.15) / 100
          : null;
      const sigma900 = vix1d900
        ? vix1d900 / 100
        : vix900
          ? (vix900 * 1.15) / 100
          : null;
      if (!sigma845 || !sigma900) {
        if (isFirstBatch)
          console.log(
            `    ${data.date}: SKIP sigma null (vix1d845=${vix1d845} vix845=${vix845} vix1dCandles=${data.vix1d.candles.length} sigma845=${sigma845} sigma900=${sigma900})`,
          );
        continue;
      }

      if (isFirstBatch)
        console.log(
          `    ${data.date}: OK spot845=${e845.candle.close.toFixed(0)} sigma=${sigma845.toFixed(4)} vix1d=${(vix1d845 ?? 0).toFixed(1)} (${getValueAt(data.vix1d.candles, 9, 45) ? 'schwab' : 'static'})`,
        );

      let dayHigh = -Infinity,
        dayLow = Infinity;
      for (const c of spx) {
        if (c.high > dayHigh) dayHigh = c.high;
        if (c.low < dayLow) dayLow = c.low;
      }

      const d = new Date(data.date + 'T12:00:00Z');
      results.push({
        date: data.date,
        dow: dows[d.getUTCDay()]!,
        range: dayHigh - dayLow,
        vix1d845,
        vix1d900,
        spot845: e845.candle.close,
        spot900: e900.candle.close,
        deltas: analyzeEntry(
          spx,
          e845.index,
          e845.candle.close,
          sigma845,
          6.25,
        ),
        deltas900: analyzeEntry(
          spx,
          e900.index,
          e900.candle.close,
          sigma900,
          6.0,
        ),
      });
      count++;
    }

    console.log(` ${count} days`);
  }

  results.sort((a, b) => a.date.localeCompare(b.date));

  // ============================================================
  // SUMMARY
  // ============================================================

  console.log(`\n${'='.repeat(80)}`);
  console.log(`ENTRY TIME ANALYSIS: 8:45 AM CT vs 9:00 AM CT`);
  console.log(
    `${results.length} trading days: ${results[0]?.date} to ${results.at(-1)?.date}`,
  );
  console.log(`${'='.repeat(80)}\n`);

  // Per-delta summary
  console.log('SETTLEMENT SURVIVAL RATE (hold to close):');
  console.log(`${'─'.repeat(72)}`);
  console.log(
    `  Delta │  8:45 CT       │  9:00 CT       │  Avg Cushion 845 │  Avg Cushion 900`,
  );
  console.log(`${'─'.repeat(72)}`);

  for (const delta of TARGET_DELTAS) {
    let safe845 = 0,
      safe900 = 0,
      total = 0;
    const cushions845: number[] = [],
      cushions900: number[] = [];

    for (const day of results) {
      const d845 = day.deltas.find((d) => d.delta === delta);
      const d900 = day.deltas900.find((d) => d.delta === delta);
      if (!d845 || !d900) continue;
      total++;
      if (d845.settledSafe) safe845++;
      if (d900.settledSafe) safe900++;
      cushions845.push(d845.minCushion);
      cushions900.push(d900.minCushion);
    }

    const avg845 = cushions845.reduce((a, b) => a + b, 0) / cushions845.length;
    const avg900 = cushions900.reduce((a, b) => a + b, 0) / cushions900.length;

    console.log(
      `  ${String(delta).padStart(3)}Δ  │  ${safe845}/${total} (${((safe845 / total) * 100).toFixed(1)}%)  │  ${safe900}/${total} (${((safe900 / total) * 100).toFixed(1)}%)  │  ${avg845.toFixed(1)} pts          │  ${avg900.toFixed(1)} pts`,
    );
  }
  console.log(`${'─'.repeat(72)}\n`);

  // Days where outcome differs
  console.log('DAYS WHERE WAITING UNTIL 9:00 CT SAVED A LOSS:');
  console.log(`${'─'.repeat(72)}`);

  let savedCount = 0;
  for (const day of results) {
    const diffs = TARGET_DELTAS.map((delta) => {
      const d845 = day.deltas.find((d) => d.delta === delta);
      const d900 = day.deltas900.find((d) => d.delta === delta);
      if (!d845 || !d900) return null;
      if (!d845.settledSafe && d900.settledSafe)
        return { delta, cushion900: d900.minCushion };
      return null;
    }).filter(Boolean);

    if (diffs.length > 0) {
      savedCount++;
      console.log(
        `  ${day.date} (${day.dow}) — range: ${day.range.toFixed(0)} pts`,
      );
      for (const d of diffs) {
        console.log(
          `    ${d!.delta}Δ: LOSS at 8:45 → SAFE at 9:00 (cushion: ${d!.cushion900.toFixed(0)} pts)`,
        );
      }
    }
  }
  if (savedCount === 0) console.log('  (none)');
  console.log();

  console.log('DAYS WHERE WAITING UNTIL 9:00 CT CAUSED A LOSS:');
  console.log(`${'─'.repeat(72)}`);

  let hurtCount = 0;
  for (const day of results) {
    const diffs = TARGET_DELTAS.map((delta) => {
      const d845 = day.deltas.find((d) => d.delta === delta);
      const d900 = day.deltas900.find((d) => d.delta === delta);
      if (!d845 || !d900) return null;
      if (d845.settledSafe && !d900.settledSafe)
        return { delta, cushion845: d845.minCushion };
      return null;
    }).filter(Boolean);

    if (diffs.length > 0) {
      hurtCount++;
      console.log(
        `  ${day.date} (${day.dow}) — range: ${day.range.toFixed(0)} pts`,
      );
      for (const d of diffs) {
        console.log(
          `    ${d!.delta}Δ: SAFE at 8:45 → LOSS at 9:00 (845 cushion: ${d!.cushion845.toFixed(0)} pts)`,
        );
      }
    }
  }
  if (hurtCount === 0) console.log('  (none)');
  console.log();

  // Per-day full grid
  console.log('FULL DAY-BY-DAY COMPARISON (S = settled safe, X = loss):');
  console.log(`${'─'.repeat(90)}`);
  console.log(
    `  Date       │ DOW │ Range │ VIX1D │  5Δ    │  8Δ    │  10Δ   │  12Δ   │  15Δ`,
  );
  console.log(
    `             │     │       │       │ 845/900│ 845/900│ 845/900│ 845/900│ 845/900`,
  );
  console.log(`${'─'.repeat(90)}`);

  for (const day of results) {
    const cols = TARGET_DELTAS.map((delta) => {
      const d845 = day.deltas.find((d) => d.delta === delta);
      const d900 = day.deltas900.find((d) => d.delta === delta);
      const s845 = d845?.settledSafe ? 'S' : 'X';
      const s900 = d900?.settledSafe ? 'S' : 'X';
      const mark = s845 === s900 ? ' ' : '*';
      return `${s845}/${s900}${mark}`;
    });

    console.log(
      `  ${day.date} │ ${day.dow} │ ${day.range.toFixed(0).padStart(5)} │ ${(day.vix1d845 ?? 0).toFixed(1).padStart(5)} │ ${cols.map((c) => c.padEnd(6)).join(' │ ')}`,
    );
  }

  console.log(`${'─'.repeat(90)}`);
  console.log(`  * = outcome differs between 8:45 and 9:00 entry\n`);

  console.log(`BOTTOM LINE:`);
  console.log(`  Days saved by waiting:  ${savedCount}`);
  console.log(`  Days hurt by waiting:   ${hurtCount}`);
  console.log(
    `  Days no difference:     ${results.length - savedCount - hurtCount}`,
  );
  console.log();
}

await main().catch(console.error);
