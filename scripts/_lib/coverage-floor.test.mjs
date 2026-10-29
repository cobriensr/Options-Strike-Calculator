import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  FLOORS,
  METRICS,
  LcovParseError,
  parseLcov,
  checkFloors,
  formatViolation,
  lowestByMetric,
  evaluateLcov,
} from './coverage-floor.mjs';

/**
 * One lcov record in the layout vitest's istanbul lcov reporter writes:
 * summary pairs interleaved with FN/FNDA/DA/BRDA detail lines.
 */
function rec(sf, { fn = [0, 0], ln = [0, 0], br = [0, 0] } = {}) {
  return [
    'TN:',
    `SF:${sf}`,
    'FN:1,handler',
    `FNF:${fn[0]}`,
    `FNH:${fn[1]}`,
    'FNDA:3,handler',
    'DA:1,3',
    'DA:2,0',
    `LF:${ln[0]}`,
    `LH:${ln[1]}`,
    'BRDA:2,0,0,1',
    'BRDA:2,0,1,0',
    `BRF:${br[0]}`,
    `BRH:${br[1]}`,
    'end_of_record',
  ].join('\n');
}

/** Complete branch + function pairs, for fixtures that probe the line pair. */
const BR_FN_ZERO = 'BRF:0\nBRH:0\nFNF:0\nFNH:0';

function record(file, { fn = [0, 0], ln = [0, 0], br = [0, 0] } = {}) {
  return {
    file,
    functions: { found: fn[0], hit: fn[1] },
    lines: { found: ln[0], hit: ln[1] },
    branches: { found: br[0], hit: br[1] },
  };
}

describe('FLOORS', () => {
  it('matches the spec floors (branches 50, functions 50, lines 60)', () => {
    expect(FLOORS).toEqual({ branches: 50, functions: 50, lines: 60 });
  });

  it('is frozen so a caller cannot lower it at runtime', () => {
    expect(Object.isFrozen(FLOORS)).toBe(true);
  });

  it('lists the metrics in report order', () => {
    expect(METRICS).toEqual(['branches', 'functions', 'lines']);
  });
});

describe('parseLcov', () => {
  it('parses every record and reads only the summary counts', () => {
    const text = [
      rec('api\\alerts-ack.ts', { fn: [3, 3], ln: [20, 19], br: [8, 6] }),
      rec('src\\hooks\\useThing.ts', { fn: [4, 2], ln: [10, 7], br: [0, 0] }),
      rec('src\\utils\\pure.ts', { fn: [1, 1], ln: [5, 5], br: [2, 1] }),
    ].join('\n');

    expect(parseLcov(text)).toEqual([
      record('api/alerts-ack.ts', { fn: [3, 3], ln: [20, 19], br: [8, 6] }),
      record('src/hooks/useThing.ts', { fn: [4, 2], ln: [10, 7] }),
      record('src/utils/pure.ts', { fn: [1, 1], ln: [5, 5], br: [2, 1] }),
    ]);
  });

  it('accepts CRLF line endings', () => {
    const text = rec('api\\a.ts', { fn: [2, 1], ln: [4, 3], br: [2, 2] })
      .split('\n')
      .join('\r\n');
    expect(parseLcov(text)).toEqual([
      record('api/a.ts', { fn: [2, 1], ln: [4, 3], br: [2, 2] }),
    ]);
  });

  it('keeps 0-found metrics as { found: 0, hit: 0 }', () => {
    const [only] = parseLcov(rec('src/types-ish.ts'));
    expect(only).toEqual(record('src/types-ish.ts'));
  });

  it.each([
    ['empty string', ''],
    ['blank lines only', '\n\n  \n'],
    ['test-name line only', 'TN:\n'],
  ])('returns no records for %s', (_label, text) => {
    expect(parseLcov(text)).toEqual([]);
  });

  describe('path normalisation', () => {
    it.each([
      [
        'relative Windows path (what vitest writes today)',
        'api\\alerts-ack.ts',
        undefined,
        'api/alerts-ack.ts',
      ],
      ['relative path with ./', './src/x.ts', undefined, 'src/x.ts'],
      [
        'absolute Windows path under the root',
        'F:\\dev\\strike-calculator\\src\\utils\\a.ts',
        'F:\\dev\\strike-calculator',
        'src/utils/a.ts',
      ],
      [
        'drive-letter case differs from the root, root has trailing slash',
        'f:\\dev\\strike-calculator\\api\\_lib\\db.ts',
        'F:\\dev\\strike-calculator\\',
        'api/_lib/db.ts',
      ],
      [
        'absolute POSIX path under the root',
        '/home/ci/repo/src/x.ts',
        '/home/ci/repo',
        'src/x.ts',
      ],
      [
        'absolute Windows path with no root stays absolute, forward-slashed',
        'C:\\work\\repo\\api\\cron\\x.ts',
        undefined,
        'C:/work/repo/api/cron/x.ts',
      ],
      [
        'absolute POSIX path with no root stays absolute',
        '/home/ci/repo/src/components/api/x.ts',
        undefined,
        '/home/ci/repo/src/components/api/x.ts',
      ],
      [
        'absolute path outside the root stays absolute',
        '/home/ci/repo/src/hooks/useX.ts',
        '/somewhere/else',
        '/home/ci/repo/src/hooks/useX.ts',
      ],
      [
        'root is only a string prefix, not a directory boundary',
        '/home/ci/repo-other/src/x.ts',
        '/home/ci/repo',
        '/home/ci/repo-other/src/x.ts',
      ],
      [
        'absolute path on another drive than the root stays absolute',
        'Z:\\elsewhere\\api\\x.ts',
        'F:\\dev\\strike-calculator',
        'Z:/elsewhere/api/x.ts',
      ],
    ])('%s', (_label, sf, root, expected) => {
      const [only] = parseLcov(rec(sf), { root });
      expect(only?.file).toBe(expected);
    });
  });

  describe('malformed input throws LcovParseError with the line number', () => {
    it.each([
      [
        'a count line before any SF',
        'LF:3\nLH:3\nend_of_record',
        /^line 1: LF outside a record/,
      ],
      [
        'end_of_record with no open record',
        'TN:\nend_of_record',
        /^line 2: end_of_record without SF/,
      ],
      [
        'a new SF before the previous end_of_record',
        'SF:api/a.ts\nLF:1\nSF:api/b.ts\nLH:1\nend_of_record',
        /^line 3: SF before end_of_record of api\/a\.ts/,
      ],
      [
        'a truncated final record',
        'SF:api/a.ts\nLF:4\nLH:4',
        /^line 3: unterminated record for api\/a\.ts \(no end_of_record\)/,
      ],
      ['an empty SF path', 'SF:\nend_of_record', /^line 1: empty SF path/],
      [
        'a non-numeric count',
        'SF:api/a.ts\nLF:abc\nLH:0\nend_of_record',
        /^line 2: LF is not a non-negative integer: "abc"/,
      ],
      [
        'a negative count',
        'SF:api/a.ts\nBRF:-2\nBRH:0\nend_of_record',
        /^line 2: BRF is not a non-negative integer: "-2"/,
      ],
      [
        'a fractional count',
        'SF:api/a.ts\nFNF:1.5\nFNH:1\nend_of_record',
        /^line 2: FNF is not a non-negative integer: "1.5"/,
      ],
      [
        'an empty count',
        'SF:api/a.ts\nLF:\nLH:0\nend_of_record',
        /^line 2: LF is not a non-negative integer: ""/,
      ],
      [
        'hit greater than found',
        `SF:api/a.ts\n${BR_FN_ZERO}\nLF:3\nLH:5\nend_of_record`,
        /^line 8: LH 5 > LF 3 in api\/a\.ts/,
      ],
      [
        'a hit count with no found count',
        'SF:api/a.ts\nBRH:2\nend_of_record',
        /^line 3: BRH without BRF in api\/a\.ts/,
      ],
      [
        'a found count with no hit count',
        'SF:api/a.ts\nBRF:0\nBRH:0\nFNF:2\nend_of_record',
        /^line 5: FNF without FNH in api\/a\.ts/,
      ],
      [
        'a record with no summary lines at all',
        'SF:api/x.ts\nend_of_record',
        /^line 2: missing BRF\/BRH in api\/x\.ts/,
      ],
      [
        'a record missing both branch tags (was read as 0/0)',
        'SF:src/a.ts\nFNF:2\nFNH:2\nLF:10\nLH:9\nend_of_record',
        /^line 6: missing BRF\/BRH in src\/a\.ts/,
      ],
      [
        'a record missing both line tags',
        'SF:api/x.ts\nBRF:0\nBRH:0\nFNF:2\nFNH:2\nend_of_record',
        /^line 6: missing LF\/LH in api\/x\.ts/,
      ],
      [
        'a duplicate summary tag (was last-wins)',
        `SF:api/x.ts\n${BR_FN_ZERO}\nLF:10\nLH:1\nLH:9\nend_of_record`,
        /^line 8: duplicate LH in api\/x\.ts/,
      ],
    ])('%s', (_label, text, message) => {
      expect(() => parseLcov(text)).toThrow(LcovParseError);
      expect(() => parseLcov(text)).toThrow(message);
    });
  });
});

describe('checkFloors', () => {
  it.each([
    [
      'all metrics well above the floors',
      { fn: [10, 10], ln: [100, 95], br: [20, 18] },
      [],
    ],
    [
      'exactly on every floor: 50.0% / 50.0% / 60.0% passes',
      { fn: [100, 50], ln: [5, 3], br: [2, 1] },
      [],
    ],
    ['every metric 0 found (nothing to cover) passes', {}, []],
    [
      '0 found branches pass while the other metrics are fine',
      { fn: [1, 1], ln: [1, 1] },
      [],
    ],
    [
      'branches 49.9% fails',
      { fn: [1, 1], ln: [1, 1], br: [1000, 499] },
      [{ metric: 'branches', pct: 49.9, floor: 50 }],
    ],
    [
      'functions 49.9% fails',
      { fn: [1000, 499], ln: [1, 1] },
      [{ metric: 'functions', pct: 49.9, floor: 50 }],
    ],
    [
      'lines 59.9% fails (lines floor is 60)',
      { fn: [1, 1], ln: [1000, 599] },
      [{ metric: 'lines', pct: 59.9, floor: 60 }],
    ],
    [
      'lines 50% passes the branch floor but fails the lines floor',
      { fn: [1, 1], ln: [2, 1], br: [2, 1] },
      [{ metric: 'lines', pct: 50, floor: 60 }],
    ],
    [
      'hit 0 of a non-zero found is 0%',
      { fn: [3, 0], ln: [1, 1] },
      [{ metric: 'functions', pct: 0, floor: 50 }],
    ],
  ])('%s', (_label, counts, expected) => {
    const violations = checkFloors([record('api/x.ts', counts)]);
    expect(violations).toEqual(
      expected.map((v) => ({ file: 'api/x.ts', ...v })),
    );
  });

  it('reports every failing metric of one file, in metric order', () => {
    const violations = checkFloors([
      record('src/bad.tsx', { fn: [10, 3], ln: [10, 5], br: [10, 4] }),
    ]);
    expect(violations).toEqual([
      { file: 'src/bad.tsx', metric: 'branches', pct: 40, floor: 50 },
      { file: 'src/bad.tsx', metric: 'functions', pct: 30, floor: 50 },
      { file: 'src/bad.tsx', metric: 'lines', pct: 50, floor: 60 },
    ]);
  });

  it('orders violations by file, then metric, and skips passing files', () => {
    const violations = checkFloors([
      record('api/a.ts', { fn: [2, 0], ln: [1, 1] }),
      record('api/ok.ts', { fn: [1, 1], ln: [1, 1], br: [1, 1] }),
      record('src/b.ts', { ln: [10, 1], br: [4, 1] }),
    ]);
    expect(violations.map((v) => `${v.file}:${v.metric}`)).toEqual([
      'api/a.ts:functions',
      'src/b.ts:branches',
      'src/b.ts:lines',
    ]);
  });

  it('returns no violations for no records', () => {
    expect(checkFloors([])).toEqual([]);
  });
});

describe('formatViolation', () => {
  it.each([
    [
      { file: 'api/x.ts', metric: 'branches', pct: 42, floor: 50 },
      'api/x.ts: branches 42.0% < 50%',
    ],
    [
      { file: 'src/y.tsx', metric: 'lines', pct: 59.9, floor: 60 },
      'src/y.tsx: lines 59.9% < 60%',
    ],
    // Truncates rather than rounds, so a failing 49.96% never prints as 50.0%.
    [
      { file: 'api/z.ts', metric: 'functions', pct: 49.96, floor: 50 },
      'api/z.ts: functions 49.9% < 50%',
    ],
    [
      { file: 'api/z.ts', metric: 'functions', pct: 0, floor: 50 },
      'api/z.ts: functions 0.0% < 50%',
    ],
  ])('%o -> %s', (violation, expected) => {
    expect(formatViolation(violation)).toBe(expected);
  });
});

describe('lowestByMetric', () => {
  it('finds the lowest file per metric and ignores 0-found metrics', () => {
    const lowest = lowestByMetric([
      record('api/a.ts', { fn: [4, 4], ln: [10, 7], br: [0, 0] }),
      record('api/b.ts', { fn: [4, 2], ln: [10, 9], br: [4, 3] }),
      record('api/c.ts', { fn: [0, 0], ln: [10, 8], br: [10, 9] }),
    ]);
    expect(lowest).toEqual({
      branches: { file: 'api/b.ts', pct: 75 },
      functions: { file: 'api/b.ts', pct: 50 },
      lines: { file: 'api/a.ts', pct: 70 },
    });
  });

  it('keeps the first file on a tie', () => {
    const lowest = lowestByMetric([
      record('api/first.ts', { ln: [2, 1] }),
      record('api/second.ts', { ln: [4, 2] }),
    ]);
    expect(lowest.lines).toEqual({ file: 'api/first.ts', pct: 50 });
  });

  it('returns null for a metric no file measures', () => {
    expect(lowestByMetric([record('api/a.ts', { ln: [1, 1] })])).toEqual({
      branches: null,
      functions: null,
      lines: { file: 'api/a.ts', pct: 100 },
    });
  });
});

describe('evaluateLcov', () => {
  it('passes with a one-line summary naming the lowest file per metric', () => {
    const text = [
      rec('api\\a.ts', { fn: [4, 2], ln: [10, 7], br: [0, 0] }),
      rec('api\\b.ts', { fn: [4, 4], ln: [10, 9], br: [4, 3] }),
    ].join('\n');
    expect(evaluateLcov(text)).toEqual({
      ok: true,
      messages: [
        'coverage floor: OK, 2 files checked (floors: branches 50%, functions 50%, lines 60%); ' +
          'lowest: branches 75.0% api/b.ts, functions 50.0% api/a.ts, lines 70.0% api/a.ts',
      ],
    });
  });

  it('prints n/a for a metric no file measures', () => {
    const { ok, messages } = evaluateLcov(rec('api\\a.ts', { ln: [1, 1] }));
    expect(ok).toBe(true);
    expect(messages[0]).toContain(
      'lowest: branches n/a, functions n/a, lines 100.0% api/a.ts',
    );
  });

  it('fails with one line per violation plus a footer', () => {
    const text = [
      rec('F:\\repo\\api\\a.ts', { fn: [10, 3], ln: [10, 9], br: [10, 4] }),
      rec('F:\\repo\\api\\ok.ts', { fn: [1, 1], ln: [1, 1], br: [1, 1] }),
      rec('F:\\repo\\src\\b.ts', { fn: [1, 1], ln: [1000, 599] }),
    ].join('\n');
    expect(evaluateLcov(text, { root: 'F:\\repo' })).toEqual({
      ok: false,
      messages: [
        'api/a.ts: branches 40.0% < 50%',
        'api/a.ts: functions 30.0% < 50%',
        'src/b.ts: lines 59.9% < 60%',
        'coverage floor: FAILED, 3 violations in 2 files of 3 checked ' +
          '(floors: branches 50%, functions 50%, lines 60%). ' +
          'Add tests; the floors live in scripts/_lib/coverage-floor.mjs.',
      ],
    });
  });

  it.each([
    ['an empty', ''],
    ['a TN-only', 'TN:\n\n'],
  ])('fails on %s report instead of passing silently', (_label, text) => {
    expect(evaluateLcov(text)).toEqual({
      ok: false,
      messages: [
        'coverage floor: FAILED, the lcov report has no file records (no SF: lines). ' +
          'Refusing to pass an empty report.',
      ],
    });
  });

  it('fails on a malformed report with the parse error, without throwing', () => {
    // A summary-less record used to read as 0/0 and pass silently.
    expect(evaluateLcov('SF:api/a.ts\nend_of_record')).toEqual({
      ok: false,
      messages: [
        'coverage floor: FAILED, malformed lcov report: line 2: missing BRF/BRH in api/a.ts',
      ],
    });
  });

  it('re-throws anything that is not an LcovParseError (a programming error)', () => {
    expect(() => evaluateLcov(undefined)).toThrow(TypeError);
  });
});

// Each CLI test spawns node: Windows process spawn under full-suite
// multi-session load took 15.2 s (2026-10-29), past the 15 s testTimeout.
const CLI_TIMEOUT = 60_000;

describe('check-coverage-floor CLI', { timeout: CLI_TIMEOUT }, () => {
  // vitest runs from the repo root (same convention as vercel-ignore-command).
  const cli = path.resolve(
    process.cwd(),
    'scripts',
    'check-coverage-floor.mjs',
  );
  let cwd;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'coverage-floor-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  /** Run the CLI in a temp cwd, optionally with a coverage/lcov.info. */
  function runCli(report) {
    if (report !== undefined) {
      mkdirSync(path.join(cwd, 'coverage'));
      writeFileSync(path.join(cwd, 'coverage', 'lcov.info'), report);
    }
    return spawnSync(process.execPath, [cli], { cwd, encoding: 'utf8' });
  }

  it('exits 1 with a clear message when coverage/lcov.info is missing', () => {
    const result = runCli();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'coverage floor: FAILED, coverage/lcov.info not found.',
    );
  });

  it('exits 1 on an empty report', () => {
    const result = runCli('');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('has no file records');
  });

  it('exits 1 when coverage/lcov.info exists but cannot be read', () => {
    mkdirSync(path.join(cwd, 'coverage', 'lcov.info'), { recursive: true });
    const result = runCli();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('coverage/lcov.info unreadable (EISDIR');
  });

  it('exits 1 on a malformed report', () => {
    const result = runCli('SF:api/a.ts\nLF:4\nLH:4');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'malformed lcov report: line 3: unterminated record for api/a.ts',
    );
  });

  it('exits 1 and prints each violation relative to the cwd root', () => {
    // An absolute SF under the cwd must come out cwd-relative.
    const report = rec(path.join(cwd, 'lib', 'low.ts'), {
      fn: [1, 1],
      ln: [10, 9],
      br: [100, 42],
    });
    const result = runCli(report);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('lib/low.ts: branches 42.0% < 50%');
    expect(result.stdout).toBe('');
  });

  it('exits 0 and prints the one-line summary when every file passes', () => {
    const result = runCli(rec('api\\ok.ts', { fn: [2, 2], ln: [4, 4] }));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('coverage floor: OK, 1 file checked');
    expect(result.stderr).toBe('');
  });
});
