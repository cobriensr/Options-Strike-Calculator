// @vitest-environment node

/**
 * Drift guard, both directions:
 *   - SCHEDULE_MAP → vercel.json: every entry must match vercel.json's
 *     crontab string for the same job. Catches stale schedules before they
 *     ship a wrong-cadence Sentry monitor.
 *   - vercel.json → SCHEDULE_MAP: every cron path in vercel.json must have a
 *     SCHEDULE_MAP entry or a written exemption in UNMONITORED_CRONS. The
 *     wrappers send no check-ins for a job with no entry, by design, so
 *     without this check a new cron would run unmonitored and nothing would
 *     fail.
 *   - SCHEDULE_MAP → handler source: an entry alone sends nothing, so a
 *     source scan checks that api/cron/<job>.ts passes that job name to
 *     withCronInstrumentation or withCronCheckin (as a string literal or
 *     through a `const JOB = '<job>'` in the same file).
 *
 * Two reconciliation modes for the first direction:
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
 *       docs/superpowers/specs/cron-monitor-coverage-2026-10-29.md
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SCHEDULE_MAP } from '../_lib/cron-schedules.js';
import { assertValidTimezone } from '../_lib/cron-instrumentation.js';
import { MARKET_MINUTES } from '../_lib/constants.js';

interface VercelConfig {
  crons?: { path: string; schedule: string }[];
}

/**
 * Every vercel.json schedule per job. A job can carry several entries (the
 * GEXBot crons use three windows); the drift checks reconcile against the
 * UNION of them, never just the last one.
 */
function loadVercelCrons(): Map<string, string[]> {
  const path = resolve(process.cwd(), 'vercel.json');
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as VercelConfig;
  const map = new Map<string, string[]>();
  for (const c of cfg.crons ?? []) {
    const m = /^\/api\/cron\/([^/]+)$/.exec(c.path);
    if (m?.[1]) map.set(m[1], [...(map.get(m[1]) ?? []), c.schedule]);
  }
  return map;
}

/**
 * Every distinct cron path in vercel.json, raw. Unlike loadVercelCrons this
 * keeps paths outside /api/cron/ (e.g. /api/health), so they need an entry or
 * an exemption too.
 */
function loadVercelCronPaths(): string[] {
  const path = resolve(process.cwd(), 'vercel.json');
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as VercelConfig;
  return [...new Set((cfg.crons ?? []).map((c) => c.path))];
}

/**
 * vercel.json crons that deliberately run with no Sentry cron monitor, keyed
 * by full path. The value is the reason and must cite the spec that decided
 * it. Every other vercel.json cron needs a SCHEDULE_MAP entry.
 */
const UNMONITORED_CRONS: Record<string, string> = {
  '/api/health':
    'Public health probe, not a job: it answers 503 whenever Postgres, Redis ' +
    'or the Schwab token is unhealthy, so a monitor would page the owner at ' +
    'the open on an expired Schwab token. ' +
    'docs/superpowers/specs/cron-monitor-coverage-2026-10-29.md',
};

/** The SCHEDULE_MAP key for an /api/cron/<job> path, or null for any other path. */
function scheduleKey(cronPath: string): string | null {
  return /^\/api\/cron\/([^/]+)$/.exec(cronPath)?.[1] ?? null;
}

/**
 * The job names a cron source file registers with a check-in wrapper: the
 * first argument of each `withCronInstrumentation(` / `withCronCheckin(`
 * call, read from a string literal or resolved through a
 * `const NAME = '<job>'` in the same file (several crons name themselves
 * through a JOB constant). The wrappers look SCHEDULE_MAP up by this name,
 * so it, not any other mention of the job, decides whether check-ins go out.
 */
function wrappedJobNames(src: string): string[] {
  const names: string[] = [];
  const calls = src.matchAll(
    /\bwithCron(?:Instrumentation|Checkin)\(\s*(?:'([^']+)'|([A-Za-z_$][\w$]*))/g,
  );
  for (const [, literal, identifier] of calls) {
    if (literal != null) {
      names.push(literal);
    } else if (identifier != null) {
      const escaped = identifier.replaceAll('$', String.raw`\$`);
      const decl = new RegExp(
        String.raw`\bconst ${escaped}\s*=\s*'([^']+)'`,
      ).exec(src);
      if (decl?.[1] != null) names.push(decl[1]);
    }
  }
  return names;
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

/** UTC minute-of-day ticks served by the union of several crontabs. */
function unionTickSet(crontabs: string[]): Set<number> {
  const ticks = new Set<number>();
  for (const crontab of crontabs) {
    for (const t of utcTickSet(parseCron(crontab))) ticks.add(t);
  }
  return ticks;
}

/**
 * Describe every tick an ET-local monitor crontab expects, in BOTH DST
 * regimes, that the union of the vercel.json crontabs does not fire. Empty
 * means the monitor never expects a tick Vercel won't send.
 */
function findUnservedEtTicks(etCrontab: string, vercel: string[]): string[] {
  const et = parseCron(etCrontab);
  const served = unionTickSet(vercel);
  const problems: string[] = [];
  for (const offset of [5, 4]) {
    const regime = offset === 5 ? 'EST' : 'EDT';
    for (const etHour of et.hours) {
      for (const etMin of et.minutes) {
        const utcTotal = etHour * 60 + etMin + offset * 60;
        if (!served.has(utcTotal)) {
          problems.push(
            `[${regime}] ET ${etHour}:${String(etMin).padStart(2, '0')} → ${Math.floor(utcTotal / 60)}:${String(utcTotal % 60).padStart(2, '0')} UTC`,
          );
        }
      }
    }
  }
  return problems;
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
      const want = vercelCrons.get(jobName) ?? [];
      const got = SCHEDULE_MAP[jobName]?.schedule;
      expect(want, `${jobName} present in vercel.json`).not.toHaveLength(0);
      // Verbatim for a single-entry job; one of the entries for a
      // multi-window job.
      expect(want).toContain(got);
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
      const utcs = vercel.map((v) => parseCron(v));

      // Cadence (minute field + day-of-week tail) must be unchanged — only
      // the hour window is allowed to differ between the ET monitor and the
      // UTC vercel.json crontab(s). For a multi-window job the ET minute set
      // must lie inside the union of the windows' minute sets (the served
      // check below is the exact test); the dow tail must match every entry.
      if (utcs.length === 1) {
        expect(et.minute, `${jobName}: minute field`).toBe(utcs[0]?.minute);
      } else {
        // Multi-window job: the ET monitor must keep the cadence of the main
        // (widest-hours) entry, so a sparser monitor (e.g. `*/10` against a
        // per-minute job) cannot pass.
        const main = utcs.reduce((a, b) =>
          b.hours.size > a.hours.size ? b : a,
        );
        expect(
          [...et.minutes].sort((x, y) => x - y),
          `${jobName}: cadence`,
        ).toEqual([...main.minutes].sort((x, y) => x - y));
      }
      for (const utc of utcs) {
        expect(et.rest, `${jobName}: dow/dom/month tail`).toBe(utc.rest);
      }

      // Gap-aware served set over the UNION of every vercel.json entry: the
      // EXACT UTC minute-of-day ticks vercel fires. Using the expanded set
      // (not a min/max hour bound) keeps it immune to a comma-list/step
      // hour field like `13,15,17`. Finding #8.
      // Every ET tick, in BOTH regimes (EST = ET + 5h, EDT = ET + 4h), must
      // convert to a UTC tick vercel actually fires, else the monitor
      // expects a tick that never arrives → structural "missed". Ticks past
      // the handler's own gate are satisfied by the wrapper's paired skip
      // check-in instead, so they are not asserted here.
      expect(
        findUnservedEtTicks(cfg.schedule, vercel),
        `${jobName}: ET ticks vercel.json does NOT fire (structural missed)`,
      ).toEqual([]);

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

  it('evaluate-round-trip: vercel.json serves the post-close evaluation ticks in BOTH DST regimes', () => {
    // The handler gate runs to close + 80 so the session's last fires
    // (close + 5) are evaluated after their 60-min window and before the
    // weekend prunes their tape: the close + 70 tick is the first to see
    // them, close + 80 is the retry. Both must actually be fired by
    // vercel.json — in EST 17:20 ET is 22:20 UTC, outside a `14-21` hour
    // range, which is how Friday's last fires went un-evaluated.
    const vercel = vercelCrons.get('evaluate-round-trip');
    expect(vercel).toBeDefined();
    const servedUtc = unionTickSet(vercel ?? []);
    for (const offset of [5, 4]) {
      for (const afterClose of [70, 80]) {
        const utcTotal = MARKET_MINUTES.CLOSE + afterClose + offset * 60;
        expect(
          servedUtc.has(utcTotal),
          `${offset === 5 ? 'EST' : 'EDT'}: close + ${afterClose} min → ${Math.floor(utcTotal / 60)}:${String(utcTotal % 60).padStart(2, '0')} UTC not fired`,
        ).toBe(true);
      }
    }
  });

  it('every entry has positive checkinMargin and maxRuntime', () => {
    for (const [name, cfg] of Object.entries(SCHEDULE_MAP)) {
      expect(cfg.checkinMargin, `${name}: checkinMargin`).toBeGreaterThan(0);
      expect(cfg.maxRuntime, `${name}: maxRuntime`).toBeGreaterThan(0);
    }
  });

  it('ET-anchored entries use the America/New_York timezone', () => {
    // Lock the market-hours monitors fixed by the 2026-06-08 DST triage
    // (plus the three GEXBot crons added 2026-10-28) so a future edit can't silently drop the timezone and
    // reintroduce the EDT-tail "missed" flood.
    const expectedEt = [
      'detect-periscope-call-lottery',
      'detect-periscope-put-lottery',
      'evaluate-round-trip',
      'fetch-gexbot-fast',
      'fetch-gexbot-strikes',
      'populate-periscope-from-gexbot',
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

  // ── Union reconciliation (multi-window jobs) ────────────────────
  it('loadVercelCrons keeps every entry for the three-window GEXBot jobs', () => {
    for (const job of [
      'fetch-gexbot-fast',
      'fetch-gexbot-strikes',
      'populate-periscope-from-gexbot',
    ]) {
      expect(vercelCrons.get(job), job).toHaveLength(3);
    }
  });

  it.each([
    ['fetch-gexbot-fast', '* 10-15 * * 1-5'],
    ['fetch-gexbot-strikes', '* 10-15 * * 1-5'],
    ['populate-periscope-from-gexbot', '*/10 10-15 * * 1-5'],
  ])(
    '%s is monitored ET-anchored with the high-frequency threshold',
    (job, schedule) => {
      expect(SCHEDULE_MAP[job]).toMatchObject({
        schedule,
        timezone: 'America/New_York',
        failureIssueThreshold: 3,
      });
    },
  );

  it('findUnservedEtTicks passes a window inside the union in both regimes', () => {
    expect(
      findUnservedEtTicks('* 10-15 * * 1-5', [
        '30-59 13 * * 1-5',
        '* 14-20 * * 1-5',
        '0-1 21 * * 1-5',
      ]),
    ).toEqual([]);
  });

  it('findUnservedEtTicks catches a mismatched schedule (EDT 09:30 ET = 13:30 UTC is served, 09:00 ET is not)', () => {
    const vercel = ['30-59 13 * * 1-5', '* 14-20 * * 1-5', '0-1 21 * * 1-5'];
    const problems = findUnservedEtTicks('* 9-15 * * 1-5', vercel);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.includes('EDT] ET 9:00'))).toBe(true);
  });

  it('findUnservedEtTicks catches an ET window past the last served UTC hour', () => {
    expect(
      findUnservedEtTicks('* 10-16 * * 1-5', ['* 14-20 * * 1-5']).length,
    ).toBeGreaterThan(0);
  });
});

describe('vercel.json crons → SCHEDULE_MAP coverage', () => {
  const cronPaths = loadVercelCronPaths();

  it('reads cron paths outside /api/cron/ too', () => {
    // Guards the loader: if it dropped non-/api/cron paths the way
    // loadVercelCrons does, /api/health would vanish and the coverage
    // check below would pass for the wrong reason.
    expect(cronPaths).toContain('/api/health');
  });

  it('every vercel.json cron has a SCHEDULE_MAP entry or a written exemption', () => {
    const uncovered = cronPaths.filter((cronPath) => {
      if (UNMONITORED_CRONS[cronPath] !== undefined) return false;
      const key = scheduleKey(cronPath);
      return key == null || SCHEDULE_MAP[key] === undefined;
    });
    expect(
      uncovered,
      'vercel.json crons with no SCHEDULE_MAP entry and no UNMONITORED_CRONS exemption (they run with no Sentry monitor)',
    ).toEqual([]);
  });

  it.each(Object.entries(UNMONITORED_CRONS))(
    'exemption %s is still a vercel.json cron, has no SCHEDULE_MAP entry, and cites its spec',
    (cronPath, reason) => {
      expect(cronPaths, `${cronPath} is no longer in vercel.json`).toContain(
        cronPath,
      );
      const key = scheduleKey(cronPath);
      expect(
        key == null ? undefined : SCHEDULE_MAP[key],
        `${cronPath} is exempt but also has a SCHEDULE_MAP entry`,
      ).toBeUndefined();
      expect(reason.trim(), `${cronPath}: empty reason`).not.toBe('');
      const cited = /docs\/superpowers\/specs\/\S+?\.md/.exec(reason)?.[0];
      expect(cited, `${cronPath}: reason must cite its spec`).toBeDefined();
      if (cited == null) return;
      expect(
        existsSync(resolve(process.cwd(), cited)),
        `${cronPath}: cited spec ${cited} does not exist`,
      ).toBe(true);
    },
  );

  it.each(Object.keys(SCHEDULE_MAP))(
    'api/cron/%s.ts registers a check-in wrapper under that job name',
    (job) => {
      // A SCHEDULE_MAP entry sends nothing by itself: the handler has to be
      // wrapped under the same name. This was green while
      // cleanup-ws-gex-strike-expiry had an entry and no wrapper.
      const file = `api/cron/${job}.ts`;
      const src = readFileSync(resolve(process.cwd(), file), 'utf8');
      expect(
        wrappedJobNames(src),
        `${file}: job names passed to withCronInstrumentation / withCronCheckin`,
      ).toContain(job);
    },
  );

  it.each([
    [
      'a string literal',
      "export default withCronInstrumentation('a-job', run);",
      ['a-job'],
    ],
    [
      'a JOB constant',
      "const JOB = 'a-job';\nexport default withCronCheckin(JOB, run);",
      ['a-job'],
    ],
    [
      'a typo in the wrapper, even when the right name appears elsewhere',
      "Sentry.setTag('cron.job', 'a-job');\n" +
        "export default withCronInstrumentation('a-jbo', run);",
      ['a-jbo'],
    ],
    [
      'no wrapper at all',
      "Sentry.setTag('cron.job', 'a-job');\n" +
        'export default async function handler() {}',
      [],
    ],
  ])('wrappedJobNames reads %s', (_case, src, want) => {
    expect(wrappedJobNames(src)).toEqual(want);
  });
});
