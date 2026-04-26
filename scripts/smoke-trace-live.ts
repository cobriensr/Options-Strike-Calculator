/**
 * Smoke test for POST /api/trace-live-analyze.
 *
 * Loads the three TRACE chart captures (gamma, charm, delta) for a given
 * date+slot, queries Neon for the GEX snapshot at that timestamp using the
 * same `gex_strike_0dte` table the frontend GEX Landscape component reads
 * from, and POSTs the assembled `TraceLiveAnalyzeBody` to a running
 * instance of the endpoint.
 *
 * Usage (env vars loaded from .env.local via tsx's --env-file):
 *   npx tsx --env-file=.env.local scripts/smoke-trace-live.ts \
 *     --date 2026-04-23 --slot close
 *
 *   # against a deployed preview/production:
 *   npx tsx --env-file=.env.local scripts/smoke-trace-live.ts \
 *     --date 2026-04-23 --slot close \
 *     --endpoint https://strike.example.com/api/trace-live-analyze
 *
 * Requires DATABASE_URL and OWNER_SECRET. The OWNER_SECRET is sent as the
 * `sc-owner` cookie so guardOwnerEndpoint accepts the request.
 *
 * Before running for the first time, ensure migration 88 has been applied:
 *   curl -X POST http://localhost:3000/api/journal/migrate \
 *     -H "Cookie: sc-owner=$OWNER_SECRET"
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { neon } from '@neondatabase/serverless';
import { etWallClockToUtcIso } from '../src/utils/timezone.js';
import { CLASS_META } from '../src/components/GexLandscape/constants.js';
import type { GexClassification } from '../src/components/GexLandscape/classify.js';

// ============================================================
// CLI parsing
// ============================================================

type Slot = 'open' | 'mid' | 'close' | 'eod';

interface CliArgs {
  date: string;
  slot: Slot;
  endpoint: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let date: string | null = null;
  let slot: Slot | null = null;
  let endpoint = 'http://localhost:3000/api/trace-live-analyze';

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--date') date = args[++i] ?? null;
    else if (a === '--slot') slot = (args[++i] ?? null) as Slot | null;
    else if (a === '--endpoint') endpoint = args[++i] ?? endpoint;
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    }
  }

  if (!date || !slot) {
    printUsage();
    process.exit(1);
  }
  if (!['open', 'mid', 'close', 'eod'].includes(slot)) {
    console.error(`Invalid --slot: ${slot}. Expected open|mid|close|eod.`);
    process.exit(1);
  }
  return { date, slot, endpoint };
}

function printUsage(): void {
  console.error(
    'Usage: smoke-trace-live --date YYYY-MM-DD --slot open|mid|close|eod [--endpoint URL]',
  );
}

// ============================================================
// Slot → ET minute-of-day → UTC ISO (DST-aware)
// ============================================================

const SLOT_MINUTES_ET: Record<Slot, number> = {
  open: 9 * 60 + 30, // 09:30 ET
  mid: 13 * 60, // 13:00 ET
  close: 15 * 60 + 30, // 15:30 ET
  eod: 16 * 60, // 16:00 ET
};

const SLOT_LABEL_ET: Record<Slot, string> = {
  open: '09:30 ET',
  mid: '13:00 ET',
  close: '15:30 ET',
  eod: '16:00 ET',
};

/**
 * DST-aware conversion of (YYYY-MM-DD, slot) into a UTC ISO 8601 string.
 * Uses the project's `etWallClockToUtcIso`, which probes ET's offset via
 * Intl.DateTimeFormat — correct across EST↔EDT and any future TZ rule
 * changes.
 */
function toUtcIso(date: string, slot: Slot): string {
  const iso = etWallClockToUtcIso(date, SLOT_MINUTES_ET[slot]);
  if (!iso) {
    throw new Error(`Invalid date for ET conversion: ${date}`);
  }
  return iso;
}

// ============================================================
// Image loading
// ============================================================

function loadImageAsBase64(
  chart: 'gamma' | 'charm' | 'delta',
  date: string,
  slot: Slot,
): string {
  const folder =
    chart === 'charm'
      ? 'charm-pressure-capture'
      : chart === 'delta'
        ? 'delta-pressure-capture'
        : 'gamma-capture';
  const path = resolve(
    process.cwd(),
    'scripts',
    folder,
    'screenshots',
    date,
    `${slot}.png`,
  );
  if (!existsSync(path)) {
    throw new Error(`Capture not found: ${path}`);
  }
  return readFileSync(path).toString('base64');
}

// ============================================================
// GEX snapshot query — mirrors the gex_strike_0dte data flow used by
// src/components/GexLandscape (per agent trace 2026-04-26).
// ============================================================

interface RawStrikeRow {
  strike: number;
  price: number;
  call_gamma_oi: string;
  put_gamma_oi: string;
  call_charm_oi: string | null;
  put_charm_oi: string | null;
}

type SqlClient = ReturnType<typeof neon>;

async function findClosestSnapshotAt(
  sql: SqlClient,
  date: string,
  asOfIso: string,
): Promise<string | null> {
  const tsRows = await sql`
    SELECT timestamp::text AS ts
    FROM gex_strike_0dte
    WHERE date = ${date} AND timestamp <= ${asOfIso}
    ORDER BY timestamp DESC
    LIMIT 1
  `;
  if (tsRows.length === 0) return null;
  return tsRows[0]!.ts as string;
}

async function fetchSnapshot(
  sql: SqlClient,
  date: string,
  ts: string,
): Promise<RawStrikeRow[]> {
  const rows = await sql`
    SELECT strike, price,
           call_gamma_oi, put_gamma_oi,
           call_charm_oi, put_charm_oi
    FROM gex_strike_0dte
    WHERE date = ${date} AND timestamp = ${ts}
    ORDER BY strike DESC
  `;
  return rows as RawStrikeRow[];
}

async function fetchPriorGammaMap(
  sql: SqlClient,
  date: string,
  beforeIso: string,
  minutesAgo: number,
): Promise<Map<number, number>> {
  const target = new Date(
    new Date(beforeIso).getTime() - minutesAgo * 60_000,
  ).toISOString();
  const ts = await findClosestSnapshotAt(sql, date, target);
  if (!ts) return new Map();
  const rows = (await sql`
    SELECT strike, call_gamma_oi, put_gamma_oi
    FROM gex_strike_0dte
    WHERE date = ${date} AND timestamp = ${ts}
  `) as Array<{
    strike: number;
    call_gamma_oi: string;
    put_gamma_oi: string;
  }>;
  const map = new Map<number, number>();
  for (const r of rows) {
    map.set(Number(r.strike), Number(r.call_gamma_oi) + Number(r.put_gamma_oi));
  }
  return map;
}

// ============================================================
// Classification — mirrors src/components/GexLandscape/classify.ts
// (kebab-case keys to match CLASS_META in constants.ts).
// ============================================================

const SPOT_BAND_DOLLARS = 12;

function classify(netGamma: number, netCharm: number): GexClassification {
  if (netGamma < 0 && netCharm >= 0) return 'max-launchpad';
  if (netGamma < 0 && netCharm < 0) return 'fading-launchpad';
  if (netGamma >= 0 && netCharm >= 0) return 'sticky-pin';
  return 'weakening-pin';
}

function getDirection(
  strike: number,
  spot: number,
): 'ceiling' | 'floor' | 'atm' {
  const offset = strike - spot;
  if (offset > SPOT_BAND_DOLLARS) return 'ceiling';
  if (offset < -SPOT_BAND_DOLLARS) return 'floor';
  return 'atm';
}

function pctChange(current: number, prior: number | undefined): number | null {
  if (prior == null || prior === 0) return null;
  return ((current - prior) / Math.abs(prior)) * 100;
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
  const { date, slot, endpoint } = parseArgs();
  const databaseUrl = process.env.DATABASE_URL;
  const ownerSecret = process.env.OWNER_SECRET;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL not set. Run: npx tsx --env-file=.env.local …',
    );
  }
  if (!ownerSecret) {
    throw new Error(
      'OWNER_SECRET not set. Run: npx tsx --env-file=.env.local …',
    );
  }

  const asOfIso = toUtcIso(date, slot);
  const etTimeLabel = SLOT_LABEL_ET[slot];
  console.log(
    `→ Loading captures for ${date} ${slot} (${etTimeLabel} = ${asOfIso})`,
  );

  const gammaImg = loadImageAsBase64('gamma', date, slot);
  const charmImg = loadImageAsBase64('charm', date, slot);
  const deltaImg = loadImageAsBase64('delta', date, slot);
  console.log(
    `  gamma:${(gammaImg.length / 1024).toFixed(0)}KB  ` +
      `charm:${(charmImg.length / 1024).toFixed(0)}KB  ` +
      `delta:${(deltaImg.length / 1024).toFixed(0)}KB`,
  );

  const sql = neon(databaseUrl);

  const snapshotTs = await findClosestSnapshotAt(sql, date, asOfIso);
  if (!snapshotTs) {
    throw new Error(
      `No gex_strike_0dte snapshot for ${date} at-or-before ${asOfIso}. ` +
        `Verify the 1-min cron ran on this date.`,
    );
  }
  const rows = await fetchSnapshot(sql, date, snapshotTs);
  if (rows.length === 0) {
    throw new Error(`Empty snapshot for ${date} @ ${snapshotTs}`);
  }
  const spot = Number(rows[0]!.price);
  console.log(
    `→ GEX snapshot ${snapshotTs}  spot=${spot.toFixed(2)}  ` +
      `${rows.length} strikes`,
  );

  console.log('→ Fetching prior snapshots (1m, 5m) for delta computation');
  const [prev1m, prev5m] = await Promise.all([
    fetchPriorGammaMap(sql, date, snapshotTs, 1),
    fetchPriorGammaMap(sql, date, snapshotTs, 5),
  ]);
  console.log(`  1m prior:${prev1m.size}  5m prior:${prev5m.size}`);

  // Build per-strike rows (mirrors GexLandscape derivation). When charm is
  // missing on a row, leave classification + signal + charm absent — we
  // can't compute the gamma×charm quadrant without both inputs, and emitting
  // a stand-in (e.g. charm=0 → sticky_pin) would distort the prompt vs.
  // production behavior.
  const strikes = rows.map((r) => {
    const strike = Number(r.strike);
    const dollarGamma = Number(r.call_gamma_oi) + Number(r.put_gamma_oi);
    const dir = getDirection(strike, spot);
    const base = {
      strike,
      dollarGamma,
      delta1m: pctChange(dollarGamma, prev1m.get(strike)) ?? undefined,
      delta5m: pctChange(dollarGamma, prev5m.get(strike)) ?? undefined,
    };
    if (r.call_charm_oi == null || r.put_charm_oi == null) {
      return base;
    }
    const charm = Number(r.call_charm_oi) + Number(r.put_charm_oi);
    const cls = classify(dollarGamma, charm);
    return {
      ...base,
      charm,
      classification: cls,
      // Use the production CLASS_META signal mapping so the model sees
      // "Hard Floor" / "Softening Ceiling" / etc. — exactly what the GEX
      // Landscape UI shows — instead of a synthetic vocabulary.
      signal: CLASS_META[cls].signal(dir),
    };
  });

  // Aggregates
  let totalPosGex = 0;
  let totalNegGex = 0;
  for (const s of strikes) {
    if (s.dollarGamma > 0) totalPosGex += s.dollarGamma;
    else totalNegGex += s.dollarGamma;
  }
  const netGex = totalPosGex + totalNegGex;
  const regime =
    netGex > 0 ? 'positive_gamma' : netGex < 0 ? 'negative_gamma' : 'neutral';

  // Drift targets — top 2 strikes above/below spot by |dollarGamma|
  const driftTargetsUp = strikes
    .filter((s) => s.strike > spot)
    .sort((a, b) => Math.abs(b.dollarGamma) - Math.abs(a.dollarGamma))
    .slice(0, 2)
    .map((s) => s.strike);
  const driftTargetsDown = strikes
    .filter((s) => s.strike < spot)
    .sort((a, b) => Math.abs(b.dollarGamma) - Math.abs(a.dollarGamma))
    .slice(0, 2)
    .map((s) => s.strike);

  // ATM strike — nearest strike to spot
  const atmStrike = strikes.reduce(
    (closest, s) =>
      Math.abs(s.strike - spot) < Math.abs(closest - spot) ? s.strike : closest,
    strikes[0]!.strike,
  );

  const body = {
    capturedAt: snapshotTs,
    spot,
    stabilityPct: null,
    etTimeLabel,
    images: [
      {
        chart: 'gamma' as const,
        slot,
        mediaType: 'image/png' as const,
        data: gammaImg,
        capturedAt: snapshotTs,
      },
      {
        chart: 'charm' as const,
        slot,
        mediaType: 'image/png' as const,
        data: charmImg,
        capturedAt: snapshotTs,
      },
      {
        chart: 'delta' as const,
        slot,
        mediaType: 'image/png' as const,
        data: deltaImg,
        capturedAt: snapshotTs,
      },
    ],
    gex: {
      regime,
      totalPosGex,
      totalNegGex,
      netGex,
      atmStrike,
      driftTargetsUp,
      driftTargetsDown,
      strikes,
    },
  };

  console.log(
    `→ Built TraceLiveAnalyzeBody: regime=${regime}  ` +
      `net=${(netGex / 1e9).toFixed(2)}B  ` +
      `pos=${(totalPosGex / 1e9).toFixed(2)}B  ` +
      `neg=${(totalNegGex / 1e9).toFixed(2)}B`,
  );
  console.log(
    `  driftUp=[${driftTargetsUp.join(',')}]  ` +
      `driftDown=[${driftTargetsDown.join(',')}]  ` +
      `atm=${atmStrike}`,
  );

  console.log(`→ POST ${endpoint}`);
  const startTs = Date.now();
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `sc-owner=${ownerSecret}`,
    },
    body: JSON.stringify(body),
  });
  const elapsed = Date.now() - startTs;
  console.log(`← HTTP ${res.status} in ${elapsed}ms`);

  const text = await res.text();
  let printed: string;
  try {
    printed = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    printed = text;
  }
  console.log(printed);

  if (!res.ok) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('FATAL:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
