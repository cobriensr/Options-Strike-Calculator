// @vitest-environment node

/**
 * The Fed's FOMC decision-day calendar has one TypeScript home,
 * `api/_lib/fomc-schedule.ts`. Two copies live outside it in the ML code, and
 * a copy that drifts silently mislabels history (the csv once carried
 * 2025-05-01 for a meeting decided on 2025-05-07). The two drift guards below
 * read those files and fail the build when they disagree with the module.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FOMC_DECISION_DATES,
  isFomcDecisionDay,
  isSepMeeting,
} from '../_lib/fomc-schedule.js';

describe('isFomcDecisionDay', () => {
  it.each([
    ['2025-12-10', 'a 2025 decision day'],
    ['2026-04-29', 'the April 2026 decision, not 2026-05-06'],
    ['2026-07-29', 'a 2026 decision day'],
    ['2026-10-28', 'the latest decision day before the 2026-11-06 fix'],
    ['2027-06-09', 'a 2027 decision day'],
  ])('is true for %s (%s)', (date) => {
    expect(isFomcDecisionDay(date)).toBe(true);
  });

  it.each([
    ['2025-12-17', 'a week after the 2025-12-10 decision'],
    ['2026-05-06', 'the wrong April 2026 date the code used to carry'],
    ['2026-04-28', 'day 1 of the April 2026 meeting, not the decision'],
    ['2026-11-06', 'a day with no meeting'],
    ['', 'an empty string'],
    ['2026-4-29', 'an unpadded date'],
    ['2026-04-29T12:00:00Z', 'a timestamp, not a YYYY-MM-DD date'],
  ])('is false for %s (%s)', (date) => {
    expect(isFomcDecisionDay(date)).toBe(false);
  });
});

describe('isSepMeeting', () => {
  it.each(['2026-09-16', '2027-03-17'])('is true for %s', (date) => {
    expect(isSepMeeting(date)).toBe(true);
  });

  it('is false for a decision day with no projections (2026-10-28)', () => {
    expect(isFomcDecisionDay('2026-10-28')).toBe(true);
    expect(isSepMeeting('2026-10-28')).toBe(false);
  });

  it('is false for a day with no meeting', () => {
    expect(isSepMeeting('2026-11-06')).toBe(false);
  });

  it('only ever marks a decision day, and marks four a year', () => {
    // Scan every day from the first listed year to the last, so a year added
    // to the schedule is checked without editing this test.
    const firstYear = Number.parseInt(
      FOMC_DECISION_DATES[0]?.slice(0, 4) ?? '',
      10,
    );
    const lastYear = Number.parseInt(
      FOMC_DECISION_DATES.at(-1)?.slice(0, 4) ?? '',
      10,
    );
    const sepDays: string[] = [];
    const cursor = new Date(Date.UTC(firstYear, 0, 1));
    const end = Date.UTC(lastYear, 11, 31);
    while (cursor.getTime() <= end) {
      const day = cursor.toISOString().slice(0, 10);
      if (isSepMeeting(day)) sepDays.push(day);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    expect(sepDays.filter((d) => !isFomcDecisionDay(d))).toEqual([]);
    for (let year = firstYear; year <= lastYear; year++) {
      expect(sepDays.filter((d) => d.startsWith(`${year}-`))).toHaveLength(4);
    }
    expect(sepDays).toHaveLength(4 * (lastYear - firstYear + 1));
  });
});

describe('FOMC_DECISION_DATES', () => {
  it('holds the 8 decision days of each year from 2025 to 2027', () => {
    for (const year of ['2025', '2026', '2027']) {
      expect(
        FOMC_DECISION_DATES.filter((d) => d.startsWith(year)),
      ).toHaveLength(8);
    }
    expect(FOMC_DECISION_DATES).toHaveLength(24);
  });

  it('is sorted ascending with no duplicates, all as YYYY-MM-DD', () => {
    expect(
      FOMC_DECISION_DATES.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
    ).toBe(true);
    expect([...FOMC_DECISION_DATES]).toEqual(
      [...new Set(FOMC_DECISION_DATES)].sort(),
    );
  });
});

/**
 * Drift guard, Python. `ml/src/options_features/calendar.py` keeps its own
 * `FOMC_DATES` frozenset of `date(Y, M, D)` entries, starting in 2024. The
 * 2024 entries have no TypeScript counterpart, so only dates from 1 January
 * of the first TypeScript year on are compared; any other date present on one
 * side only fails, including an early-year date that sits before the first
 * TypeScript date.
 */
const PYTHON_DATE_ENTRY =
  /date\(\s*(\d{4})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})\s*\)/g;

function readPythonFomcDates(): string[] {
  const source = readFileSync(
    resolve(process.cwd(), 'ml', 'src', 'options_features', 'calendar.py'),
    'utf8',
  );
  const literal =
    /^FOMC_DATES\b[^=\n]*=\s*frozenset\(\s*\{([\s\S]*?)\}\s*\)/m.exec(source);
  if (literal?.[1] == null) {
    throw new Error('calendar.py: could not find the FOMC_DATES literal');
  }
  // Drop `# ...` comments so a commented-out date( ) entry is not counted.
  const body = literal[1].replaceAll(/#.*$/gm, '');
  // An entry written any other way (`date.fromisoformat('2028-01-26')`) would
  // be skipped by the match below, so require that nothing but `date(Y, M, D)`
  // entries, commas and whitespace is in the literal.
  const unparsed = body
    .replaceAll(PYTHON_DATE_ENTRY, '')
    .replaceAll(/[\s,]/g, '');
  if (unparsed !== '') {
    throw new Error(
      `calendar.py: FOMC_DATES holds an entry other than date(Y, M, D): ${unparsed}`,
    );
  }
  const dates = [
    ...new Set(
      [...body.matchAll(PYTHON_DATE_ENTRY)].map(
        ([, y, m, d]) => `${y}-${m?.padStart(2, '0')}-${d?.padStart(2, '0')}`,
      ),
    ),
  ].sort();
  if (dates.length === 0) {
    throw new Error('calendar.py: FOMC_DATES held no date(Y, M, D) entries');
  }
  return dates;
}

describe('drift guard: ml/src/options_features/calendar.py', () => {
  it('holds the same decision days as FOMC_DECISION_DATES (2024 aside)', () => {
    const firstTsYear = (FOMC_DECISION_DATES[0] ?? '').slice(0, 4);
    const pythonDates = readPythonFomcDates().filter(
      (d) => d >= `${firstTsYear}-01-01`,
    );
    expect(
      pythonDates,
      'ml/src/options_features/calendar.py FOMC_DATES and api/_lib/fomc-schedule.ts FOMC_DECISION_DATES must hold the same dates: edit both together',
    ).toEqual([...FOMC_DECISION_DATES]);
  });
});

/**
 * Drift guard, csv. `setup_3_overnight_sweep` reads
 * `ml/src/setups_backtest/econ_calendar.csv` (columns `date,event`) to keep
 * the overnight sweep out of event days. The csv is a sample, not the full
 * schedule, so the check is one way: every `FOMC` row must be a decision day.
 */
function readCsvFomcRows(): string[] {
  const lines = readFileSync(
    resolve(process.cwd(), 'ml', 'src', 'setups_backtest', 'econ_calendar.csv'),
    'utf8',
  )
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  expect(lines[0]?.trim()).toBe('date,event');
  return lines
    .slice(1)
    .map((line) => line.split(',').map((cell) => cell.trim()))
    .filter(([, event]) => event === 'FOMC')
    .map(([date]) => date ?? '');
}

describe('drift guard: ml/src/setups_backtest/econ_calendar.csv', () => {
  it('lists FOMC only on decision days', () => {
    const fomcRows = readCsvFomcRows();
    expect(fomcRows.length).toBeGreaterThan(0);
    expect(fomcRows.filter((date) => !isFomcDecisionDay(date))).toEqual([]);
  });
});
