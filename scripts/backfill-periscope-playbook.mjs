#!/usr/bin/env node

/**
 * Backfill historical Periscope auto-playbooks against existing
 * periscope_snapshots data.
 *
 * Phase 5 of docs/superpowers/specs/periscope-auto-playbook-2026-05-10.md.
 *
 * # Why this script exists (and why it isn't run yet)
 *
 * When the auto-playbook architecture went live on 2026-05-10, the
 * forward path (Phase 2b–4) started producing one Claude playbook per
 * 10-min scraper tick from Monday onward. That gives you fresh data
 * starting at deploy time but leaves the ~125 trading days of
 * pre-existing periscope_snapshots history (Nov 2025 – May 2026)
 * without any Claude analysis.
 *
 * This script is the dormant Phase 5 deliverable that retroactively
 * fires the auto-playbook against every analyzable historical slot.
 * After it runs, you have ~4,800 historical playbook entries in
 * `periscope_analyses` with `auto_generated=true`, browsable via
 * PeriscopeChatHistory and queryable for retrieval / calibration
 * grounding.
 *
 * # Cost expectations (re-estimated 2026-05-10)
 *
 *   Per call: ~37K input tokens (~$0.11 raw, ~$0.011 with 90% prompt
 *             cache hit) + ~5K output tokens (~$0.075). Embedding adds
 *             ~$0.0005 per call (text-embedding-3-large, ~300 tokens).
 *   Per call total: $0.09 cached / $0.19 uncached.
 *   Full backfill (~125 days × ~39 analyzable slots = 4,875 calls):
 *     $440 with prompt cache (default — the runner already wires
 *           cache_control on the skill + references blocks)
 *     $930 without cache
 *
 * Prompt caching is wired by api/_lib/periscope-chat-runner.ts —
 * confirm it's still active before invoking by checking that
 * runCachedAnthropicCall sets cache_control: 'ephemeral' on the
 * stable system prefix.
 *
 * # When to run this
 *
 * Run when you want immediate browsable history rather than waiting
 * weeks for forward-firing playbooks to accumulate. Concretely:
 *
 *  - You're ready to spend ~$440-$930 once
 *  - You want the autoresearch loop (prompt-tuning, separate spec)
 *    to have labeled training data on day one
 *  - You want the calibration block + retrieval queries on live
 *    playbooks to ground against months of past entries instead of
 *    a few days of post-deploy forward data
 *  - The scraper is healthy and periscope_snapshots is dense for
 *    the date range you want to backfill — verify with
 *    `scripts/audit-periscope-scraper.py` first
 *
 * # How to invoke
 *
 *   # 1. Pull the env secret without leaking to shell history
 *   read -rs -p "PERISCOPE_WEBHOOK_SECRET: " PERISCOPE_WEBHOOK_SECRET
 *   echo
 *   export PERISCOPE_WEBHOOK_SECRET
 *   export VERCEL_BASE_URL=https://theta-options.com
 *   source .env.local   # for DATABASE_URL only
 *
 *   # 2. Dry run — counts slots, prints cost estimate, no calls fired
 *   node scripts/backfill-periscope-playbook.mjs --dry-run
 *
 *   # 3. Full run (overnight, ~1-2 hours wall clock at default settings)
 *   node scripts/backfill-periscope-playbook.mjs
 *
 *   # 4. Narrower range — e.g. just the last month
 *   BACKFILL_START=2026-04-08 BACKFILL_END=2026-05-08 \
 *     node scripts/backfill-periscope-playbook.mjs
 *
 *   # 5. Preserve parent_id chains within each day at the cost of
 *   #    runtime — wait WITHIN_DAY_DELAY_MS between slots so each
 *   #    Claude call has time to complete before the next slot's
 *   #    parent lookup runs. Default 0 (fast, parents mostly null);
 *   #    600000 (10 min) is the Claude thinking budget and lets
 *   #    chains form cleanly.
 *   WITHIN_DAY_DELAY_MS=600000 \
 *     node scripts/backfill-periscope-playbook.mjs
 *
 * # Trade-offs the script makes
 *
 *  - **Idempotent**: the auto-playbook endpoint returns 200 with
 *    `idempotent:true` when a row already exists for
 *    (trading_date, slot_captured_at, auto_generated=true). Re-runs
 *    are safe; the script logs "skipped" for those and moves on.
 *  - **Skips current trading_date**: avoids racing live forward-
 *    firing. If you're running during RTH, that day's slots are
 *    handled by the scraper instead.
 *  - **Parent chains are best-effort**: with the default
 *    WITHIN_DAY_DELAY_MS=0, slots fire faster than Claude can
 *    complete, so most intraday rows will land with parent_id=null.
 *    The pre_trade row of each day always lands with parent=null by
 *    design, so the loss is on intraday chains specifically. Set
 *    WITHIN_DAY_DELAY_MS=600000 to preserve chains at ~10x runtime.
 *  - **Cross-day concurrency**: 2 days in flight at once. Within a
 *    day always sequential (so intra-day parent chain semantics
 *    work IF the delay is set).
 *  - **Retries**: 1 retry on 5xx / network error after 5s delay.
 *    4xx (except 422) is no-retry — auth or contract issue won't
 *    fix itself.
 *
 * # What gets backfilled
 *
 * Every distinct `(captured_at, timeframe)` tuple in
 * `periscope_snapshots` for the date range, EXCEPT:
 *   - Pre-market and post-close slots — the endpoint returns 422 for
 *     slots outside `08:20 - 08:30` through `14:50 - 15:00` CT.
 *     We don't pre-filter; we just let the endpoint reject them.
 *   - Slots already with an auto_generated=true row in
 *     periscope_analyses (idempotency).
 *
 * # Required env vars
 *
 *   DATABASE_URL              — Neon Postgres
 *   PERISCOPE_WEBHOOK_SECRET  — same value as Vercel + Railway
 *   VERCEL_BASE_URL           — e.g. https://theta-options.com
 *
 * # Optional env vars
 *
 *   BACKFILL_START          — YYYY-MM-DD, default 2025-11-10
 *   BACKFILL_END            — YYYY-MM-DD, default yesterday CT
 *   WITHIN_DAY_DELAY_MS     — int, default 0
 *   CROSS_DAY_CONCURRENCY   — int, default 2 (max parallel days)
 *   DRY_RUN                 — set to "1" to count + estimate only
 */

import process from 'node:process';
import { neon } from '@neondatabase/serverless';

// ── Config ─────────────────────────────────────────────────────────

const DATABASE_URL = required('DATABASE_URL');
const WEBHOOK_SECRET = required('PERISCOPE_WEBHOOK_SECRET');
const VERCEL_BASE_URL = stripTrailingSlashes(required('VERCEL_BASE_URL'));

/**
 * Strip trailing slashes without a regex. sonarjs/slow-regex flags
 * /\/+$/ as ReDoS-vulnerable even though the input is trusted env;
 * a plain loop satisfies the rule without an inline disable.
 */
function stripTrailingSlashes(s) {
  let i = s.length;
  while (i > 0 && s.charAt(i - 1) === '/') i -= 1;
  return s.slice(0, i);
}

const BACKFILL_START = (process.env.BACKFILL_START ?? '2025-11-10').trim();
const BACKFILL_END = (process.env.BACKFILL_END ?? yesterdayCtIso()).trim();
const WITHIN_DAY_DELAY_MS = Number.parseInt(
  process.env.WITHIN_DAY_DELAY_MS ?? '0',
  10,
);
const CROSS_DAY_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.CROSS_DAY_CONCURRENCY ?? '2', 10),
);
const DRY_RUN = process.env.DRY_RUN === '1';
const IS_DRY_RUN_FLAG = process.argv.includes('--dry-run');
const DRY = DRY_RUN || IS_DRY_RUN_FLAG;

const ENDPOINT = `${VERCEL_BASE_URL}/api/periscope-auto-playbook`;
const RETRY_BACKOFF_MS = 5_000;
const PER_REQUEST_TIMEOUT_MS = 8_000;

function required(name) {
  const v = process.env[name];
  if (v == null || v.trim() === '') {
    console.error(`ERROR: missing required env var ${name}`);
    process.exit(1);
  }
  return v.trim();
}

function yesterdayCtIso() {
  const now = new Date();
  // CT is UTC-5 (CDT) or UTC-6 (CST). Use Intl with America/Chicago.
  const ctFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const todayCt = ctFmt.format(now);
  const [y, m, d] = todayCt.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - 1));
  return ctFmt.format(dt);
}

function todayCtIso() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

// ── DB helpers ─────────────────────────────────────────────────────

const sql = neon(DATABASE_URL);

/**
 * Pull distinct (trading_date, captured_at, timeframe) tuples from
 * periscope_snapshots for the range, EXCLUDING slots that already
 * have an auto-generated playbook row. Returns rows grouped by
 * trading_date with slots sorted ascending.
 */
async function loadPendingSlots() {
  const todayCt = todayCtIso();
  const rows = await sql`
    SELECT
      (s.captured_at AT TIME ZONE 'America/Chicago')::date AS trading_date,
      s.captured_at,
      s.timeframe
    FROM periscope_snapshots s
    WHERE s.panel = 'gamma'
      AND s.timeframe IS NOT NULL
      AND (s.captured_at AT TIME ZONE 'America/Chicago')::date
          BETWEEN ${BACKFILL_START}::date AND ${BACKFILL_END}::date
      AND (s.captured_at AT TIME ZONE 'America/Chicago')::date < ${todayCt}::date
      AND NOT EXISTS (
        SELECT 1 FROM periscope_analyses a
        WHERE a.auto_generated = TRUE
          AND a.slot_captured_at = s.captured_at
      )
    GROUP BY trading_date, s.captured_at, s.timeframe
    ORDER BY trading_date ASC, s.captured_at ASC
  `;

  // Group by trading_date.
  const byDay = new Map();
  for (const r of rows) {
    const day =
      r.trading_date instanceof Date
        ? r.trading_date.toISOString().slice(0, 10)
        : String(r.trading_date).slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({
      capturedAt:
        r.captured_at instanceof Date
          ? r.captured_at.toISOString()
          : String(r.captured_at),
      slotKey: String(r.timeframe),
    });
  }
  return byDay;
}

// ── Webhook helpers ────────────────────────────────────────────────

async function postOneSlot({ tradingDate, capturedAt, slotKey }) {
  const body = JSON.stringify({ tradingDate, capturedAt, slotKey });
  const headers = {
    Authorization: `Bearer ${WEBHOOK_SECRET}`,
    'Content-Type': 'application/json',
  };

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PER_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers,
        body,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      // 202 (in_progress kicked off) and 200 (idempotent skip) are both
      // success. 422 means the endpoint intentionally skipped (pre-market
      // / post-close / missing SPX candle) — not a retryable failure.
      if (res.ok || res.status === 422) {
        return { ok: true, status: res.status, attempts: attempt };
      }
      const errText = await res.text().catch(() => '');
      if (res.status >= 400 && res.status < 500) {
        return {
          ok: false,
          status: res.status,
          attempts: attempt,
          error: errText.slice(0, 200),
        };
      }
      // 5xx — retry once
      if (attempt < 2) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      return {
        ok: false,
        status: res.status,
        attempts: 2,
        error: errText.slice(0, 200),
      };
    } catch (err) {
      clearTimeout(timer);
      if (attempt < 2) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      return {
        ok: false,
        status: null,
        attempts: 2,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      };
    }
  }
  return { ok: false, status: null, attempts: 2, error: 'unreachable' };
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Per-day worker ─────────────────────────────────────────────────

async function processDay({ tradingDate, slots, totals }) {
  const dayStart = Date.now();
  let dayOk = 0;
  let daySkipped = 0;
  let dayFailed = 0;

  for (let i = 0; i < slots.length; i += 1) {
    const slot = slots[i];
    const result = await postOneSlot({ tradingDate, ...slot });
    if (result.ok) {
      if (result.status === 200) {
        daySkipped += 1;
        totals.skipped += 1;
      } else if (result.status === 422) {
        daySkipped += 1;
        totals.skipped422 += 1;
      } else {
        dayOk += 1;
        totals.ok += 1;
      }
    } else {
      dayFailed += 1;
      totals.failed += 1;
      console.error(
        `  ✗ ${tradingDate} ${slot.slotKey} → ${result.status ?? 'network'} ${
          result.error ?? ''
        }`,
      );
    }
    if (WITHIN_DAY_DELAY_MS > 0 && i < slots.length - 1) {
      await sleep(WITHIN_DAY_DELAY_MS);
    }
  }

  console.log(
    `  ✓ ${tradingDate}: ${dayOk} fired / ${daySkipped} skipped / ` +
      `${dayFailed} failed in ${Math.round((Date.now() - dayStart) / 1000)}s`,
  );
}

// ── Cross-day concurrency pool ─────────────────────────────────────

async function runWithConcurrency(items, worker, concurrency) {
  const queue = [...items];
  const running = new Set();

  async function spawn() {
    if (queue.length === 0) return;
    const item = queue.shift();
    const promise = worker(item)
      .catch((err) => {
        console.error(`day worker threw:`, err);
      })
      .finally(() => {
        running.delete(promise);
      });
    running.add(promise);
  }

  while (queue.length > 0 || running.size > 0) {
    while (running.size < concurrency && queue.length > 0) {
      await spawn();
    }
    if (running.size > 0) {
      await Promise.race(running);
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Periscope Auto-Playbook Historical Backfill');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  endpoint:               ${ENDPOINT}`);
  console.log(`  date range:             ${BACKFILL_START} → ${BACKFILL_END}`);
  console.log(`  cross-day concurrency:  ${CROSS_DAY_CONCURRENCY}`);
  console.log(`  within-day delay:       ${WITHIN_DAY_DELAY_MS} ms`);
  console.log(`  dry run:                ${DRY ? 'YES' : 'no'}`);
  console.log('');

  console.log('▸ Querying periscope_snapshots for pending slots…');
  const byDay = await loadPendingSlots();
  const dayCount = byDay.size;
  let slotCount = 0;
  for (const slots of byDay.values()) slotCount += slots.length;

  console.log(`  ${dayCount} days × ${slotCount} total slots pending`);
  if (slotCount === 0) {
    console.log('▸ Nothing to backfill. Exiting.');
    return;
  }

  // Rough cost estimate (cached input + full output + embedding).
  const cachedCostPerCall = 0.09;
  const uncachedCostPerCall = 0.19;
  console.log('');
  console.log(`  Cost estimate (forward-firing endpoint, prompt cache on):`);
  console.log(
    `    cached:    $${(slotCount * cachedCostPerCall).toFixed(0)}`,
  );
  console.log(
    `    uncached:  $${(slotCount * uncachedCostPerCall).toFixed(0)}`,
  );
  console.log('');

  if (DRY) {
    console.log('▸ Dry run — no calls fired. Set DRY_RUN=0 (or omit) to run.');
    return;
  }

  const totals = { ok: 0, skipped: 0, skipped422: 0, failed: 0 };
  const startedAt = Date.now();
  const days = [...byDay.entries()].map(([tradingDate, slots]) => ({
    tradingDate,
    slots,
  }));

  console.log(`▸ Firing webhook for ${days.length} days…`);
  await runWithConcurrency(
    days,
    (day) => processDay({ ...day, totals }),
    CROSS_DAY_CONCURRENCY,
  );

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Done in ${elapsedSec}s (${(elapsedSec / 60).toFixed(1)}m)`);
  console.log(`  fired:        ${totals.ok}`);
  console.log(`  idempotent:   ${totals.skipped}`);
  console.log(`  out-of-range: ${totals.skipped422}`);
  console.log(`  failed:       ${totals.failed}`);
  console.log('═══════════════════════════════════════════════════════════');

  if (totals.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
