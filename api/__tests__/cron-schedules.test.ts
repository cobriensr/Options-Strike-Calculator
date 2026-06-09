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
  /** Lower bound of the hour range (e.g. `13-21` → 13, `* ` → 0). */
  hourLo: number;
  /** Upper bound of the hour range (e.g. `13-21` → 21, `*` → 23). */
  hourHi: number;
  rest: string;
}

/** Parse the minute + hour fields of a 5-field crontab. */
function parseCron(crontab: string): ParsedCron {
  const fields = crontab.trim().split(/\s+/);
  const minute = fields[0] ?? '';
  const hour = fields[1] ?? '*';
  const rest = fields.slice(2);
  let hourLo: number;
  let hourHi: number;
  if (hour === '*') {
    hourLo = 0;
    hourHi = 23;
  } else {
    const rangeMatch = /^(\d+)-(\d+)$/.exec(hour);
    if (rangeMatch?.[1] && rangeMatch[2]) {
      hourLo = Number.parseInt(rangeMatch[1], 10);
      hourHi = Number.parseInt(rangeMatch[2], 10);
    } else {
      // Comma list or single hour — take min/max of the listed hours.
      const hours = hour.split(',').map((h) => Number.parseInt(h, 10));
      hourLo = Math.min(...hours);
      hourHi = Math.max(...hours);
    }
  }
  return { minute, hourLo, hourHi, rest: rest.join(' ') };
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
    'ET-anchored schedule for %s stays inside vercel.json UTC window (both DST regimes)',
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

      // Every ET-local tick, converted to UTC, must land inside the
      // vercel.json UTC hour window in BOTH EST (UTC = ET + 5) and EDT
      // (UTC = ET + 4). If it didn't, the monitor would expect a tick
      // Vercel never fires → guaranteed false "missed".
      for (const offset of [5, 4]) {
        const utcLo = et.hourLo + offset;
        const utcHi = et.hourHi + offset;
        expect(
          utcLo,
          `${jobName}: ET ${et.hourLo}:00 = ${utcLo}:00 UTC (offset ${offset}) below vercel lo ${utc.hourLo}`,
        ).toBeGreaterThanOrEqual(utc.hourLo);
        expect(
          utcHi,
          `${jobName}: ET ${et.hourHi}:00 = ${utcHi}:00 UTC (offset ${offset}) above vercel hi ${utc.hourHi}`,
        ).toBeLessThanOrEqual(utc.hourHi);
      }
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
});
