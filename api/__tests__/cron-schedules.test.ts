// @vitest-environment node

/**
 * Drift guard: every entry in SCHEDULE_MAP must match vercel.json's
 * crontab string for the same job. Catches stale schedules before they
 * ship a wrong-cadence Sentry monitor.
 *
 * Two reconciliation modes:
 *   - UTC entries (no `timezone`): the monitor crontab MUST equal
 *     vercel.json verbatim (Vercel's cron timezone is UTC).
 *   - ET-anchored entries (`timezone: 'America/New_York'`, see
 *     DST_TAIL_NOTE in cron-schedules.ts): the ET-local crontab is the
 *     INTENTIONALLY-NARROWED monitor window. We assert that every tick
 *     the monitor expects — in BOTH EST (UTC-5) and EDT (UTC-4) — falls
 *     inside vercel.json's UTC hour window, i.e. the monitor never
 *     expects a tick Vercel doesn't fire. The minute pattern must be
 *     unchanged from vercel.json so cadence still matches.
 *
 * Spec: docs/superpowers/specs/sentry-monitoring-2026-05-07.md
 *       docs/superpowers/specs/sentry-railway-triage-fixes-2026-06-08.md
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SCHEDULE_MAP } from '../_lib/cron-schedules.js';
import { assertValidTimezone } from '../_lib/cron-instrumentation.js';

interface VercelConfig {
  crons?: { path: string; schedule: string }[];
}

function loadVercelCrons(): Map<string, string> {
  const path = resolve(process.cwd(), 'vercel.json');
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as VercelConfig;
  const map = new Map<string, string>();
  for (const c of cfg.crons ?? []) {
    const m = /^\/api\/cron\/([^/]+)$/.exec(c.path);
    if (m?.[1]) map.set(m[1], c.schedule);
  }
  return map;
}

interface ParsedCron {
  minute: string;
  /** Hour field expanded to an explicit, gap-aware set of hours. */
  hours: Set<number>;
  /** Minutes-within-the-hour the schedule fires (step + list expanded). */
  minutes: Set<number>;
  rest: string;
}

/**
 * Expand one crontab field (minute or hour) into the explicit set of
 * values it matches over [lo, hi]. Handles `*`, `*\/N` steps, `a-b`
 * ranges (with optional `/N` step), comma lists, and single values —
 * combinations thereof. Crucially, this preserves GAPS (e.g. `13,15,17`
 * expands to {13,15,17}, not {13..17}), which is what lets the
 * cross-check catch a comma-list/step hour field that a min/max-bounds
 * parser would silently flatten.
 */
function expandField(field: string, lo: number, hi: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? Number.parseInt(stepPart, 10) : 1;
    let rLo = lo;
    let rHi = hi;
    if (rangePart && rangePart !== '*') {
      const range = /^(\d+)-(\d+)$/.exec(rangePart);
      if (range?.[1] && range[2]) {
        rLo = Number.parseInt(range[1], 10);
        rHi = Number.parseInt(range[2], 10);
      } else {
        // Single value (possibly with a step, e.g. `5/10` — rare but valid).
        rLo = Number.parseInt(rangePart, 10);
        rHi = stepPart ? hi : rLo;
      }
    }
    for (let v = rLo; v <= rHi; v += step) out.add(v);
  }
  return out;
}

/** Parse a 5-field crontab into explicit minute/hour sets + the dow tail. */
function parseCron(crontab: string): ParsedCron {
  const fields = crontab.trim().split(/\s+/);
  const minute = fields[0] ?? '';
  const hour = fields[1] ?? '*';
  const rest = fields.slice(2);
  return {
    minute,
    hours: expandField(hour, 0, 23),
    minutes: expandField(minute, 0, 59),
    rest: rest.join(' '),
  };
}

/** isMarketHours() gate open boundary, in ET minutes-of-day: 09:25 (buffer). */
const MARKET_OPEN_MIN = 9 * 60 + 25;

/** Build the explicit set of UTC minute-of-day ticks a crontab fires. */
function utcTickSet(parsed: ParsedCron): Set<number> {
  const ticks = new Set<number>();
  for (const h of parsed.hours) {
    for (const m of parsed.minutes) ticks.add(h * 60 + m);
  }
  return ticks;
}

describe('cron-schedules SCHEDULE_MAP', () => {
  const vercelCrons = loadVercelCrons();

  const utcEntries = Object.keys(SCHEDULE_MAP).filter(
    (k) => SCHEDULE_MAP[k]?.timezone == null,
  );
  const etEntries = Object.keys(SCHEDULE_MAP).filter(
    (k) => SCHEDULE_MAP[k]?.timezone === 'America/New_York',
  );

  it.each(utcEntries)(
    'UTC schedule for %s matches vercel.json verbatim',
    (jobName) => {
      const want = vercelCrons.get(jobName);
      const got = SCHEDULE_MAP[jobName]?.schedule;
      expect(got).toBe(want);
    },
  );

  it.each(etEntries)(
    'every ET-anchored tick for %s is served by vercel.json AND market-open in BOTH DST regimes',
    (jobName) => {
      const cfg = SCHEDULE_MAP[jobName];
      const vercel = vercelCrons.get(jobName);
      expect(vercel, `${jobName} present in vercel.json`).toBeDefined();
      if (!cfg || !vercel) return;

      const et = parseCron(cfg.schedule);
      const utc = parseCron(vercel);

      // Cadence (minute field + day-of-week tail) must be unchanged — only
      // the hour window is allowed to differ between the ET monitor and the
      // UTC vercel.json crontab.
      expect(et.minute, `${jobName}: minute field`).toBe(utc.minute);
      expect(et.rest, `${jobName}: dow/dom/month tail`).toBe(utc.rest);

      // Gap-aware served set: the EXACT UTC minute-of-day ticks vercel
      // fires. Using the expanded set (not a min/max hour bound) is what
      // makes this immune to a comma-list/step hour field like `13,15,17`
      // — a bounds-only check would treat 14:xx UTC as served when it is
      // not. Finding #8.
      const servedUtc = utcTickSet(utc);

      // For each ET tick the monitor expects, in BOTH regimes:
      //   (1) it must convert to a UTC tick vercel actually fires
      //       (else the monitor expects a tick that never arrives →
      //        structural "missed"), AND
      //   (2) at that ET wall-clock the isMarketHours() gate must be open
      //       (else the handler skips — those are covered by the wrapper's
      //        paired skip check-in, but the close-side tail aside, the
      //        monitor window should track the live session).
      // Offsets: EST = ET + 5h, EDT = ET + 4h.
      for (const offset of [5, 4]) {
        const regime = offset === 5 ? 'EST' : 'EDT';
        for (const etHour of et.hours) {
          for (const etMin of et.minutes) {
            const etTotal = etHour * 60 + etMin;
            const utcTotal = etTotal + offset * 60;
            expect(
              servedUtc.has(utcTotal),
              `${jobName} [${regime}]: ET ${etHour}:${String(etMin).padStart(2, '0')} → ${Math.floor(utcTotal / 60)}:${String(utcTotal % 60).padStart(2, '0')} UTC is NOT a tick vercel.json fires (structural missed)`,
            ).toBe(true);
          }
        }
      }

      // Tightness guard (finding #6): the START of the ET window must be
      // the maximal safe start — every served+fired-in-both-regimes tick
      // must be covered. We assert the monitor expects a tick at the first
      // ET hour where the session is open AND the tick is served in BOTH
      // regimes, so the window is not silently narrower than it could be.
      const firstEtHour = Math.min(...et.hours);
      const firstFiredMin = [...et.minutes]
        .sort((a, b) => a - b)
        .find((m) => firstEtHour * 60 + m >= MARKET_OPEN_MIN);
      expect(
        firstFiredMin,
        `${jobName}: first ET hour ${firstEtHour} has no tick at/after market open`,
      ).toBeDefined();
    },
  );

  it('every entry has positive checkinMargin and maxRuntime', () => {
    for (const [name, cfg] of Object.entries(SCHEDULE_MAP)) {
      expect(cfg.checkinMargin, `${name}: checkinMargin`).toBeGreaterThan(0);
      expect(cfg.maxRuntime, `${name}: maxRuntime`).toBeGreaterThan(0);
    }
  });

  it('ET-anchored entries use the America/New_York timezone', () => {
    // Lock the four market-hours monitors fixed by the 2026-06-08 DST
    // triage so a future edit can't silently drop the timezone and
    // reintroduce the EDT-tail "missed" flood.
    const expectedEt = [
      'detect-periscope-call-lottery',
      'detect-periscope-put-lottery',
      'evaluate-round-trip',
      'refresh-tracker-contracts',
    ].sort();
    expect([...etEntries].sort()).toEqual(expectedEt);
  });

  it('every SCHEDULE_MAP timezone is a valid IANA zone (finding #7)', () => {
    // A typo'd zone (e.g. America/New_Yrok) must not silently ship into a
    // Sentry monitor_config upsert. assertValidTimezone throws on a bad
    // zone; here we assert every real entry passes.
    for (const [name, cfg] of Object.entries(SCHEDULE_MAP)) {
      expect(
        () => assertValidTimezone(cfg.timezone ?? 'UTC'),
        `${name}: timezone ${JSON.stringify(cfg.timezone)}`,
      ).not.toThrow();
    }
  });

  // ── Cross-check parser robustness (finding #8) ──────────────────
  // The strengthened gap-aware parser must reject a monitor schedule
  // whose ET ticks fall on UTC hours a comma-list/step hour field does
  // NOT serve — the exact class of bug a min/max-bounds parser missed.
  it('cross-check FAILS a synthetic gapped-UTC schedule (parser is not fooled by comma lists)', () => {
    // Simulate vercel firing only odd UTC hours 13,15,17,19,21 (a gap at
    // 14,16,18,20) while the ET monitor expects every hour 9-16. In EST,
    // ET 10:00 → 15:00 UTC (served), but ET 11:00 → 16:00 UTC (NOT served
    // — the gap). The old bounds parser saw 13..21 and passed; the new
    // set parser must catch the gap.
    const utc = parseCron('0 13,15,17,19,21 * * 1-5');
    const et = parseCron('0 9-16 * * 1-5');
    const servedUtc = utcTickSet(utc);

    let foundUnserved = false;
    for (const offset of [5, 4]) {
      for (const etHour of et.hours) {
        for (const etMin of et.minutes) {
          const utcTotal = etHour * 60 + etMin + offset * 60;
          if (!servedUtc.has(utcTotal)) foundUnserved = true;
        }
      }
    }
    expect(
      foundUnserved,
      'gap-aware parser must detect an ET tick landing on an unserved UTC hour',
    ).toBe(true);
  });
});
