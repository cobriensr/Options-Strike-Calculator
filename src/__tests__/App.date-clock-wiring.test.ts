import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Guards App.tsx's half of the date clock. useVixData owns the one ET clock
 * (`useETToday`): the selected date follows it and it comes back as
 * `vix.etToday`. Everything in App that judges the date "past" or feeds a
 * hook the date's "today" must read that value, not the wall clock, or in
 * the moment after ET midnight (before the clock ticks) the followed date
 * reads as past. Each of those compiles with `getETToday()` or an omitted
 * argument in its place, and the hooks' own tests pass the value by prop, so
 * only this test pins the wiring. Mounting <App /> in jsdom is too heavy (see
 * App.panel-render.test.tsx), so this reads the source the way
 * App.iv-mode-wiring.test.ts does.
 */
const appSource = readFileSync(path.resolve(__dirname, '../App.tsx'), 'utf-8');

/**
 * App.tsx without comments, so a comment that names a call doesn't count.
 * The `[^:]` keeps a URL's `//` (App.tsx has none in strings today).
 */
const appCode = appSource
  .replaceAll(/\/\*[\s\S]*?\*\//g, '')
  .replaceAll(/(^|[^:])\/\/.*$/gm, '$1');

/** The top-level arguments of the first `<name>(...)` call, trimmed. */
function callArgs(name: string): string[] {
  const match = new RegExp(String.raw`\b${name}\(([\s\S]*?)\n?\s*\)`).exec(
    appCode,
  );
  if (!match) throw new Error(`Could not locate ${name}( in App.tsx`);
  return match[1]!
    .split(',')
    .map((arg) => arg.trim())
    .filter((arg) => arg !== '');
}

/** The text inside the parentheses of every `<name>(...)` call, balanced. */
function callBodies(name: string): string[] {
  const bodies: string[] = [];
  for (const match of appCode.matchAll(
    new RegExp(String.raw`\b${name}\(`, 'g'),
  )) {
    const start = match.index + match[0].length;
    let depth = 1;
    let end = start;
    while (end < appCode.length && depth > 0) {
      if (appCode[end] === '(') depth += 1;
      else if (appCode[end] === ')') depth -= 1;
      end += 1;
    }
    bodies.push(appCode.slice(start, end - 1));
  }
  return bodies;
}

/** The body and dependency list of `const backtestMode = useMemo(...)`. */
function backtestMemo(): { body: string; deps: string[] } {
  const match =
    /const backtestMode = useMemo\(\(\) => \{([\s\S]*?)\n {2}\}, \[([^\]]*)\]\);/.exec(
      appCode,
    );
  if (!match) throw new Error('Could not locate backtestMode in App.tsx');
  return {
    body: match[1]!,
    deps: match[2]!
      .split(',')
      .map((dep) => dep.trim())
      .filter((dep) => dep !== ''),
  };
}

describe('App date-clock wiring', () => {
  it('hands useEventsForDate the date clock as its etToday', () => {
    expect(callArgs('useEventsForDate')).toEqual([
      'vix.selectedDate',
      'vix.etToday',
      'market.data.events',
      '!market.loading',
    ]);
  });

  it('judges the analysis flag against the date clock', () => {
    expect(callArgs('isPastETDate')).toEqual([
      'vix.selectedDate',
      'vix.etToday',
    ]);
    expect(appCode).toMatch(
      /const analysisIsBacktest = isPastETDate\(\s*vix\.selectedDate,/,
    );
  });

  it('judges the BACKTEST badge against the date clock, and re-runs when it ticks', () => {
    const { body, deps } = backtestMemo();
    expect(body).toMatch(
      /isBacktestMode\(\s*vix\.selectedDate,[^;]*,\s*new Date\(\),\s*vix\.etToday,?\s*\)/,
    );
    expect(deps).toContain('vix.etToday');
  });

  it('makes no other past-date judgment, which would read the wall clock', () => {
    // Fails closed: a new call changes the count. And every call, whatever
    // the count, has to carry the date clock, so raising the count here is
    // not enough to let a wall-clock call in.
    for (const name of ['isPastETDate', 'isBacktestMode']) {
      const bodies = callBodies(name);
      expect(bodies, name).toHaveLength(1);
      for (const body of bodies) expect(body, name).toMatch(/\bvix\.etToday\b/);
    }
  });

  it('hands IVInputSection the date clock, which keys its term-structure card', () => {
    const props = /<IVInputSection([\s\S]*?)\/>/.exec(appCode)?.[1];
    expect(props).toMatch(/^\s+selectedDate=\{vix\.selectedDate\}$/m);
    expect(props).toMatch(/^\s+etToday=\{vix\.etToday\}$/m);
  });

  it('hands AdvancedSection the date clock, which decides its no-VIX-data hint', () => {
    const props = /<AdvancedSection([\s\S]*?)\/>/.exec(appCode)?.[1];
    expect(props).toMatch(/^\s+selectedDate=\{vix\.selectedDate\}$/m);
    expect(props).toMatch(/^\s+etToday=\{vix\.etToday\}$/m);
  });

  it('hands the snapshot save the date clock through its meta', () => {
    const source = /buildSnapshotMeta\(\{([\s\S]*?)\n {4}\}\)/.exec(
      appCode,
    )?.[1];
    expect(source).toMatch(/^\s+selectedDate: vix\.selectedDate,$/m);
    expect(source).toMatch(/^\s+etToday: vix\.etToday,$/m);
  });

  it('hands useAutoFill the vix object, which carries the date clock', () => {
    const inputs = /useAutoFill\(\{([\s\S]*?)\}\);/.exec(appCode)?.[1];
    expect(inputs).toMatch(/^\s+vix,$/m);
  });

  it('runs no clock of its own', () => {
    expect(appCode).not.toMatch(/\buseETToday\b/);
    expect(appCode).not.toMatch(/\bgetETToday\b/);
  });
});
