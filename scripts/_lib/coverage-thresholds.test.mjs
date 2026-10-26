// @vitest-environment node
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';
import config from '../../vite.config.ts';

/**
 * Guard for the per-folder coverage floors in vite.config.ts.
 *
 * vitest checks each glob key in coverage.thresholds as an aggregate over the
 * files it matches. A key that matches nothing passes silently forever: the
 * empty map's summary pct is 'Unknown', and `'Unknown' < 84` is false. So a
 * folder rename, or a glob rewrite, would switch a floor off without a
 * failure. These tests fail instead.
 *
 * Matching mirrors vitest 4.1.12 resolveThresholds(): `picomatch(key)` with no
 * options, applied to repo-relative forward-slash paths. picomatch and
 * tinyglobby load through vitest's own dependency tree, so the test uses the
 * exact copies vitest uses. Spec: docs/superpowers/specs/coverage-floors-2026-10-26.md.
 */

// vitest runs from the repo root (same convention as coverage-floor.test.mjs).
const ROOT = process.cwd();

const vitestRequire = createRequire(
  createRequire(import.meta.url).resolve('vitest/package.json'),
);
const picomatch = vitestRequire('picomatch');
const { globSync } = vitestRequire('tinyglobby');

/** Keys of coverage.thresholds that are not globs, as vitest skips them. */
const NON_GLOB_KEYS = new Set([
  'perFile',
  'autoUpdate',
  '100',
  'lines',
  'functions',
  'branches',
  'statements',
]);

/** api/*.ts plus every api/ subfolder except _lib, cron and __tests__. */
const ENDPOINTS_KEY = 'api/!({_lib,cron,__tests__}/**)';

const coverage = config.test.coverage;
const globKeys = Object.keys(coverage.thresholds).filter(
  (key) => !NON_GLOB_KEYS.has(key),
);

/**
 * The files vitest's coverage map holds, listed the way its coverage provider
 * lists them: tinyglobby over coverage.include, ignoring coverage.exclude plus
 * test.include, then re-filtered through picomatch with isIncluded()'s
 * options. test.include is the only exclusion vitest appends that drops a
 * file coverage.exclude keeps (tests in nested __tests__ folders). The setup
 * file, src/__tests__/setup.ts, is inside coverage.include but already under
 * src/__tests__/**; the config-file, virtual-module and node_modules patterns
 * match nothing under src/ or api/. Repo-relative, forward slashes, sorted.
 */
function coveredFiles() {
  const ignore = [...coverage.exclude, ...config.test.include];
  return globSync(coverage.include, {
    cwd: ROOT,
    ignore,
    dot: true,
    onlyFiles: true,
  })
    .filter((file) =>
      picomatch.isMatch(file, coverage.include, {
        contains: true,
        dot: true,
        ignore,
      }),
    )
    .sort((a, b) => a.localeCompare(b));
}

const files = coveredFiles();

/**
 * The files one threshold key checks. Never `files.filter(picomatch(key))`:
 * picomatch's second parameter is returnObject, so filter's index argument
 * turns every miss into a truthy result object.
 */
function matchedBy(key, list) {
  const isMatch = picomatch(key);
  return list.filter((file) => isMatch(file));
}

describe('coverage file listing', () => {
  it('finds the covered source files', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((file) => file.startsWith('api/'))).toBe(true);
    expect(files.some((file) => file.startsWith('src/'))).toBe(true);
  });

  it('leaves out test files and api/__tests__ helpers', () => {
    const testLike = files.filter(
      (file) =>
        file.startsWith('api/__tests__/') ||
        file.startsWith('src/__tests__/') ||
        /\.(?:test|spec)\.tsx?$/.test(file),
    );
    expect(testLike).toEqual([]);
  });
});

describe('coverage threshold globs', () => {
  it('has exactly 6 per-folder keys, endpoints included', () => {
    expect(globKeys).toHaveLength(6);
    expect(globKeys).toContain(ENDPOINTS_KEY);
  });

  it.each(globKeys)('%s matches at least one covered file', (key) => {
    expect(matchedBy(key, files).length).toBeGreaterThan(0);
  });

  it('counts 0 for a key that matches nothing (self-check of the helper)', () => {
    expect(matchedBy('src/nope/**', files)).toEqual([]);
  });

  it('puts every api/ file in exactly one of the 3 api keys', () => {
    const apiKeys = globKeys.filter((key) => key.startsWith('api/'));
    expect(apiKeys).toHaveLength(3);
    const matchers = apiKeys.map((key) => [key, picomatch(key)]);
    const misfiled = files
      .filter((file) => file.startsWith('api/'))
      .map((file) => ({
        file,
        keys: matchers
          .filter(([, isMatch]) => isMatch(file))
          .map(([key]) => key),
      }))
      .filter(({ keys }) => keys.length !== 1);
    expect(misfiled).toEqual([]);
  });
});

describe('endpoints key', () => {
  const isEndpoint = picomatch(ENDPOINTS_KEY);

  it.each([
    'api/analyze.ts',
    'api/auth/init.ts',
    'api/cron.ts',
    'api/cron-x/a.ts',
    'api/_libx/a.ts',
    'api/x/cron/a.ts',
    'api/x/_lib/a.ts',
  ])('matches %s', (file) => {
    expect(isEndpoint(file)).toBe(true);
  });

  it.each([
    'api/_lib/db.ts',
    'api/_lib/sub/a.ts',
    'api/cron/a.ts',
    'api/cron/sub/a.ts',
    'api/__tests__/a.ts',
    'src/api/a.ts',
  ])('does not match %s', (file) => {
    expect(isEndpoint(file)).toBe(false);
  });
});
