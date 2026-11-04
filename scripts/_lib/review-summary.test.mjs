// @vitest-environment node

/**
 * Tests for scripts/_lib/review-summary.mjs and its CLI,
 * scripts/review-summary.mjs. The fixtures in review-summary-fixtures/ are
 * trimmed copies of real `npm run review` logs (pass.txt, fail-tsc.txt,
 * fail-vitest*.txt) and real tool output spliced into a log of the same
 * shape (fail-eslint, fail-prettier, fail-vite, fail-build-output,
 * fail-coverage-floor); fail-coverage-threshold.txt and fail-seal.txt use
 * the message text from vitest's coverage provider and from
 * scripts/_lib/review-gate.mjs.
 *
 * The vitest sections of those logs are full of pino JSON lines
 * (`{"level":"error",...}`) from tests that exercise error paths on purpose.
 * They are test output, never gate output, and must not be reported.
 *
 * The fixtures are .txt files, not .log, because the repo ignores *.log.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  STAGES,
  decodeLog,
  parseReviewLog,
  summarizeReviewLog,
} from './review-summary.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'review-summary.mjs');

/** @param {string} name */
const fixture = (name) =>
  readFileSync(path.join(HERE, 'review-summary-fixtures', name), 'utf8');

const IDS = [
  'type-check',
  'eslint',
  'prettier',
  'vite',
  'build-output',
  'vitest',
  'coverage-floor',
  'seal',
];

/** id -> status, for a log. */
function statusesOf(text, options) {
  const { stages } = parseReviewLog(text, options);
  return Object.fromEntries(stages.map((s) => [s.id, s.status]));
}

/** Statuses for the eight stages: `pass` x `passing`, then `failing`, then not reached. */
function expectedStatuses(passing, failing) {
  return Object.fromEntries(
    IDS.map((id, i) => [
      id,
      i < passing ? 'pass' : i === passing && failing ? 'fail' : 'not reached',
    ]),
  );
}

/** The status word printed on the line for a stage label. */
function expectStage(output, label, status) {
  const line = output.split('\n').find((l) => l.startsWith(label));
  expect(line?.slice(label.length).trim()).toBe(status);
}

/** The detail lines (indented) printed under one stage's line. */
function detailOf(text, id, options) {
  const { stages } = parseReviewLog(text, options);
  const stage = stages.find((s) => s.id === id);
  return stage ? stage.details : [];
}

/** pass.txt cut after the type-check banner, with `extra` where eslint prints. */
function afterTypeCheck(extra) {
  const lines = fixture('pass.txt').split('\n');
  const banner = lines.findIndex((l) => l.startsWith('> tsc --noEmit'));
  return `${lines.slice(0, banner + 1).join('\n')}\n\n${extra}\n`;
}

describe('STAGES', () => {
  it('lists the eight stages of `npm run review`, in chain order', () => {
    expect(STAGES.map((s) => s.id)).toEqual(IDS);
    expect(STAGES.map((s) => s.label)).toEqual([
      'type-check',
      'eslint',
      'prettier',
      'vite build',
      'build-output check',
      'vitest',
      'coverage floor',
      'seal',
    ]);
  });
});

describe('a passing run (real log)', () => {
  const log = fixture('pass.txt');

  it('marks every stage pass and the run ok', () => {
    expect(statusesOf(log)).toEqual(expectedStatuses(8, false));
    expect(summarizeReviewLog(log).ok).toBe(true);
  });

  it('prints one line per stage in order, then the seal line last', () => {
    const { lines } = summarizeReviewLog(log);

    expect(lines).toHaveLength(9);
    expect(lines.slice(0, 8).map((l) => l.split(/\s{2,}/)[0])).toEqual([
      'type-check',
      'eslint',
      'prettier',
      'vite build',
      'build-output check',
      'vitest',
      'coverage floor',
      'seal',
    ]);
    expect(lines.slice(0, 8).every((l) => l.includes('pass'))).toBe(true);
    expect(lines.at(-1)).toMatch(
      /^review-gate: sealed tree [0-9a-f]{40} \(HEAD [0-9a-f]{40}\)$/,
    );
  });

  it('shows the vitest totals on the vitest line', () => {
    const vitest = summarizeReviewLog(log).lines.find((l) =>
      l.startsWith('vitest'),
    );
    expect(vitest).toContain('Test Files 718 passed | 1 skipped (719)');
    expect(vitest).toContain('Tests 16179 passed | 4 skipped (16183)');
  });

  it('does not report the pino error lines the tests print on purpose', () => {
    // Guard the fixture itself: it must keep the noise this test is about.
    const pinoErrors = log
      .split('\n')
      .filter((l) => l.startsWith('{"level":"error"'));
    expect(pinoErrors.length).toBeGreaterThan(10);

    const output = summarizeReviewLog(log).lines.join('\n');
    expect(output).not.toContain('"level"');
    expect(output).not.toContain('RateLimitError');
    expect(output).not.toContain('DB down');
  });
});

describe('one failing stage per fixture', () => {
  /** [fixture, passing stages before it, expected detail substrings, options] */
  const CASES = [
    [
      'fail-tsc.txt',
      0,
      [
        'api/__tests__/cron-compute-cone.test.ts(219,13): error TS2493: Tuple type',
        'api/__tests__/cron-compute-cone.test.ts(220,23): error TS2352',
      ],
      {},
    ],
    [
      'fail-eslint.txt',
      1,
      [
        'src/utils/scratch-lint.ts:1 @typescript-eslint/no-unused-vars',
        'src/utils/scratch-lint.ts:3 prefer-const',
      ],
      { root: 'C:\\work\\repo' },
    ],
    [
      'fail-prettier.txt',
      2,
      ['src/bad.ts: SyntaxError: Variable declaration expected. (1:14)'],
      {},
    ],
    [
      'fail-vite.txt',
      3,
      ['Could not resolve "./missing.js" from "src/main.js"'],
      {},
    ],
    [
      'fail-build-output.txt',
      4,
      [
        'dist/index.html line 1 has an inline <script> (no src)',
        'no chunk in dist/assets contains "remarkPlugins"',
        'no chunk in dist/assets has a name starting "charts-"',
      ],
      {},
    ],
    [
      'fail-vitest.txt',
      5,
      [
        'FAIL src/components/PanelPrefsModal/__tests__/LazyPanelPrefsModal.test.tsx > LazyPanelPrefsModal > imports the modal on open and shows the dialog',
        'Test Files 1 failed | 714 passed | 1 skipped (716)',
        'Tests 1 failed | 16014 passed | 4 skipped (16019)',
      ],
      {},
    ],
    [
      'fail-vitest-timeout.txt',
      5,
      [
        'FAIL scripts/_lib/prune-worktrees.test.mjs > pruneWorktrees dry run > changes no worktree, branch or admin entry',
        'Test Files 1 failed | 688 passed | 1 skipped (690)',
        'Tests 1 failed | 15089 passed | 4 skipped (15094)',
      ],
      {},
    ],
    [
      'fail-coverage-threshold.txt',
      5,
      [
        'ERROR: Coverage for lines (89.84%) does not meet global threshold (90%)',
        'ERROR: Coverage for branches (83.1%) does not meet "api/cron/**" threshold (84%)',
        'Test Files 718 passed | 1 skipped (719)',
      ],
      {},
    ],
    [
      'fail-coverage-floor.txt',
      6,
      [
        'coverage floor: FAILED, 3 violations in 1 file of 2 checked',
        'api/_lib/x.ts: branches 25.0% < 50%',
        'api/_lib/x.ts: lines 30.0% < 60%',
      ],
      {},
    ],
    [
      'fail-seal.txt',
      7,
      ['review-gate seal failed: only `npm run review` may seal'],
      {},
    ],
  ];

  it.each(CASES)(
    '%s fails only its own stage; the rest before pass, the rest after not reached',
    (name, passing, details, options) => {
      const log = fixture(name);
      const statuses = statusesOf(log, options);
      const failing = IDS[passing];

      expect(statuses).toEqual(expectedStatuses(passing, true));
      expect(statuses[failing]).toBe('fail');

      const summary = summarizeReviewLog(log, options);
      expect(summary.ok).toBe(false);

      const shown = detailOf(log, failing, options).join('\n');
      for (const expected of details) expect(shown).toContain(expected);

      // The detail lines are printed, indented, under the failing stage.
      const printed = summary.lines.join('\n');
      for (const expected of details) expect(printed).toContain(expected);
    },
  );

  it('ends a failing run without a seal line', () => {
    const { lines } = summarizeReviewLog(fixture('fail-vitest.txt'));
    expect(lines.some((l) => l.startsWith('review-gate: sealed'))).toBe(false);
    expectStage(lines.join('\n'), 'seal', 'not reached');
  });

  it('prints the stage lines with the right word for each status', () => {
    const { lines } = summarizeReviewLog(fixture('fail-build-output.txt'));
    const stageLines = lines.filter((l) => !l.startsWith(' '));
    expect(stageLines.map((l) => l.split(/\s{2,}/)[1])).toEqual([
      'pass',
      'pass',
      'pass',
      'pass',
      'fail',
      'not reached',
      'not reached',
      'not reached',
    ]);
  });

  it('never reports a pino JSON line as a failure, in any fixture', () => {
    for (const name of [
      'pass.txt',
      'fail-vitest.txt',
      'fail-vitest-timeout.txt',
      'fail-coverage-threshold.txt',
      'fail-coverage-floor.txt',
      'fail-seal.txt',
    ]) {
      const output = summarizeReviewLog(fixture(name)).lines.join('\n');
      expect(output, name).not.toContain('{"level"');
      expect(output, name).not.toContain('"msg"');
    }
  });

  it('leaves the vitest stage passing when only the floor fails', () => {
    const log = fixture('fail-coverage-floor.txt');
    expect(statusesOf(log).vitest).toBe('pass');
    expect(statusesOf(log)['coverage-floor']).toBe('fail');
  });
});

describe('input shapes', () => {
  it('reads CRLF line endings the same as LF', () => {
    const log = fixture('fail-tsc.txt');
    expect(summarizeReviewLog(log.replaceAll('\n', '\r\n'))).toEqual(
      summarizeReviewLog(log),
    );
  });

  it('reads a log with its colour codes stripped the same as with them', () => {
    const log = fixture('fail-prettier.txt');
    const plain = stripVTControlCharacters(log);
    expect(plain).not.toBe(log);
    expect(summarizeReviewLog(plain)).toEqual(summarizeReviewLog(log));
  });

  it('ignores the wrapper line a runner appends after the output', () => {
    const log = `${fixture('fail-vitest.txt').trimEnd()}\nexit=1\n`;
    expect(statusesOf(log)).toEqual(expectedStatuses(5, true));
  });

  it('decodes a UTF-16LE log, which PowerShell 5.1 writes for a redirect', () => {
    const log = fixture('fail-tsc.txt');
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(log, 'utf16le'),
    ]);

    expect(decodeLog(utf16)).toBe(log);
    expect(summarizeReviewLog(decodeLog(utf16))).toEqual(
      summarizeReviewLog(log),
    );
  });

  it('drops a UTF-8 byte-order mark', () => {
    const utf8 = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('> x review\n'),
    ]);
    expect(decodeLog(utf8)).toBe('> x review\n');
  });

  it('is not recognised for text with no review output in it', () => {
    for (const text of ['', '\n\n', 'hello\nworld\n', '{"level":"error"}\n']) {
      const summary = summarizeReviewLog(text);
      expect(summary.recognised).toBe(false);
      expect(summary.ok).toBe(false);
    }
  });
});

describe('a log that stops before a stage finishes', () => {
  it('fails the stage the log ends in and leaves the rest not reached', () => {
    const lines = fixture('pass.txt').split('\n');
    const run = lines.findIndex((l) => l.startsWith(' RUN'));
    const cut = lines.slice(0, run + 6).join('\n');

    expect(statusesOf(cut)).toEqual(expectedStatuses(5, true));
    const detail = detailOf(cut, 'vitest').join('\n');
    expect(detail).toContain('the log ends in this stage');
  });

  it('does not take a test that prints "Tests ..." for vitest totals', () => {
    const lines = fixture('pass.txt').split('\n');
    const run = lines.findIndex((l) => l.startsWith(' RUN'));
    const cut = [
      ...lines.slice(0, run + 2),
      'Test Files are listed in the report',
      'Tests failed to start the dev server',
    ].join('\n');

    expect(statusesOf(cut).vitest).toBe('fail');
    expect(detailOf(cut, 'vitest')).toEqual([
      'no result: the log ends in this stage',
    ]);
  });

  it('fails type-check when only the banner is there', () => {
    const lines = fixture('pass.txt').split('\n');
    const banner = lines.findIndex((l) => l.startsWith('> tsc --noEmit'));
    const cut = lines.slice(0, banner + 1).join('\n');

    expect(statusesOf(cut)).toEqual(expectedStatuses(0, true));
    expect(summarizeReviewLog(cut).ok).toBe(false);
  });
});

describe('eslint output', () => {
  const header = '/repo/src/a.ts\n';

  it('reports file:line and rule for each error, relative to the root', () => {
    const log = afterTypeCheck(
      `${header}  4:9  error  'a' is never used  @typescript-eslint/no-unused-vars\n` +
        `  12:1  error  Unexpected any  @typescript-eslint/no-explicit-any\n\n` +
        '✖ 2 problems (2 errors, 0 warnings)',
    );

    expect(statusesOf(log, { root: '/repo' }).eslint).toBe('fail');
    expect(detailOf(log, 'eslint', { root: '/repo' })).toEqual([
      'src/a.ts:4 @typescript-eslint/no-unused-vars',
      'src/a.ts:12 @typescript-eslint/no-explicit-any',
    ]);
  });

  it('keeps an absolute path when it is outside the root', () => {
    const log = afterTypeCheck(
      `/elsewhere/b.ts\n  1:1  error  Bad  some/rule\n\n✖ 1 problem (1 error, 0 warnings)`,
    );
    expect(detailOf(log, 'eslint', { root: '/repo' })).toEqual([
      '/elsewhere/b.ts:1 some/rule',
    ]);
  });

  it('matches a Windows root case-insensitively and across slash styles', () => {
    const log = afterTypeCheck(
      'f:\\Dev\\Repo\\src\\c.ts\n  7:3  error  Bad  some/rule\n\n✖ 1 problem (1 error, 0 warnings)',
    );
    expect(detailOf(log, 'eslint', { root: 'F:/dev/repo/' })).toEqual([
      'src/c.ts:7 some/rule',
    ]);
  });

  it('uses the message when an error has no rule (a parsing error)', () => {
    const log = afterTypeCheck(
      '/repo/src/d.ts\n  3:5  error  Parsing error: Unexpected token }\n\n✖ 1 problem (1 error, 0 warnings)',
    );
    expect(detailOf(log, 'eslint', { root: '/repo' })).toEqual([
      'src/d.ts:3 Parsing error: Unexpected token }',
    ]);
  });

  it('does not fail on warnings alone, because eslint exits 0 for them', () => {
    const log = afterTypeCheck(
      '/repo/src/e.ts\n  2:1  warning  Be careful  some/rule\n\n✖ 1 problem (0 errors, 1 warning)',
    );
    const lines = fixture('pass.txt').split('\n');
    const firstPrettier = lines.findIndex((l) => l.endsWith(' (unchanged)'));
    const rest = lines.slice(firstPrettier).join('\n');

    expect(statusesOf(`${log}${rest}`).eslint).toBe('pass');
    expect(detailOf(`${log}${rest}`, 'eslint')).toEqual([]);
  });

  it('caps the detail at five lines and counts the rest', () => {
    const issues = Array.from(
      { length: 8 },
      (_, i) => `  ${i + 1}:1  error  Bad  rule/${i + 1}`,
    );
    const log = afterTypeCheck(
      `/repo/src/f.ts\n${issues.join('\n')}\n\n✖ 8 problems (8 errors, 0 warnings)`,
    );

    const details = detailOf(log, 'eslint', { root: '/repo' });
    expect(details).toHaveLength(6);
    expect(details[0]).toBe('src/f.ts:1 rule/1');
    expect(details[4]).toBe('src/f.ts:5 rule/5');
    expect(details[5]).toBe('... and 3 more');
  });

  it('falls back to the summary line when no issue line parses', () => {
    const log = afterTypeCheck(
      'weird output\n✖ 3 problems (3 errors, 0 warnings)',
    );
    expect(statusesOf(log).eslint).toBe('fail');
    expect(detailOf(log, 'eslint')).toEqual([
      '✖ 3 problems (3 errors, 0 warnings)',
    ]);
  });
});

describe('vitest output', () => {
  it('reports vitest unhandled errors even when every test passed', () => {
    const lines = fixture('pass.txt').split('\n');
    const files = lines.findIndex((l) => l.startsWith(' Test Files'));
    lines.splice(
      files,
      0,
      '⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯',
      '',
      'Vitest caught 1 unhandled error during the test run.',
      '',
    );

    const log = lines.join('\n');
    expect(statusesOf(log).vitest).toBe('fail');
    expect(detailOf(log, 'vitest').join('\n')).toContain(
      'Vitest caught 1 unhandled error during the test run.',
    );
  });

  it('does not count a FAIL line that a test prints itself as a failed test', () => {
    const lines = fixture('pass.txt').split('\n');
    const run = lines.findIndex((l) => l.startsWith(' RUN'));
    // Vitest's own line is ` FAIL  <file> > <test>`: one space, then two.
    lines.splice(
      run + 1,
      0,
      'FAIL something broke',
      'FAIL  two spaces and nothing before them',
      '  FAIL  two spaces before',
      ' FAIL only one space after',
    );
    const log = lines.join('\n');

    expect(statusesOf(log)).toEqual(expectedStatuses(8, false));
    expect(summarizeReviewLog(log).ok).toBe(true);
    expect(detailOf(log, 'vitest')).toEqual([]);
  });

  it('lists a failed test once even when vitest prints it twice', () => {
    const log = fixture('fail-vitest.txt');
    const failLine = log.split('\n').find((l) => l.startsWith(' FAIL '));
    const doubled = log.replace(failLine, `${failLine}\n${failLine}`);

    const fails = detailOf(doubled, 'vitest').filter((d) =>
      d.startsWith('FAIL '),
    );
    expect(fails).toHaveLength(1);
  });
});

describe('a failed `review-gate clear`', () => {
  const message =
    'review-gate clear failed: EPERM: operation not permitted, unlink F:\\dev\\x\\.git\\review-marker';

  /** pass.txt up to the line that lists the chain, then the clear failure. */
  function clearFailureLog(failureLine) {
    const lines = fixture('pass.txt').split('\n');
    const chain = lines.findIndex((l) =>
      l.startsWith('> node scripts/review-gate.mjs clear'),
    );
    return `${lines.slice(0, chain + 1).join('\n')}\n\n${failureLine}\n`;
  }

  it('shows the gate message under type-check, with no "no result" note', () => {
    const log = clearFailureLog(message);

    expect(statusesOf(log)).toEqual(expectedStatuses(0, true));
    expect(detailOf(log, 'type-check')).toEqual([message]);

    const summary = summarizeReviewLog(log);
    expect(summary.ok).toBe(false);
    expect(summary.lines.join('\n')).not.toContain('no result');
    const [first, second] = summary.lines;
    expect(first).toMatch(/^type-check\s+fail$/);
    expect(second).toBe(`  ${message}`);
  });

  it('reads the message the same behind the PowerShell "npm : " prefix', () => {
    const log = clearFailureLog(`npm : ${message}`);

    expect(detailOf(log, 'type-check')).toEqual([message]);
    expect(summarizeReviewLog(log)).toEqual(
      summarizeReviewLog(clearFailureLog(message)),
    );
  });
});

describe('the "npm : " prefix Windows PowerShell 5.1 puts on the first stderr line', () => {
  /** `log` with `npm : ` in front of its first line that starts with `start`. */
  function prefixed(log, start) {
    const lines = log.split('\n');
    const at = lines.findIndex((l) => l.startsWith(start));
    expect(at, `no line starts with ${start}`).toBeGreaterThanOrEqual(0);
    lines[at] = `npm : ${lines[at]}`;
    return lines.join('\n');
  }

  it.each([
    ['coverage-floor', 'fail-coverage-floor.txt', 'api/_lib/x.ts: branches'],
    ['coverage-floor', 'fail-coverage-floor.txt', 'coverage floor: FAILED'],
    ['build-output', 'fail-build-output.txt', 'build output: dist/index.html'],
    ['build-output', 'fail-build-output.txt', 'build output: FAILED'],
    ['seal', 'fail-seal.txt', 'review-gate seal failed:'],
  ])('is read through on a %s failure (%s, line "%s")', (id, name, start) => {
    const plain = fixture(name);
    const log = prefixed(plain, start);
    expect(log).not.toBe(plain);

    expect(statusesOf(log)).toEqual(statusesOf(plain));
    expect(statusesOf(log)[id]).toBe('fail');
    expect(detailOf(log, id)).toEqual(detailOf(plain, id));
    expect(summarizeReviewLog(log).lines.join('\n')).not.toContain('npm :');
  });
});

describe('review-summary CLI', () => {
  /** @param {string[]} args @param {{ input?: string }} [options] */
  function run(args, options = {}) {
    return spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      input: options.input,
      windowsHide: true,
    });
  }

  const fixturePath = (name) =>
    path.join(HERE, 'review-summary-fixtures', name);

  it('exits 0 for a passing log given as a file and prints the summary', () => {
    const result = run([fixturePath('pass.txt')]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trimEnd().split('\n')).toHaveLength(9);
    expect(result.stdout).toContain('review-gate: sealed tree');
  });

  it('exits 1 for a failing log and prints the first errors', () => {
    const result = run([fixturePath('fail-tsc.txt')]);

    expect(result.status).toBe(1);
    expectStage(result.stdout, 'type-check', 'fail');
    expect(result.stdout).toContain('error TS2493');
  });

  it('reads the log from stdin when no file is given', () => {
    const result = run([], { input: fixture('fail-vite.txt') });

    expect(result.status).toBe(1);
    expectStage(result.stdout, 'vite build', 'fail');
  });

  it('exits 2 for a file it cannot read', () => {
    const result = run([fixturePath('no-such-file.txt')]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('review-summary: cannot read');
    expect(result.stderr).toContain('no-such-file.txt');
  });

  it('reads a UTF-16LE log from stdin', () => {
    const input = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(fixture('fail-vite.txt'), 'utf16le'),
    ]);
    const result = run([], { input });

    expect(result.status).toBe(1);
    expectStage(result.stdout, 'vite build', 'fail');
  });

  it('exits 2 for input with no review output in it', () => {
    const result = run([], { input: 'nothing to see here\n' });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('no `npm run review` output');
  });

  it('exits 2 and prints usage for more than one argument', () => {
    const result = run(['a.txt', 'b.txt']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: node scripts/review-summary.mjs');
  });

  it('exits 2 and prints usage for an option, --help included', () => {
    for (const option of ['--help', '-h']) {
      const result = run([option]);

      expect(result.status, option).toBe(2);
      expect(result.stdout, option).toBe('');
      expect(result.stderr, option).toContain(
        'usage: node scripts/review-summary.mjs',
      );
    }
  });
});
