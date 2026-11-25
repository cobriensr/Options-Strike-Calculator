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
 * only this test pins the wiring. This file reads the source, the way
 * App.iv-mode-wiring.test.ts does, so the wiring stays visible without the
 * three dozen module mocks a mounted <App /> needs (App.market-open-gate.test.tsx
 * mounts it, for the polling gate).
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

  it('hands MarketRegimeSection the date clock, which decides what it takes from the live feed', () => {
    // A wall-clock getETToday() in its place would compile.
    const props = /<MarketRegimeSection([\s\S]*?)\/>/.exec(appCode)?.[1];
    expect(props).toMatch(/^\s+selectedDate=\{vix\.selectedDate\}$/m);
    expect(props).toMatch(/^\s+etToday=\{vix\.etToday\}$/m);
  });

  it('hands both cards that key on the slot the one entryTimeLabel', () => {
    // The prop is optional on IVInputSection, so leaving it out compiles and
    // quietly falls back to the candle key.
    for (const card of ['IVInputSection', 'MarketRegimeSection']) {
      const props = new RegExp(String.raw`<${card}([\s\S]*?)\/>`).exec(
        appCode,
      )?.[1];
      expect(props, card).toMatch(/^\s+entryTimeLabel=\{entryTimeLabel\}$/m);
    }
  });

  it("defines entryTimeLabel as the time picker's own text, only for a history snapshot", () => {
    expect(appCode).toMatch(
      /const entryTimeLabel = historySnapshot\s*\? `\$\{timeHour\}:\$\{timeMinute\} \$\{timeAmPm\} \$\{timezone\}`\s*: undefined;/,
    );
  });

  it('resolves the option chain once, none for a snapshot or a past date, and hands it to both readers', () => {
    // The hook's raw value is not always the shown view's: it keeps its last
    // chain in state when its fetch turns off (today to a past date), and
    // today scrubbed back to a candle-covered slot has a history snapshot while
    // the hook is still fetching.
    expect(appCode).toMatch(
      /const liveChain =\s*historySnapshot \|\| analysisIsBacktest\s*\? null\s*: chainData\.chain;/,
    );
    expect(appCode.match(/\bchainData\.chain\b/g)).toHaveLength(1);
    const context = /useAnalysisContext\(\{([\s\S]*?)\n {2}\}\);/.exec(
      appCode,
    )?.[1];
    expect(context).toMatch(/^\s+chain: liveChain,$/m);
    const card = /<MarketRegimeSection([\s\S]*?)\/>/.exec(appCode)?.[1];
    expect(card).toMatch(/^\s+chain=\{liveChain\}$/m);
    // The panel map is memoized: its deps must carry the resolved value.
    expect(appCode).toMatch(/^\s+liveChain,$/m);
  });

  it('builds the signals’ live opening range from the current one, against the date clock, and none for a past date', () => {
    // The held /api/intraday body can be a previous session's. A raw
    // `market.data.intraday?.openingRange` would compile and read it as today's.
    // And on a past date today's range, though current, is not that date's:
    // the history snapshot supplies the range, and null at the open means "no
    // range yet", not "ask the live feed".
    const inputs = /useComputedSignals\(\{([\s\S]*?)\n {2}\}\);/.exec(
      appCode,
    )?.[1];
    expect(inputs).toMatch(
      /^\s+liveOpeningRange:\s*analysisIsBacktest\s*\?\s*undefined\s*:\s*\(?currentOpeningRange\(\s*market\.data\.intraday,\s*vix\.etToday,?\s*\) \?\? undefined\)?,$/m,
    );
    expect(appCode).toMatch(
      /^import \{ currentOpeningRange \} from '\.\/utils\/current-opening-range';$/m,
    );
    expect(appCode).not.toMatch(/market\.data\.intraday\?\.openingRange/);
  });

  it('judges the live yesterday against the date clock, and nowhere else reads the raw one', () => {
    // A held or day-old /api/yesterday body names another day. The one call
    // carries the date clock, and the raw field is read only inside it, so a
    // wall-clock call or a bypass would change the count.
    const bodies = callBodies('currentYesterday');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatch(/\bvix\.etToday\b/);
    expect(appCode.match(/\bmarket\.data\.yesterday\b/g)).toHaveLength(1);
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
