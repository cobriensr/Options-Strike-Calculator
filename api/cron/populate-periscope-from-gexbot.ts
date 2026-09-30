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
import { MARKET_MINUTES } from '../_lib/constants.js';
import { isGexbotLiveCt } from '../_lib/cron-helpers.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { getETDateStr, getETTime } from '../../src/utils/timezone.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import {
  PANELS,
  PANEL_TO_CATEGORY,
  STALENESS_CUTOFF_MS,
  TICKER,
  decodeStrikes,
  type GexbotStatePayload,
} from '../_lib/periscope-gexbot.js';

export const config = { maxDuration: 30 };

/**
 * Minutes after the 09:30 ET open during which an ALL-panels "no fresh row"
 * miss is the expected open race, not an outage: the 09:30 populate run
 * queries before the same-minute fetch-gexbot-strikes run has inserted, so
 * no row falls inside the 5-min staleness window (the prior session's last
 * capture is hours old) — D9, a daily "3 panel(s) failed" warning at
 * 13:30:16 UTC.
 */
const OPEN_WARMUP_MINUTES = 3;

/** True during the first OPEN_WARMUP_MINUTES minutes from 09:30 ET. */
function inOpenWarmup(now: Date): boolean {
  const { hour, minute } = getETTime(now);
  const sinceOpen = hour * 60 + minute - MARKET_MINUTES.OPEN;
  return sinceOpen >= 0 && sinceOpen < OPEN_WARMUP_MINUTES;
}

// Re-export for the existing test file that imports `decodeStrikes` from
// this module. New callers should import from _lib/periscope-gexbot.
export { decodeStrikes };

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

    // Pull the latest capture row per panel within the staleness
    // window. Anything older means GEXBot is down — we skip rather
    // than backfill a stale slice.
    const stalenessCutoff = new Date(Date.now() - STALENESS_CUTOFF_MS);

    let totalRows = 0;
    let panelsWritten = 0;
    let stalePanels = 0;
    const errors: string[] = [];

    for (const panel of PANELS) {
      const category = PANEL_TO_CATEGORY[panel];
      const rows = (await withDbRetry(
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
      )) as { captured_at: Date | string; raw_response: GexbotStatePayload }[];

      if (rows.length === 0) {
        stalePanels += 1;
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
      const inserted = (await withDbRetry(
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
      )) as { strike: number }[];

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

    // Every panel stale right after the open = the 09:30 race with the
    // strikes capture (see OPEN_WARMUP_MINUTES), so skip quietly; the next
    // 10-min tick picks the slice up. A partial miss, a decode failure, or
    // an all-stale run later in the session still warns below.
    if (stalePanels === PANELS.length && inOpenWarmup(new Date())) {
      logger.info(
        { errors },
        'populate-periscope-from-gexbot: no fresh GexBot rows yet (open warm-up)',
      );
      return {
        status: 'skipped',
        rows: 0,
        message: 'open warm-up: GexBot strikes not captured yet',
        metadata: { panelsWritten, errors },
      };
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
  // Gate to the GexBot live window (09:30 ET → close + 1 min), matching
  // the upstream gexbot capture crons it reads from. Without this, ticks
  // outside that window find no fresh `gexbot_api_capture` row and emit a
  // "no fresh row" Sentry warning every cycle.
  { requireApiKey: false, timeCheck: isGexbotLiveCt },
);
