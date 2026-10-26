/**
 * Per-file coverage floor: pure logic, no I/O. The CLI wrapper is
 * scripts/check-coverage-floor.mjs, which `npm run review` runs after
 * `vitest run --coverage`.
 *
 * Why a script instead of vitest config: `coverage.thresholds.perFile` is one
 * global switch that would also turn the aggregate 90/80/90/90 thresholds
 * into per-file ones. So vitest keeps the aggregates and this module checks
 * every file in coverage/lcov.info against a lower per-file floor.
 * Spec: docs/superpowers/specs/coverage-floors-2026-10-26.md.
 */

/**
 * Per-file minimum percentages: today's lowest file per metric, rounded down
 * (50.0 / 50.0 / 63.6 on 2026-10-26). Raise by hand after a test pass; never
 * lower one to make a file pass.
 */
export const FLOORS = Object.freeze({ branches: 50, functions: 50, lines: 60 });

/** Metrics in report order. lcov has no statement counts. */
export const METRICS = Object.freeze(['branches', 'functions', 'lines']);

/** lcov summary tag -> [metric, field]. Every other tag is detail and ignored. */
const SUMMARY_TAGS = Object.freeze({
  BRF: ['branches', 'found'],
  BRH: ['branches', 'hit'],
  FNF: ['functions', 'found'],
  FNH: ['functions', 'hit'],
  LF: ['lines', 'found'],
  LH: ['lines', 'hit'],
});

/** metric -> [found tag, hit tag], for error messages. */
const TAG_PAIRS = Object.freeze({
  branches: ['BRF', 'BRH'],
  functions: ['FNF', 'FNH'],
  lines: ['LF', 'LH'],
});

const COUNT = /^\d+$/;
const ABSOLUTE = /^(?:[A-Za-z]:)?\//;

/** A structural problem in the lcov text, tagged with its 1-based line. */
export class LcovParseError extends Error {
  constructor(line, message) {
    super(`line ${line}: ${message}`);
    this.name = 'LcovParseError';
    this.line = line;
  }
}

/**
 * Forward slashes, repo-relative. Relative paths (what vitest writes) only
 * lose a leading `./`. Absolute paths lose `root` when they sit under it,
 * compared case-insensitively because Windows drive letters vary in case.
 * An absolute path outside `root` stays absolute, so it is visibly wrong
 * rather than guessed at.
 */
function toRepoRelative(rawPath, root) {
  const file = rawPath.replaceAll('\\', '/');
  if (!ABSOLUTE.test(file)) return file.replace(/^(?:\.\/)+/, '');
  if (root) {
    let base = root.replaceAll('\\', '/');
    while (base.endsWith('/')) base = base.slice(0, -1);
    const prefix = `${base}/`;
    if (file.toLowerCase().startsWith(prefix.toLowerCase())) {
      return file.slice(prefix.length);
    }
  }
  return file;
}

function openRecord(open, value, line, root) {
  if (open !== null) {
    throw new LcovParseError(line, `SF before end_of_record of ${open.file}`);
  }
  if (value === '') throw new LcovParseError(line, 'empty SF path');
  return {
    file: toRepoRelative(value, root),
    counts: { branches: {}, functions: {}, lines: {} },
  };
}

function addCount(open, tag, value, line) {
  if (open === null) throw new LcovParseError(line, `${tag} outside a record`);
  if (!COUNT.test(value)) {
    throw new LcovParseError(
      line,
      `${tag} is not a non-negative integer: "${value}"`,
    );
  }
  const [metric, field] = SUMMARY_TAGS[tag];
  if (open.counts[metric][field] !== undefined) {
    throw new LcovParseError(line, `duplicate ${tag} in ${open.file}`);
  }
  open.counts[metric][field] = Number(value);
}

/** Handle one `TAG:value` line; returns the record that is open afterwards. */
function readTagLine(open, content, line, root) {
  const colon = content.indexOf(':');
  if (colon === -1) return open;
  const tag = content.slice(0, colon);
  const value = content.slice(colon + 1).trim();
  if (tag === 'SF') return openRecord(open, value, line, root);
  if (Object.hasOwn(SUMMARY_TAGS, tag)) addCount(open, tag, value, line);
  return open;
}

function closeRecord(open, line) {
  if (open === null) throw new LcovParseError(line, 'end_of_record without SF');
  const { file, counts } = open;
  const record = { file };
  for (const metric of METRICS) {
    const [foundTag, hitTag] = TAG_PAIRS[metric];
    const { found, hit } = counts[metric];
    // istanbul's lcovonly reporter writes all six tags on every record, even
    // 0/0, so a missing pair means a damaged report, not "nothing to cover".
    if (found === undefined && hit === undefined) {
      throw new LcovParseError(
        line,
        `missing ${foundTag}/${hitTag} in ${file}`,
      );
    }
    if (found === undefined) {
      throw new LcovParseError(
        line,
        `${hitTag} without ${foundTag} in ${file}`,
      );
    }
    if (hit === undefined) {
      throw new LcovParseError(
        line,
        `${foundTag} without ${hitTag} in ${file}`,
      );
    }
    if (hit > found) {
      throw new LcovParseError(
        line,
        `${hitTag} ${hit} > ${foundTag} ${found} in ${file}`,
      );
    }
    record[metric] = { found, hit };
  }
  return record;
}

/**
 * Parse lcov text into one record per `SF:` block:
 * `{ file, lines, functions, branches }`, each `{ found, hit }`, read from the
 * LF/LH, FNF/FNH and BRF/BRH summary lines.
 *
 * Strict on structure, because a truncated or garbled report must fail the
 * gate rather than pass it: throws LcovParseError on a summary line or
 * `end_of_record` outside a record, a nested `SF:`, an empty path, a count
 * that is not a non-negative integer, a duplicate summary tag, hit > found, a
 * summary pair that is missing or half-present, or a final record with no
 * `end_of_record`. Unknown tags are ignored.
 *
 * @param {string} text
 * @param {{ root?: string }} [options] root: absolute repo root to strip.
 */
export function parseLcov(text, { root } = {}) {
  const records = [];
  let open = null;
  let lastLine = 0;
  const lines = text.split(/\r?\n/);

  for (const [index, rawLine] of lines.entries()) {
    const content = rawLine.trim();
    if (content === '') continue;
    lastLine = index + 1;
    if (content === 'end_of_record') {
      records.push(closeRecord(open, lastLine));
      open = null;
    } else {
      open = readTagLine(open, content, lastLine, root);
    }
  }

  if (open !== null) {
    throw new LcovParseError(
      lastLine,
      `unterminated record for ${open.file} (no end_of_record)`,
    );
  }
  return records;
}

/** Percentage covered; 0 found counts as 100 (nothing to cover). */
function percent({ found, hit }) {
  return found === 0 ? 100 : (hit * 100) / found;
}

/**
 * Every (file, metric) below its FLOORS entry, in record order then METRICS
 * order: `{ file, metric, pct, floor }`. A metric with 0 found passes. Exactly
 * on the floor passes.
 */
export function checkFloors(records) {
  const violations = [];
  for (const record of records) {
    for (const metric of METRICS) {
      const floor = FLOORS[metric];
      const { found, hit } = record[metric];
      // hit / found < floor / 100, in integers so the boundary is exact.
      if (found > 0 && hit * 100 < floor * found) {
        violations.push({
          file: record.file,
          metric,
          pct: percent(record[metric]),
          floor,
        });
      }
    }
  }
  return violations;
}

/**
 * One decimal, truncated rather than rounded so a failing 49.96% never prints
 * as "50.0%". The epsilon absorbs float noise in pct * 10.
 */
function formatPct(pct) {
  return `${(Math.floor(pct * 10 + 1e-9) / 10).toFixed(1)}%`;
}

/** `api/x.ts: branches 42.0% < 50%` */
export function formatViolation({ file, metric, pct, floor }) {
  return `${file}: ${metric} ${formatPct(pct)} < ${floor}%`;
}

/**
 * The lowest-covered file per metric, `{ file, pct }`, or null when no file
 * measures that metric. 0-found metrics are skipped; ties keep the first file.
 */
export function lowestByMetric(records) {
  const lowest = Object.fromEntries(METRICS.map((metric) => [metric, null]));
  for (const record of records) {
    for (const metric of METRICS) {
      if (record[metric].found === 0) continue;
      const pct = percent(record[metric]);
      if (lowest[metric] === null || pct < lowest[metric].pct) {
        lowest[metric] = { file: record.file, pct };
      }
    }
  }
  return lowest;
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function describeFloors() {
  const labels = METRICS.map((metric) => `${metric} ${FLOORS[metric]}%`);
  return `floors: ${labels.join(', ')}`;
}

function describeLowest(metric, entry) {
  if (entry === null) return `${metric} n/a`;
  return `${metric} ${formatPct(entry.pct)} ${entry.file}`;
}

/**
 * Parse + check in one call, for the CLI. Returns `{ ok, messages }`; never
 * throws on bad lcov text. Fails on a malformed report, on a report with no
 * records, and on any violation (one message per violation, then a footer).
 * Passes with a one-line summary: files checked and the lowest file per metric.
 *
 * @param {string} text
 * @param {{ root?: string }} [options] root: absolute repo root to strip.
 */
export function evaluateLcov(text, { root } = {}) {
  let records;
  try {
    records = parseLcov(text, { root });
  } catch (err) {
    if (!(err instanceof LcovParseError)) throw err;
    return {
      ok: false,
      messages: [
        `coverage floor: FAILED, malformed lcov report: ${err.message}`,
      ],
    };
  }

  if (records.length === 0) {
    return {
      ok: false,
      messages: [
        'coverage floor: FAILED, the lcov report has no file records (no SF: lines). ' +
          'Refusing to pass an empty report.',
      ],
    };
  }

  const floorText = describeFloors();
  const violations = checkFloors(records);
  if (violations.length > 0) {
    const failingFiles = new Set(violations.map((v) => v.file)).size;
    const footer =
      `coverage floor: FAILED, ${plural(violations.length, 'violation')} in ` +
      `${plural(failingFiles, 'file')} of ${records.length} checked (${floorText}). ` +
      'Add tests; the floors live in scripts/_lib/coverage-floor.mjs.';
    return {
      ok: false,
      messages: [...violations.map(formatViolation), footer],
    };
  }

  const lowest = lowestByMetric(records);
  const lowestText = METRICS.map((metric) =>
    describeLowest(metric, lowest[metric]),
  ).join(', ');
  return {
    ok: true,
    messages: [
      `coverage floor: OK, ${plural(records.length, 'file')} checked (${floorText}); ` +
        `lowest: ${lowestText}`,
    ],
  };
}
