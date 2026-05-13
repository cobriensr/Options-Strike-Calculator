/**
 * POST /api/periscope-auto-playbook
 *
 * Phase 2b of docs/superpowers/specs/periscope-auto-playbook-2026-05-10.md.
 *
 * Scraper-triggered Claude playbook generator. Called by the periscope-
 * scraper Railway daemon after each successful 10-min tick (RTH) once
 * `periscope_snapshots` has the slot's data persisted.
 *
 * Request shape:
 *   POST /api/periscope-auto-playbook
 *   Authorization: Bearer <PERISCOPE_WEBHOOK_SECRET>
 *   Content-Type: application/json
 *   { "tradingDate": "2026-05-12", "capturedAt": "...ISO...", "slotKey": "08:20 - 08:30" }
 *
 * Response (immediate, under 5s):
 *   202 Accepted: { rowId, status: 'in_progress', mode } — Claude call kicked
 *       off via waitUntil, panel can poll /api/periscope-playbook for completion.
 *   200 OK with idempotent: a row already exists for this (tradingDate,
 *       slotCapturedAt). Returns the existing row id; no Claude call.
 *   503 Service Unavailable: AUTO_PLAYBOOK_ENABLED='false' kill switch is set.
 *   401: missing or wrong Authorization Bearer token.
 *   400: malformed body.
 *   422: slot is outside the analyzable window (08:20 CT to 14:50 CT) — caller
 *       should NOT retry; the slot is intentionally skipped.
 *
 * Two-phase persistence:
 *   1. INSERT a placeholder row with status='in_progress' (lets a panel
 *      poll show "Claude reading slot X").
 *   2. waitUntil(runner + UPDATE row to status='complete' / 'failed' /
 *      'truncated'). The function instance stays alive past the 202
 *      response for the full Opus thinking budget.
 *
 * Idempotency: the unique constraint on (trading_date, slot_captured_at,
 * auto_generated) means a duplicate scraper webhook (retry, redeploy
 * race) hits ON CONFLICT DO NOTHING and we return 200 with the existing
 * row id. No advisory lock needed — Postgres does the job.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { Sentry, metrics } from './_lib/sentry.js';
import logger from './_lib/logger.js';
import { rejectIfRateLimited } from './_lib/api-helpers.js';
import { optionalEnv, requireEnv } from './_lib/env.js';
import { getDb } from './_lib/db.js';
import {
  ctWallClockToUtcMs,
  fetchSPXSpotAtTimestamp,
} from './_lib/spx-candles.js';
import {
  savePeriscopeAnalysis,
  completePeriscopeAnalysis,
  type PeriscopeMode,
} from './_lib/periscope-db.js';
import { runPeriscopeAutoPlaybook } from './_lib/periscope-chat-runner.js';

// 720s matches the runner's SDK timeout headroom + 60s slack for the
// final UPDATE. Caps below Vercel's 800s plan ceiling.
export const config = { maxDuration: 720 };

const FIRST_ANALYZABLE_SLOT = '08:20 - 08:30';
const LAST_ANALYZABLE_SLOT = '14:50 - 15:00';
const FIRST_ANALYZABLE_MIN = 8 * 60 + 20;
const LAST_ANALYZABLE_START_MIN = 14 * 60 + 50;

const bodySchema = z.object({
  tradingDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'tradingDate must be YYYY-MM-DD'),
  capturedAt: z.string().datetime({ message: 'capturedAt must be ISO 8601' }),
  slotKey: z
    .string()
    .regex(/^\d{2}:\d{2} - \d{2}:\d{2}$/, 'slotKey must be "HH:MM - HH:MM"'),
});

type ParsedBody = z.infer<typeof bodySchema>;

interface ModeDerivation {
  mode: PeriscopeMode;
  /** HH:MM CT — start of the slot timeframe; used as `read_time` anchor. */
  readTimeCt: string;
}

/**
 * Map the slot timeframe label to the auto-playbook mode. Returns null for
 * pre-market and post-close slots (which the scraper records but the
 * runner doesn't analyze — see spec mode-derivation, Phase 2).
 */
function deriveMode(slotKey: string): ModeDerivation | null {
  const m = /^(\d{2}):(\d{2}) - (\d{2}):(\d{2})$/.exec(slotKey);
  if (!m) return null;
  const startHour = Number.parseInt(m[1] ?? '0', 10);
  const startMinute = Number.parseInt(m[2] ?? '0', 10);
  const endHour = Number.parseInt(m[3] ?? '0', 10);
  const endMinute = Number.parseInt(m[4] ?? '0', 10);
  const startMin = startHour * 60 + startMinute;

  if (startMin < FIRST_ANALYZABLE_MIN) return null;
  if (startMin > LAST_ANALYZABLE_START_MIN) return null;

  // Anchor read_time at the END of the timeframe label, not the START.
  // The scraper captures `captured_at` at the END of each 10-min slot
  // (when the chart's data for that slot is published), so anchoring
  // the spot lookup to the END aligns with the moment the read is
  // actually "for". Critical for the pre_trade slot: START (08:20 CT)
  // falls in pre-market and `fetchSPXSpotAtTimestamp` filters to
  // regular-hours candles only → 422. END (08:30 CT) lands exactly on
  // the first regular-hours candle.
  const readTimeCt = `${String(endHour).padStart(2, '0')}:${String(endMinute).padStart(2, '0')}`;

  if (slotKey === FIRST_ANALYZABLE_SLOT)
    return { mode: 'pre_trade', readTimeCt };
  if (slotKey === LAST_ANALYZABLE_SLOT) return { mode: 'debrief', readTimeCt };
  return { mode: 'intraday', readTimeCt };
}

/**
 * Convert a UTC Date to its CT wall-clock fields. DST-aware via
 * Intl.DateTimeFormat. Returns 24-hour `hour`, `minute`, and the
 * 3-letter weekday so callers can gate on RTH bounds without booting
 * a moment-like library.
 */
function capturedAtToCt(d: Date): {
  hour: number;
  minute: number;
  weekday: string;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    hour: Number.parseInt(get('hour'), 10),
    minute: Number.parseInt(get('minute'), 10),
    weekday: get('weekday'),
  };
}

/** Parse the END time of a slot label like "08:20 - 08:30" → {h:8,m:30}. */
function parseSlotEnd(
  slotKey: string,
): { hour: number; minute: number } | null {
  // Match "HH:MM - HH:MM" with flexible whitespace.
  const m = /^\s*\d{1,2}:\d{2}\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(slotKey);
  if (m == null) return null;
  const hour = Number.parseInt(m[1]!, 10);
  const minute = Number.parseInt(m[2]!, 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return { hour, minute };
}

/** Look up the latest non-debrief auto-generated row for this trading day. */
async function resolveParentId(tradingDate: string): Promise<number | null> {
  const sql = getDb();
  try {
    const rows = await sql`
      SELECT id FROM periscope_analyses
      WHERE trading_date = ${tradingDate}
        AND auto_generated = TRUE
        AND mode != 'debrief'
        AND status = 'complete'
      ORDER BY slot_captured_at DESC
      LIMIT 1
    `;
    const id = rows[0]?.id;
    if (id == null) return null;
    const n = Number(id);
    return Number.isFinite(n) ? n : null;
  } catch (err) {
    Sentry.captureException(err);
    logger.warn(
      { err, tradingDate },
      'auto-playbook: parent resolution failed — proceeding without parent',
    );
    return null;
  }
}

/** Look up the existing row id for an idempotent retry, if any. */
async function findExistingRowId(
  tradingDate: string,
  slotCapturedAt: string,
): Promise<number | null> {
  const sql = getDb();
  try {
    const rows = await sql`
      SELECT id FROM periscope_analyses
      WHERE trading_date = ${tradingDate}
        AND slot_captured_at = ${slotCapturedAt}
        AND auto_generated = TRUE
      LIMIT 1
    `;
    const id = rows[0]?.id;
    if (id == null) return null;
    const n = Number(id);
    return Number.isFinite(n) ? n : null;
  } catch (err) {
    Sentry.captureException(err);
    return null;
  }
}

/**
 * Constant-time bearer-token check. Returns true on auth pass, false on
 * mismatch (caller responds 401). The check rejects empty/missing
 * configuration and uses timingSafeEqual to defeat timing oracles.
 */
function checkWebhookAuth(req: VercelRequest): boolean {
  const expected = optionalEnv('PERISCOPE_WEBHOOK_SECRET');
  if (!expected) {
    logger.error(
      'auto-playbook: PERISCOPE_WEBHOOK_SECRET not configured — rejecting all calls',
    );
    return false;
  }
  const header = req.headers.authorization ?? '';
  const expectedHeader = `Bearer ${expected}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expectedHeader);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/periscope-auto-playbook');

  if (req.method !== 'POST') {
    done({ status: 405 });
    return res.status(405).json({ error: 'POST only' });
  }

  if (!checkWebhookAuth(req)) {
    done({ status: 401 });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Rate limit defense-in-depth against a leaked Bearer token: max 30
  // calls/min/IP. The scraper fires at most 1/10min during RTH (~6/hr),
  // so 30 is generous for legitimate use but caps blast radius if the
  // secret leaks and an adversary tries to drive expensive Opus 4.7
  // xhigh calls in a loop.
  const rateLimited = await rejectIfRateLimited(
    req,
    res,
    'periscope-auto-playbook',
    30,
  );
  if (rateLimited) {
    done({ status: 429 });
    return;
  }

  // Kill switch — flip env var to 'false' to disable in 30s without redeploy.
  const enabled = optionalEnv('AUTO_PLAYBOOK_ENABLED') ?? 'true';
  if (enabled.toLowerCase() !== 'true') {
    Sentry.addBreadcrumb({
      category: 'auto-playbook',
      message: 'kill switch active — request rejected',
      level: 'warning',
    });
    done({ status: 503 });
    return res
      .status(503)
      .json({ error: 'auto-playbook disabled', killSwitch: true });
  }

  try {
    requireEnv('ANTHROPIC_API_KEY');
  } catch {
    done({ status: 500, error: 'missing_api_key' });
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    done({ status: 400 });
    return res.status(400).json({
      error: 'Invalid body',
      issues: parsed.error.issues,
    });
  }
  const body: ParsedBody = parsed.data;

  // RTH guard. The 2026-05-10 forensic audit found that a scraper TZ
  // bug stamped pre-market captures (03:30-10:00 CT) with RTH slot
  // labels, and the auto-playbook fired Claude reads on them — burning
  // ~$50 of API spend on stale UW panel data. Two layered checks
  // prevent recurrence:
  //   1. `capturedAt` wall-clock CT must be inside [08:30, 15:15] —
  //      catches stale-clock captures regardless of slot label. The
  //      upper bound includes a 15-minute post-close tail because the
  //      LAST_ANALYZABLE_SLOT ("14:50 - 15:00") is, by definition,
  //      captured AFTER 15:00 CT — the chart only labels that slot
  //      once the boundary has passed, so the scraper's next tick at
  //      ~15:05-15:10 CT is what observes it. A strict 15:00 ceiling
  //      rejected every debrief from 2026-05-08 onward (the user
  //      caught it 2026-05-13 — Mon/Tue/Wed all showed debrief=0).
  //   2. The slot label's END time must agree with `capturedAt` CT
  //      within ±10 min — catches misalignment between when the
  //      scraper ran and what UW's panel was actually showing. This
  //      already independently blocks the original stale-scrape case,
  //      so widening the wall-clock window doesn't reopen the hole.
  const capturedAtDate = new Date(body.capturedAt);
  if (Number.isNaN(capturedAtDate.getTime())) {
    done({ status: 400, error: 'bad_captured_at' });
    return res.status(400).json({
      error: 'capturedAt is not a valid ISO timestamp',
    });
  }
  const capturedCt = capturedAtToCt(capturedAtDate);
  const capturedMin = capturedCt.hour * 60 + capturedCt.minute;
  const isWeekend =
    capturedCt.weekday === 'Sat' || capturedCt.weekday === 'Sun';
  // 15:15 CT = 915 min. Allows the debrief slot's natural ~10-min
  // post-close capture lag without admitting next-day off-hours scrapes
  // (which would still be caught by the slot-label-end ±10min check).
  if (isWeekend || capturedMin < 8 * 60 + 30 || capturedMin > 15 * 60 + 15) {
    done({ status: 422 });
    return res.status(422).json({
      error: `capturedAt CT wall-clock ${capturedCt.hour}:${String(capturedCt.minute).padStart(2, '0')} is outside RTH (08:30-15:15 CT, Mon-Fri)`,
      slotKey: body.slotKey,
      capturedAt: body.capturedAt,
    });
  }
  const labelEnd = parseSlotEnd(body.slotKey);
  if (labelEnd != null) {
    const labelMin = labelEnd.hour * 60 + labelEnd.minute;
    if (Math.abs(labelMin - capturedMin) > 10) {
      done({ status: 422 });
      return res.status(422).json({
        error: `Slot label end (${labelEnd.hour}:${String(labelEnd.minute).padStart(2, '0')} CT) disagrees with capturedAt CT (${capturedCt.hour}:${String(capturedCt.minute).padStart(2, '0')}) by >10min — stale scrape rejected`,
        slotKey: body.slotKey,
        capturedAt: body.capturedAt,
      });
    }
  }

  // Mode derivation. Pre-market and post-close slots are stored by the
  // scraper but are not analyzable — we 422 so the scraper logs but does
  // not retry. The user explicitly only wants playbooks from the
  // 08:20-08:30 slot onward.
  const md = deriveMode(body.slotKey);
  if (md == null) {
    done({ status: 422 });
    return res.status(422).json({
      error: 'Slot is outside the analyzable window (08:20 CT – 14:50 CT)',
      slotKey: body.slotKey,
    });
  }
  const { mode, readTimeCt } = md;

  // Idempotency: if a row already exists for this (date, slot, auto), we
  // already accepted this webhook. Return 200 with the existing id —
  // safe for scraper retries on transient 5xx.
  const existingId = await findExistingRowId(body.tradingDate, body.capturedAt);
  if (existingId != null) {
    done({ status: 200 });
    return res.status(200).json({
      rowId: existingId,
      idempotent: true,
      mode,
    });
  }

  // Spot lookup at the slot's read_time. Uses the same DB lookup as the
  // manual chat handler.
  const utcMs = ctWallClockToUtcMs(body.tradingDate, readTimeCt);
  if (utcMs == null) {
    done({ status: 500 });
    return res.status(500).json({
      error: `Could not resolve read_time for ${body.tradingDate} ${readTimeCt}`,
    });
  }
  const readTimeIso = new Date(utcMs).toISOString();

  // 5-min tolerance: scraper webhook fires immediately after the slot
  // snapshot lands, racing `fetch-spx-candles-1m` (per-minute cron). The
  // 2-min default in manual chat assumed the user picks a time after
  // candles already exist; in the auto path the candle may still be
  // landing. 5 min covers the worst-case write lag without snapping to
  // an irrelevant bar.
  const spotLookup = await fetchSPXSpotAtTimestamp({
    date: body.tradingDate,
    time: readTimeCt,
    toleranceMin: 5,
    isLiveRead: false,
  }).catch((err: unknown) => {
    Sentry.captureException(err);
    logger.error(
      { err, tradingDate: body.tradingDate, readTimeCt },
      'auto-playbook: spot lookup threw',
    );
    return null;
  });
  if (spotLookup == null) {
    // No SPX candle yet — scraper webhook arrived before fetch-spx-candles-1m
    // wrote the bar. Return 422 so the scraper logs but doesn't retry; the
    // next 10-min tick will succeed.
    done({ status: 422 });
    return res.status(422).json({
      error: `No SPX candle for ${body.tradingDate} ${readTimeCt} CT within +/- 5 min`,
    });
  }

  const parentId = await resolveParentId(body.tradingDate);

  // Insert the in_progress placeholder row. Required NOT NULL columns
  // get safe placeholders that the runner's UPDATE overwrites. Required
  // structured fields default to all-null (no chart read yet).
  const inProgressRowId = await savePeriscopeAnalysis({
    capturedAt: new Date().toISOString(),
    tradingDate: body.tradingDate,
    readTime: readTimeIso,
    spotAtReadTime: spotLookup.price,
    spotSource: spotLookup.source,
    mode,
    parentId,
    userContext: null,
    imageUrls: {},
    proseText: '',
    fullResponse: { auto_playbook: 'in_progress' },
    embedding: null,
    structured: {
      spot: null,
      cone_lower: null,
      cone_upper: null,
      long_trigger: null,
      short_trigger: null,
      regime_tag: null,
      bias: null,
      trade_types_recommended: [],
      trade_types_avoided: [],
      key_levels: null,
      expected_dealer_behavior: null,
      confidence: null,
      confidence_basis: null,
      futures_plan: null,
    },
    parseOk: false,
    model: 'pending',
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    durationMs: 0,
    autoGenerated: true,
    slotCapturedAt: body.capturedAt,
    status: 'in_progress',
    failureReason: null,
    panelPayload: null,
  });

  if (inProgressRowId == null) {
    // Most likely cause: unique constraint violation from a race that
    // beat us between findExistingRowId and the INSERT. Re-check and
    // return 200 with the winner's id.
    const winnerId = await findExistingRowId(body.tradingDate, body.capturedAt);
    if (winnerId != null) {
      logger.warn(
        {
          rowId: winnerId,
          tradingDate: body.tradingDate,
          slotCapturedAt: body.capturedAt,
          mode,
        },
        'auto-playbook: unique-constraint race resolved — returning winner id',
      );
      Sentry.addBreadcrumb({
        category: 'auto-playbook',
        message: 'unique-constraint race resolved',
        level: 'info',
        data: { rowId: winnerId, slotCapturedAt: body.capturedAt },
      });
      done({ status: 200 });
      return res.status(200).json({
        rowId: winnerId,
        idempotent: true,
        mode,
        raceLoser: true,
      });
    }
    Sentry.captureMessage('auto-playbook: in_progress insert failed', {
      tags: {
        module: 'auto-playbook',
        stage: 'insert_failed',
        mode,
      },
    });
    done({ status: 500, error: 'insert_failed' });
    return res.status(500).json({ error: 'Failed to insert in_progress row' });
  }

  // Kick off the long-running runner via waitUntil. Vercel keeps the
  // function instance alive until this promise resolves; the response
  // is already flushed (202) so the scraper does not block.
  Sentry.setTag('auto_playbook.mode', mode);
  Sentry.setTag('auto_playbook.row_id', String(inProgressRowId));
  logger.info(
    {
      rowId: inProgressRowId,
      mode,
      tradingDate: body.tradingDate,
      capturedAt: body.capturedAt,
      slotKey: body.slotKey,
      parentId,
    },
    'auto-playbook: in_progress row inserted, kicking off runner',
  );

  waitUntil(
    runRunnerAndUpdate({
      rowId: inProgressRowId,
      mode,
      parentId,
      tradingDate: body.tradingDate,
      readTimeIso,
      spotAtReadTime: spotLookup.price,
    }),
  );

  done({ status: 202 });
  return res.status(202).json({
    rowId: inProgressRowId,
    status: 'in_progress',
    mode,
  });
}

/**
 * Fire the runner, write the outcome, never throw. Errors here can't be
 * surfaced to the scraper (response already flushed) so they go to
 * Sentry + Pino. The in_progress row stays in_progress in the worst case
 * — a Sentry alert + a stale "Claude thinking..." panel hint. The next
 * tick's call will overwrite or supplement it.
 */
async function runRunnerAndUpdate(args: {
  rowId: number;
  mode: PeriscopeMode;
  parentId: number | null;
  tradingDate: string;
  readTimeIso: string;
  spotAtReadTime: number;
}): Promise<void> {
  try {
    const outcome = await runPeriscopeAutoPlaybook({
      mode: args.mode,
      parentId: args.parentId,
      tradingDate: args.tradingDate,
      readTimeIso: args.readTimeIso,
      spotAtReadTime: args.spotAtReadTime,
    });

    const persisted = await completePeriscopeAnalysis(args.rowId, {
      status: outcome.status,
      proseText: outcome.prose,
      fullResponse: outcome.fullResponse,
      embedding: outcome.embedding,
      structured: outcome.structured,
      parseOk: outcome.parseOk,
      panelPayload: outcome.panelPayload,
      failureReason: outcome.failureReason,
      model: outcome.modelUsed,
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      cacheReadTokens: outcome.cacheReadTokens,
      cacheWriteTokens: outcome.cacheWriteTokens,
      durationMs: outcome.durationMs,
    });

    if (!persisted) {
      Sentry.captureMessage(
        'auto-playbook: completePeriscopeAnalysis returned false',
        {
          tags: {
            module: 'auto-playbook',
            stage: 'persist',
            mode: args.mode,
            row_id: String(args.rowId),
          },
        },
      );
    }

    logger.info(
      {
        rowId: args.rowId,
        mode: args.mode,
        status: outcome.status,
        durationMs: outcome.durationMs,
        modelUsed: outcome.modelUsed,
      },
      'auto-playbook: runner completed',
    );
  } catch (err) {
    Sentry.captureException(err, {
      tags: {
        module: 'auto-playbook',
        stage: 'runner_or_persist',
        mode: args.mode,
        row_id: String(args.rowId),
      },
    });
    logger.error(
      { err, rowId: args.rowId, mode: args.mode },
      'auto-playbook: runner threw — row left in_progress',
    );
  }
}
