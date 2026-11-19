// @vitest-environment node

/**
 * The three backfill scripts that call the sidecar's /archive/* routes
 * (backfill-day-embeddings, backfill-day-features, backfill-day-ohlc) check
 * SIDECAR_TAKEIT_SECRET once at startup, with the other required config. The
 * scripts run on import, so a child process is the only way to see what they
 * do. A bare exit code of 1 would not tell a startup stop from the per-chunk
 * failures every chunk would log if the check were missing (each script
 * catches a chunk's error, counts it and carries on), so the checks below
 * also count the message and look for the completion banner.
 *
 * No script loads .env.local itself (they are run as
 * `source .env.local && node ...`), and each child gets an explicit
 * environment: the parent's, minus the secret, with the sidecar and database
 * pointed at a closed loopback port, so no real value can reach a child.
 */

import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { CHILD_TEST_TIMEOUT, spawnChild } from './spawn-timeout.fixtures.mjs';

// Every test spawns node through spawnChild (see spawn-timeout.fixtures.mjs):
// the child's limit is below the test's.
vi.setConfig({ testTimeout: CHILD_TEST_TIMEOUT });

const SCRIPTS = [
  'backfill-day-embeddings.mjs',
  'backfill-day-features.mjs',
  'backfill-day-ohlc.mjs',
];

const NOT_SET = 'SIDECAR_TAKEIT_SECRET is not set';

/**
 * Run a script as a child. The default range holds six 6-month chunks, so a
 * script that reached its chunk loop would log the message six times.
 */
function run(file, overrides = {}) {
  const env = { ...process.env };
  delete env.SIDECAR_TAKEIT_SECRET;
  // A coverage run would have the child write coverage files into the
  // parent's run.
  delete env.NODE_V8_COVERAGE;
  return spawnChild(
    process.execPath,
    [path.resolve(process.cwd(), 'scripts', file)],
    {
      env: {
        ...env,
        SIDECAR_URL: 'http://127.0.0.1:9',
        DATABASE_URL: 'postgres://u:p@127.0.0.1:9/db',
        OPENAI_API_KEY: 'test-key-not-real',
        BACKFILL_START: '2020-01-01',
        BACKFILL_END: '2022-12-31',
        ...overrides,
      },
      encoding: 'utf8',
    },
  );
}

describe('the backfill scripts that call the sidecar archive', () => {
  it.each(SCRIPTS)(
    '%s stops once at startup when SIDECAR_TAKEIT_SECRET is unset',
    (file) => {
      const result = run(file);

      expect(result.status, result.stderr).toBe(1);
      // Once: a script that reached its chunk loop would log it per chunk.
      expect(result.stderr.split(NOT_SET)).toHaveLength(2);
      // Neither the banner of main() nor the completion summary.
      expect(result.stdout).not.toContain('Backfill');
    },
  );

  it.each(SCRIPTS)(
    '%s gets past the startup check when SIDECAR_TAKEIT_SECRET is set',
    (file) => {
      // An empty range: main() prints its banner and no chunk is fetched. It
      // then fails on the database count (a closed loopback port), which is
      // not what is checked here.
      const result = run(file, {
        SIDECAR_TAKEIT_SECRET: 'test-bearer-not-real',
        BACKFILL_START: '2022-01-01',
        BACKFILL_END: '2021-12-31',
      });

      expect(result.stderr).not.toContain(NOT_SET);
      expect(result.stdout).toContain('Backfilling');
    },
  );
});
