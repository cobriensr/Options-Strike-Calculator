// @vitest-environment node

/**
 * Drift guard: every entry in SCHEDULE_MAP must match vercel.json's
 * crontab string for the same job. Catches stale schedules before they
 * ship a wrong-cadence Sentry monitor.
 *
 * Spec: docs/superpowers/specs/sentry-monitoring-2026-05-07.md
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

describe('cron-schedules SCHEDULE_MAP', () => {
  const vercelCrons = loadVercelCrons();

  it.each(Object.keys(SCHEDULE_MAP))(
    'schedule for %s matches vercel.json',
    (jobName) => {
      const want = vercelCrons.get(jobName);
      const got = SCHEDULE_MAP[jobName]?.schedule;
      expect(got).toBe(want);
    },
  );

  it('every entry has positive checkinMargin and maxRuntime', () => {
    for (const [name, cfg] of Object.entries(SCHEDULE_MAP)) {
      expect(cfg.checkinMargin, `${name}: checkinMargin`).toBeGreaterThan(0);
      expect(cfg.maxRuntime, `${name}: maxRuntime`).toBeGreaterThan(0);
    }
  });
});
