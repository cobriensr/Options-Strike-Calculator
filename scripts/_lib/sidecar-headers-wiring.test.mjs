// @vitest-environment node

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The archive scripts are top-level programs (they read env and exit at
 * import), so they can't be imported here. This reads their source instead:
 * a script that calls the sidecar's /archive/* routes must import the
 * helper and pass it on every such call.
 */
describe('scripts that call the sidecar archive', () => {
  // vitest runs from the repo root (same convention as eslint-api-guard.test.mjs).
  const scriptsDir = path.join(process.cwd(), 'scripts');
  // Any template variable, so a script that names its base URL differently
  // is still caught.
  const ARCHIVE_CALL = /\$\{\w+\}\/archive\//g;
  const HEADERS_ARG = /headers: sidecarArchiveHeaders\(\)/g;

  const callers = readdirSync(scriptsDir)
    .filter((name) => /\.(mjs|mts|ts|js)$/.test(name))
    .map((name) => ({
      name,
      source: readFileSync(path.join(scriptsDir, name), 'utf8'),
    }))
    .filter(({ source }) => source.match(ARCHIVE_CALL));

  it('finds the archive scripts, so the checks below are not vacuous', () => {
    expect(callers.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'backfill-day-embeddings.mjs',
        'backfill-day-features.mjs',
        'backfill-day-ohlc.mjs',
        'compare-analog-backends.mjs',
      ]),
    );
  });

  it.each(callers.map(({ name }) => [name]))(
    '%s imports the helper',
    (name) => {
      const source = callers.find((c) => c.name === name).source;
      expect(source).toContain(
        "import { sidecarArchiveHeaders } from './_lib/sidecar-headers.mjs';",
      );
    },
  );

  it.each(callers.map(({ name }) => [name]))(
    '%s passes the headers on every archive call',
    (name) => {
      const source = callers.find((c) => c.name === name).source;
      expect(source.match(HEADERS_ARG)?.length ?? 0).toBeGreaterThanOrEqual(
        source.match(ARCHIVE_CALL).length,
      );
    },
  );
});
