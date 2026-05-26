/**
 * GET /api/cron/populate-periscope-from-gexbot
 *
 * Adapter: reads the latest GEXBot `state/{gamma,charm,vanna}_zero`
 * captures for SPX from `gexbot_api_capture` and writes them into the
 * `periscope_snapshots` table in the schema the existing scraper used.
 *
 * Replaces the Railway periscope-scraper service. GEXBot's REST API is
 * reliable where Playwright was not. The scraper-fed crons
 * (detect-periscope-call-lottery, detect-periscope-put-lottery,
 * enrich-periscope-lottery-outcomes, periscope-auto-playbook) keep
 * working unchanged because they only SELECT from periscope_snapshots —
 * they don't care who writes the rows.
 *
 * Cadence: every 10 min during RTH. Matches the existing
 * detect-periscope-* slice-over-slice delta semantics. For true 1-min
 * latency in the panel, see
 * `docs/superpowers/specs/periscope-analyzer-build-2026-05-21.md` —
 * that build replaces the panel reading path entirely.
 *
 * What's covered: gamma, charm, vanna panels for SPX 0DTE.
 * What's NOT covered (vs. the scraper): positions panel — GEXBot's
 * Orderflow tier doesn't expose a positions endpoint. Detectors don't
 * use positions, so this is fine for now.
 *
 * Idempotency: `periscope_snapshots` UNIQUE
 * (captured_at, expiry, panel, strike) gives natural dedup. Re-running
 * the cron on the same minute is a no-op.
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { getETDateStr } from '../../src/utils/timezone.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

export const config = { maxDuration: 30 };

type PanelName = 'gamma' | 'charm' | 'vanna';

const PANEL_TO_CATEGORY: Record<PanelName, string> = {
  gamma: 'gamma_zero',
  charm: 'charm_zero',
  vanna: 'vanna_zero',
};

const PANELS: PanelName[] = ['gamma', 'charm', 'vanna'];
const TICKER = 'SPX';

interface GexbotStatePayload {
  spot?: number;
  ticker?: string;
  timestamp?: number;
  min_dte?: number;
  major_negative?: number;
  major_positive?: number;
  mini_contracts?: unknown[][];
}

interface DecodedStrike {
  strike: number;
  value: number;
}

/**
 * Decode GEXBot's `mini_contracts` array. Each row is
 *   [strike, call_val, put_val, total_dealer_value, [t-1m, t-5m, t-10m], 0, null]
 * Position-3 is the signed MM-attributed value for the panel
 * (gamma at gamma_zero endpoint, charm at charm_zero, etc.).
 *
 * Rows with non-numeric position-0 or position-3 are dropped — the
 * payload occasionally includes sparse rows for far-OTM strikes where
 * the dealer book is empty.
 */
export function decodeStrikes(payload: GexbotStatePayload): DecodedStrike[] {
  const arr = payload.mini_contracts;
  if (!Array.isArray(arr)) return [];
  const out: DecodedStrike[] = [];
  for (const row of arr) {
    if (!Array.isArray(row) || row.length < 4) continue;
    // Number(null) coerces to 0 — explicit null/undefined check.
    if (row[0] == null || row[3] == null) continue;
    const strike = Number(row[0]);
    const value = Number(row[3]);
    if (!Number.isFinite(strike) || !Number.isFinite(value)) continue;
    out.push({ strike: Math.round(strike), value });
  }
  return out;
}

/**
 * Build the "HH:MM - HH:MM" CT timeframe label matching the scraper's
 * convention. Floors `capturedAt` to the prior 10-min CT slot.
 */
function formatTimeframe(capturedAt: Date): string {
  const ctOpts = { timeZone: 'America/Chicago', hour12: false } as const;
  const parts = new Intl.DateTimeFormat('en-US', {
    ...ctOpts,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(capturedAt);
  const hr = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const min = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const slotStart = min - (min % 10);
  const slotEnd = (slotStart + 10) % 60;
  const slotEndHr = slotStart + 10 >= 60 ? (hr + 1) % 24 : hr;
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${pad(hr)}:${pad(slotStart)} - ${pad(slotEndHr)}:${pad(slotEnd)}`;
}

export default withCronInstrumentation(
  'populate-periscope-from-gexbot',
  async (): Promise<CronResult> => {
    const sql = getDb();
    const todayEt = getETDateStr(new Date()); // 0DTE expiry

    // Pull the latest capture row per panel from the last 5 min.
    // Anything older means GEXBot is down — we skip rather than
    // backfill a stale slice.
    const stalenessCutoff = new Date(Date.now() - 5 * 60 * 1000);

    let totalRows = 0;
    let panelsWritten = 0;
    const errors: string[] = [];

    for (const panel of PANELS) {
      const category = PANEL_TO_CATEGORY[panel];
      const rows = await withDbRetry(
        () => sql`
          SELECT captured_at, raw_response
          FROM gexbot_api_capture
          WHERE ticker = ${TICKER}
            AND endpoint = 'state'
            AND category = ${category}
            AND captured_at >= ${stalenessCutoff.toISOString()}
          ORDER BY captured_at DESC
          LIMIT 1
        `,
      ) as { captured_at: Date | string; raw_response: GexbotStatePayload }[];

      if (rows.length === 0) {
        errors.push(`no fresh ${category} row for ${TICKER}`);
        continue;
      }

      const row = rows[0]!;
      const capturedAt = new Date(row.captured_at);
      const decoded = decodeStrikes(row.raw_response);

      if (decoded.length === 0) {
        errors.push(`${category}: no strikes decoded from payload`);
        continue;
      }

      const timeframe = formatTimeframe(capturedAt);

      // Build VALUES clause for batch insert.
      const strikes = decoded.map((d) => d.strike);
      const values = decoded.map((d) => d.value);
      const inserted = await withDbRetry(
        () => sql`
          INSERT INTO periscope_snapshots (captured_at, expiry, panel, strike, value, timeframe)
          SELECT
            ${capturedAt.toISOString()}::timestamptz,
            ${todayEt}::date,
            ${panel},
            unnest(${strikes}::int[]) AS strike,
            unnest(${values}::numeric[]) AS value,
            ${timeframe}
          ON CONFLICT (captured_at, expiry, panel, strike) DO NOTHING
          RETURNING strike
        `,
      ) as { strike: number }[];

      totalRows += inserted.length;
      panelsWritten += 1;
      logger.info(
        {
          panel,
          capturedAt: capturedAt.toISOString(),
          decoded: decoded.length,
          inserted: inserted.length,
          timeframe,
        },
        'populated periscope_snapshots',
      );
    }

    if (errors.length > 0) {
      Sentry.captureMessage(
        `populate-periscope-from-gexbot: ${errors.length} panel(s) failed`,
        { level: 'warning', extra: { errors } },
      );
    }

    return {
      status: panelsWritten === PANELS.length ? 'success' : 'partial',
      rows: totalRows,
      metadata: { panelsWritten, errors },
    };
  },
  { requireApiKey: false },
);
