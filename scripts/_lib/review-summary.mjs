/**
 * Reads the output of `npm run review` and says, per stage, whether it
 * passed, failed or was never reached, with the first few error lines of a
 * failed stage. Pure text in, text out: the CLI wrapper is
 * scripts/review-summary.mjs.
 *
 * The chain is `a && b && ...`, so the first failing stage ends the run. Two
 * of the stages print nothing when they pass (tsc, eslint), so a stage with
 * no result line of its own counts as passed when a later stage ran. A stage
 * the log ends in, without a result line, counts as failed: a killed or
 * truncated run must not read as a pass.
 *
 * Before the chain starts, `npm run review` takes the machine-wide gate lock
 * (scripts/review-gate.mjs `run`) and may wait for it. What it prints then,
 * and nothing printed after the type-check banner, is a zone of its own in
 * front of type-check: waiting lines, and a failure of `run` itself (the wait
 * cap among them). It is shown as a `gate lock` line ahead of the stages, and
 * only for a log that has such lines. A hold-cap kill, which the runner prints
 * while the chain runs, fails the stage the log was in.
 *
 * The vitest section is mostly pino JSON lines (`{"level":"error",...}`)
 * that tests print on purpose while they exercise error paths. They are test
 * output, not gate output, and are skipped before anything else looks at a
 * line.
 */
import { stripVTControlCharacters } from 'node:util';

/** The stages of `npm run review`, in chain order. */
export const STAGES = Object.freeze([
  { id: 'type-check', label: 'type-check' },
  { id: 'eslint', label: 'eslint' },
  { id: 'prettier', label: 'prettier' },
  { id: 'vite', label: 'vite build' },
  { id: 'build-output', label: 'build-output check' },
  { id: 'vitest', label: 'vitest' },
  { id: 'coverage-floor', label: 'coverage floor' },
  { id: 'seal', label: 'seal' },
]);

/** Error lines shown under a failed stage before "... and N more". */
const MAX_DETAILS = 5;
/** A longer line is cut, so one tsc message cannot fill the screen. */
const MAX_LINE = 200;
/** Wide enough for the longest label plus two spaces. */
const LABEL_WIDTH = 20;

/** Index of each stage in STAGES, which is also the scanner's zone number. */
const ZONE = Object.freeze(
  Object.fromEntries(STAGES.map((stage, index) => [stage.id, index])),
);

// What a pino logger prints. Tests that exercise error paths log these on
// purpose; they are never gate output.
const PINO = /^\{"level":/;

const REVIEW_BANNER = /^> \S+ review$/;
const TYPECHECK_BANNER = /^> \S+ type-check$/;
const TSC_ERROR = /\berror TS\d+:/;
// eslint's stylish formatter: `  12:5  error  <message>  <rule>`, where a
// parsing error has no rule.
const ESLINT_ISSUE = /^ *(\d+):\d+ {2,}(error|warning)\b(.*)$/;
const ESLINT_SUMMARY = /^✖ \d+ problems? \((\d+) errors?, \d+ warnings?\)/;
// prettier --write: `<file> 12ms (unchanged)` per file, `[error] ...` on failure.
const PRETTIER_TIMING = /^\S+ \d+(?:\.\d+)?ms(?: \([a-z]+\))?$/;
const PRETTIER_DIAGNOSTIC = /^\[(?:error|warn)\] /;
const VITE_BANNER = /^vite v\S+ building\b/;
const VITE_FAILED = /^(?:error during build:|✗ Build failed\b)/;
// The stages that fail through `console.error` (build-output, the coverage
// floor, the review gate) allow the `npm : ` that Windows PowerShell 5.1 puts
// in front of the first stderr line it merges with `2>&1`.
const BUILD_OUTPUT = /^(?:\S+ : )?build output: (.*)$/;
const VITEST_RUN = /^\s*RUN\s+v\d/;
// vitest's totals, `Tests  1 failed | 16014 passed (16019)`: a count and a
// status word, so a test that prints "Tests ..." itself is not mistaken for them.
const VITEST_FILES =
  /^\s*Test Files\s+(\d+ (?:passed|failed|skipped|todo)\b.*)$/;
const VITEST_TESTS = /^\s*Tests\s+(\d+ (?:passed|failed|skipped|todo)\b.*)$/;
// vitest prints ` FAIL  <file> > <test>`: one space before, two after. A test
// that prints its own `FAIL ...` line is not a failed test.
const VITEST_FAIL = /^ FAIL {2}(\S.*)$/;
const VITEST_UNHANDLED = /^Vitest caught \d+ unhandled errors?\b/;
const VITEST_COVERAGE_ERROR = /^ERROR: (?:Coverage|Uncovered) /;
const FLOOR_RESULT = /^(?:\S+ : )?coverage floor: (OK|FAILED)\b/;
const FLOOR_VIOLATION =
  /^(?:\S+ : )?\S+: (?:branches|functions|lines) \d+(?:\.\d+)?% < \d+%$/;
const SEAL_OK = /^review-gate: sealed\b/;
const SEAL_FAILED = /^(?:\S+ : )?review-gate seal failed:/;
// `review-gate clear` runs before type-check, so its failure belongs there.
const CLEAR_FAILED = /^(?:\S+ : )?review-gate clear failed:/;
const SHELL_PREFIX = /^\S+ : /;
// The gate lock. `run` prints these before the chain starts: a line for each
// holder it queues behind (gate-lock.mjs) and, when it cannot go on, its own
// message: `review-gate run failed: ...` (the 120 min wait cap among them) or
// `review-gate run: ...` (a usage problem, such as no review:steps).
const GATE_WAITING = /^(?:\S+ : )?review-gate: waiting for the gate\b/;
const GATE_RUN_FAILED = /^(?:\S+ : )?review-gate run(?: failed)?: /;
// The runner (gate-runner.mjs) prints this when the chain outlives the hold
// cap. It is matched by the start of the line only: the wait-cap message says
// "hold cap" too, and so can any test.
const HOLD_CAP = /^(?:\S+ : )?review-gate: the chain hit the\b/;

/** Lines that start a later zone, as [zone, test]. Zones only move forward. */
const ZONE_STARTS = [
  [
    ZONE.prettier,
    (line) => PRETTIER_TIMING.test(line) || PRETTIER_DIAGNOSTIC.test(line),
  ],
  [ZONE.vite, (line) => VITE_BANNER.test(line)],
  [ZONE['build-output'], (line) => BUILD_OUTPUT.test(line)],
  [ZONE.vitest, (line) => VITEST_RUN.test(line) || VITEST_FILES.test(line)],
  [ZONE['coverage-floor'], (line) => FLOOR_RESULT.test(line)],
  [ZONE.seal, (line) => SEAL_OK.test(line) || SEAL_FAILED.test(line)],
];

/**
 * Decode a log read as bytes. Windows PowerShell 5.1 writes `>` redirects as
 * UTF-16LE with a BOM; a UTF-8 BOM is dropped too.
 *
 * @param {Buffer} buffer
 * @returns {string}
 */
export function decodeLog(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  const text = buffer.toString('utf8');
  return text.startsWith('\uFEFF') ? text.slice(1) : text;
}

/** @param {string} text */
function clip(text) {
  return text.length > MAX_LINE ? `${text.slice(0, MAX_LINE - 3)}...` : text;
}

/** Forward slashes, no trailing slash. */
function normalizeSlashes(file) {
  let result = file.replaceAll('\\', '/');
  while (result.length > 1 && result.endsWith('/'))
    result = result.slice(0, -1);
  return result;
}

/**
 * `file` relative to `root` when it sits under it (case-insensitive, because
 * Windows drive letters vary in case); otherwise `file` with forward slashes.
 *
 * @param {string} file
 * @param {string | undefined} root
 */
function relativeTo(file, root) {
  const path = normalizeSlashes(file);
  if (!root) return path;
  const prefix = `${normalizeSlashes(root)}/`;
  return path.toLowerCase().startsWith(prefix.toLowerCase())
    ? path.slice(prefix.length)
    : path;
}

/**
 * What the scanner collected. `evidence` holds, per stage, whether its output
 * was seen, showed a failure, or showed a pass.
 */
function emptyScan() {
  return {
    evidence: Object.fromEntries(
      STAGES.map(({ id }) => [
        id,
        { seen: false, failed: false, passed: false },
      ]),
    ),
    tsc: [],
    eslintIssues: [],
    eslintSummaryErrors: 0,
    eslintSummaryLine: '',
    prettier: [],
    vite: [],
    buildOutputProblems: [],
    buildOutputFooter: '',
    failedTests: new Set(),
    vitestErrors: [],
    testFiles: '',
    tests: '',
    floorFooter: '',
    floorViolations: [],
    clearFailed: '',
    sealFailed: '',
    sealLine: '',
    gateWaiting: [],
    gateFailure: '',
    /** @type {{ id: string, line: string } | null} */
    holdCap: null,
  };
}

/** `line` without the `npm : ` PowerShell may have put in front of it. */
function withoutShellPrefix(line) {
  return line.replace(SHELL_PREFIX, '');
}

/** Collapse runs of spaces: `Tests  1 failed` -> `Tests 1 failed`. */
function squash(text) {
  return text.replaceAll(/\s+/g, ' ').trim();
}

/**
 * The rule at the end of an eslint issue's text, set off by two or more
 * spaces ("message   rule"); undefined for a parsing error, which has none.
 *
 * @param {string} rest
 */
function ruleOf(rest) {
  const gap = rest.lastIndexOf('  ');
  const rule = gap === -1 ? '' : rest.slice(gap).trim();
  return rule === '' || /\s/.test(rule) ? undefined : rule;
}

/**
 * A line of the numbered code frame under a prettier error
 * (`[error] > 1 | ...`), which is not an error of its own.
 *
 * @param {string} line a line starting `[error] `
 */
function isCodeFrame(line) {
  const body = line.slice('[error]'.length).trimStart();
  const afterMarker = body.startsWith('>') ? body.slice(1).trimStart() : body;
  const gutter = afterMarker.indexOf('|');
  return gutter !== -1 && /^\d*$/.test(afterMarker.slice(0, gutter).trim());
}

/** Scan the type-check and eslint zone: tsc errors and eslint's report. */
function scanLint(scan, line, state, root) {
  if (TSC_ERROR.test(line)) {
    scan.evidence['type-check'].failed = true;
    scan.tsc.push(line.trim());
    return;
  }
  const issue = ESLINT_ISSUE.exec(line);
  if (issue) {
    const [, lineNo, severity, rest = ''] = issue;
    scan.eslintIssues.push({
      file: relativeTo(state.eslintFile, root),
      line: lineNo,
      severity,
      text: ruleOf(rest) ?? rest.trim(),
    });
    return;
  }
  const summary = ESLINT_SUMMARY.exec(line);
  if (summary) {
    scan.eslintSummaryErrors = Number(summary[1]);
    scan.eslintSummaryLine = line;
    return;
  }
  // An unindented line that is not the next banner is eslint's file header.
  if (line !== '' && !/^\s/.test(line) && !line.startsWith('>')) {
    state.eslintFile = line;
  }
}

/** Scan the prettier zone: only `[error]` lines that are not a code frame. */
function scanPrettier(scan, line) {
  if (!line.startsWith('[error] ') || isCodeFrame(line)) return;
  scan.evidence.prettier.failed = true;
  scan.prettier.push(line.slice('[error] '.length));
}

/** Scan the vite zone: the line `error during build:` and the lines after it. */
function scanVite(scan, line, state) {
  if (VITE_FAILED.test(line)) {
    scan.evidence.vite.failed = true;
    // The reason follows `error during build:`; a stack of `at ...` frames
    // comes after it.
    state.viteReasonLines = line.startsWith('error during build:') ? 2 : 0;
    return;
  }
  if (state.viteReasonLines > 0 && line !== '' && !/^\s+at /.test(line)) {
    scan.vite.push(line);
    state.viteReasonLines -= 1;
  }
}

/** Scan the build-output check: problem lines, then `OK` or `FAILED, ...`. */
function scanBuildOutput(scan, line) {
  const match = BUILD_OUTPUT.exec(line);
  if (!match) return;
  const [, text = ''] = match;
  const evidence = scan.evidence['build-output'];
  if (text.startsWith('OK')) {
    evidence.passed = true;
  } else if (text.startsWith('FAILED')) {
    evidence.failed = true;
    scan.buildOutputFooter = text;
  } else {
    scan.buildOutputProblems.push(text);
  }
}

/** Scan the vitest zone and the lines vitest and the floor check share. */
function scanVitest(scan, line) {
  const failed = VITEST_FAIL.exec(line);
  if (failed) {
    scan.failedTests.add(failed[1] ?? '');
  } else if (VITEST_UNHANDLED.test(line) || VITEST_COVERAGE_ERROR.test(line)) {
    scan.vitestErrors.push(line);
  } else if (FLOOR_VIOLATION.test(line)) {
    scan.floorViolations.push(withoutShellPrefix(line));
  } else {
    const files = VITEST_FILES.exec(line);
    const tests = files ? null : VITEST_TESTS.exec(line);
    if (files) scan.testFiles = squash(`Test Files ${files[1]}`);
    if (tests) scan.tests = squash(`Tests ${tests[1]}`);
  }
}

/** Fold one cleaned line into the scan. */
function scanLine(scan, line, state, root) {
  if (HOLD_CAP.test(line)) {
    // The stage the log was in. Output starts a stage's zone, so a stage that
    // prints nothing yet (the build-output check before its first line) is
    // charged to the one before it; the line itself says what was running.
    const zone = Math.max(state.zone, ZONE['type-check']);
    scan.holdCap ??= { id: STAGES[zone].id, line: withoutShellPrefix(line) };
    return;
  }
  if (state.zone < ZONE['type-check']) {
    if (GATE_WAITING.test(line)) {
      scan.gateWaiting.push(withoutShellPrefix(line));
      return;
    }
    if (GATE_RUN_FAILED.test(line)) {
      scan.gateFailure ||= withoutShellPrefix(line);
      return;
    }
  }
  if (CLEAR_FAILED.test(line)) {
    scan.evidence['type-check'].failed = true;
    scan.clearFailed = withoutShellPrefix(line);
    return;
  }
  if (REVIEW_BANNER.test(line)) scan.evidence['type-check'].seen = true;
  if (TYPECHECK_BANNER.test(line)) {
    scan.evidence['type-check'].seen = true;
    state.zone = Math.max(state.zone, ZONE['type-check']);
    return;
  }
  for (const [zone, starts] of ZONE_STARTS) {
    if (zone > state.zone && starts(line)) state.zone = zone;
  }
  const id = STAGES[state.zone]?.id;
  if (id !== undefined && state.zone >= ZONE.prettier) {
    scan.evidence[id].seen = true;
  }

  if (state.zone === ZONE['type-check']) scanLint(scan, line, state, root);
  else if (state.zone === ZONE.prettier) scanPrettier(scan, line);
  else if (state.zone === ZONE.vite) scanVite(scan, line, state);
  else if (state.zone === ZONE['build-output']) scanBuildOutput(scan, line);
  else if (state.zone >= ZONE.vitest) scanResultLines(scan, line);
}

/** The zones from vitest on: vitest's output, the floor check, the seal. */
function scanResultLines(scan, line) {
  scanVitest(scan, line);
  const floor = FLOOR_RESULT.exec(line);
  if (floor) {
    scan.evidence['coverage-floor'][floor[1] === 'OK' ? 'passed' : 'failed'] =
      true;
    if (floor[1] === 'FAILED') scan.floorFooter = withoutShellPrefix(line);
  }
  if (SEAL_OK.test(line)) {
    scan.evidence.seal.passed = true;
    scan.sealLine = line;
  } else if (SEAL_FAILED.test(line)) {
    scan.evidence.seal.failed = true;
    scan.sealFailed = withoutShellPrefix(line);
  }
}

/** Settle vitest's evidence once the whole log is read. */
function settleVitest(scan) {
  const evidence = scan.evidence.vitest;
  const totalsFailed = /\bfailed\b/.test(`${scan.testFiles} ${scan.tests}`);
  evidence.failed =
    scan.failedTests.size > 0 || scan.vitestErrors.length > 0 || totalsFailed;
  evidence.passed = !evidence.failed && scan.testFiles !== '';
}

/** eslint's evidence: it prints nothing on a pass, so only errors count. */
function settleEslint(scan) {
  const errors = scan.eslintIssues.filter((i) => i.severity === 'error');
  scan.evidence.eslint.failed =
    errors.length > 0 || scan.eslintSummaryErrors > 0;
}

/**
 * The `gate lock` line: null for a log with nothing about the lock in it.
 * Otherwise `fail` when `run` itself failed (the wait cap among the reasons) or
 * the log ends while still waiting, and `pass` for a run that waited and then
 * started the chain. `chainStarted` is whether the chain started: the
 * type-check banner was seen, or its first step, `clear`, failed.
 *
 * @returns {{ status: 'pass' | 'fail', details: string[], note: string } | null}
 */
function settleGate(scan, chainStarted) {
  const waiting = scan.gateWaiting.at(-1);
  if (scan.gateFailure !== '') {
    // Not clipped: the message is bounded by the CLI, and its end says what to
    // do (the wait cap: report to the owner, stop nobody's process).
    return { status: 'fail', details: [scan.gateFailure], note: '' };
  }
  if (waiting === undefined) return null;
  if (!chainStarted) {
    return {
      status: 'fail',
      details: [
        'no result: the log ends while waiting for the gate',
        clip(waiting),
      ],
      note: '',
    };
  }
  // `review-gate: waiting for the gate in <worktree> (pid N, running M min)`
  const holder = waiting.replace(/^review-gate: waiting /, '');
  return { status: 'pass', details: [], note: `waited ${holder}` };
}

/** `list` capped to MAX_DETAILS, plus a count of the rest. */
function capped(list) {
  if (list.length <= MAX_DETAILS) return list;
  return [
    ...list.slice(0, MAX_DETAILS),
    `... and ${list.length - MAX_DETAILS} more`,
  ];
}

/** The detail lines for a stage that failed on evidence. */
function detailsFor(id, scan) {
  switch (id) {
    case 'type-check':
      // The gate's `clear` step runs first; when it fails, tsc never ran.
      if (scan.clearFailed) return [clip(scan.clearFailed)];
      return capped(scan.tsc.map(clip));
    case 'eslint': {
      const errors = scan.eslintIssues.filter((i) => i.severity === 'error');
      if (errors.length === 0) return [clip(scan.eslintSummaryLine)];
      return capped(errors.map((i) => clip(`${i.file}:${i.line} ${i.text}`)));
    }
    case 'prettier':
      return capped(scan.prettier.map(clip));
    case 'vite':
      return capped(scan.vite.map(clip));
    case 'build-output':
      return capped(
        (scan.buildOutputProblems.length > 0
          ? scan.buildOutputProblems
          : [scan.buildOutputFooter]
        ).map(clip),
      );
    case 'vitest': {
      const names = [...scan.failedTests].map((name) => `FAIL ${name}`);
      const totals = [scan.testFiles, scan.tests].filter(Boolean);
      return [...capped([...names, ...scan.vitestErrors].map(clip)), ...totals];
    }
    case 'coverage-floor':
      return capped(
        [scan.floorFooter, ...scan.floorViolations].filter(Boolean).map(clip),
      );
    default:
      return scan.sealFailed === '' ? [] : [clip(scan.sealFailed)];
  }
}

/** `details` of a failed stage, with the hold-cap line first when it hit that stage. */
function withHoldCap(id, details, scan) {
  // Not clipped: the runner already cuts the command it names.
  return scan.holdCap?.id === id ? [scan.holdCap.line, ...details] : details;
}

/**
 * Parse the text of an `npm run review` log.
 *
 * `status` is `pass`, `fail` or `not reached`. `details` are the lines to
 * print under a failed stage; `note` is a short suffix for a passed one (the
 * vitest totals). `recognised` is false when the text holds nothing of a
 * review run, so a caller can tell "wrong file" from "run failed".
 *
 * @param {string} text
 * @param {{ root?: string }} [options] root: repo root to strip from eslint paths.
 */
export function parseReviewLog(text, { root } = {}) {
  const scan = emptyScan();
  const state = { zone: -1, eslintFile: '', viteReasonLines: 0 };

  for (const raw of text.split(/\r?\n/)) {
    const line = stripVTControlCharacters(raw).trimEnd();
    if (!PINO.test(line)) scanLine(scan, line, state, root);
  }
  settleVitest(scan);
  settleEslint(scan);
  // The hold cap fails the stage it interrupted, whatever else the stage's own
  // output said: the stages after it were never reached.
  if (scan.holdCap !== null) scan.evidence[scan.holdCap.id].failed = true;
  // The chain's first step, `clear`, prints no banner before it, so a failed
  // `clear` is proof that the chain started, banner or not.
  const chainStarted =
    state.zone >= ZONE['type-check'] || scan.clearFailed !== '';
  const gate = settleGate(scan, chainStarted);
  // The review banner alone makes type-check "seen". A log that ends in the
  // gate zone never started the chain, so type-check was not reached.
  if (gate !== null && !chainStarted) scan.evidence['type-check'].seen = false;

  let reached = -1;
  for (const [index, { id }] of STAGES.entries()) {
    const { seen, failed, passed } = scan.evidence[id];
    if (seen || failed || passed) reached = index;
  }

  const stages = STAGES.map(({ id, label }, index) => {
    const { failed, passed } = scan.evidence[id];
    if (failed) {
      return {
        id,
        label,
        status: 'fail',
        details: withHoldCap(id, detailsFor(id, scan), scan),
        note: '',
      };
    }
    if (index < reached || (index === reached && passed)) {
      const note =
        id === 'vitest'
          ? [scan.testFiles, scan.tests].filter(Boolean).join('; ')
          : '';
      return { id, label, status: 'pass', details: [], note };
    }
    if (index === reached) {
      return {
        id,
        label,
        status: 'fail',
        details: ['no result: the log ends in this stage'],
        note: '',
      };
    }
    return { id, label, status: 'not reached', details: [], note: '' };
  });

  return {
    recognised: reached >= 0 || gate !== null,
    stages,
    sealLine: scan.sealLine,
    gate,
  };
}

/**
 * One line per stage, each failed stage followed by its indented error
 * lines, and the seal line last when the log has one.
 *
 * @param {ReturnType<typeof parseReviewLog>} parsed
 * @returns {string[]}
 */
function formatSummary({ stages, sealLine, gate }) {
  const lines = [];
  const all =
    gate === null ? stages : [{ label: 'gate lock', ...gate }, ...stages];
  for (const { label, status, details, note } of all) {
    const suffix = note ? `  ${note}` : '';
    lines.push(`${label.padEnd(LABEL_WIDTH)}${status}${suffix}`);
    for (const detail of details) lines.push(`  ${detail}`);
  }
  if (sealLine) lines.push(sealLine);
  return lines;
}

/**
 * Parse and format in one call, for the CLI. `ok` is true only when the log
 * is recognised and every stage passed.
 *
 * @param {string} text
 * @param {{ root?: string }} [options]
 */
export function summarizeReviewLog(text, options) {
  const parsed = parseReviewLog(text, options);
  const ok =
    parsed.recognised &&
    (parsed.gate === null || parsed.gate.status === 'pass') &&
    parsed.stages.every((stage) => stage.status === 'pass');
  return {
    recognised: parsed.recognised,
    ok,
    lines: parsed.recognised ? formatSummary(parsed) : [],
  };
}
