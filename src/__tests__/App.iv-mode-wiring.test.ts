import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Guards App.tsx's half of the ivModeEdited flag (bug F4e). On a past date
 * without Schwab VIX1D, useAutoFill picks VIX mode provisionally and picks
 * once more when the static VIX1D table loads, unless the user picked a
 * mode in the meantime. The flag only protects that pick if every user
 * path into setIvMode sets it. Mounting <App /> in jsdom is too heavy (see
 * App.panel-render.test.tsx), so this reads the source the way
 * App.nav-anchors.test.ts does. useAutoFill.test.ts covers the hook's half.
 */
const appSource = readFileSync(path.resolve(__dirname, '../App.tsx'), 'utf-8');

/**
 * App.tsx without comments, so a comment that names setIvMode doesn't count.
 * The `[^:]` keeps a URL's `//` (App.tsx has none in strings today).
 */
const appCode = appSource
  .replaceAll(/\/\*[\s\S]*?\*\//g, '')
  .replaceAll(/(^|[^:])\/\/.*$/gm, '$1');

/** The body of `const <name> = useCallback(...)`, up to its closing `);`. */
function callbackBody(name: string): string {
  const match = new RegExp(
    String.raw`const ${name} = useCallback\(([\s\S]*?)\n  \);`,
  ).exec(appSource);
  if (!match) throw new Error(`Could not locate ${name} in App.tsx`);
  return match[1]!;
}

function ivInputSectionProps(): string {
  const match = /<IVInputSection([\s\S]*?)\/>/.exec(appSource);
  if (!match) throw new Error('Could not locate <IVInputSection> in App.tsx');
  return match[1]!;
}

describe('App IV-mode wiring', () => {
  it('the IV-mode toggle marks the mode as user-picked', () => {
    expect(ivInputSectionProps()).toContain(
      'onIvModeChange={handleIvModeChange}',
    );
    expect(callbackBody('handleIvModeChange')).toContain(
      'ivModeEdited.current = true',
    );
  });

  it('"Use VIX1D as σ" marks the mode as user-picked', () => {
    expect(ivInputSectionProps()).toContain(
      'onUseVix1dAsSigma={handleUseVix1dAsSigma}',
    );
    expect(callbackBody('handleUseVix1dAsSigma')).toContain(
      'ivModeEdited.current = true',
    );
  });

  it('calls setIvMode only from the two flag-setting handlers', () => {
    expect(appCode.match(/\bsetIvMode\(/g)).toHaveLength(2);
    expect(callbackBody('handleIvModeChange')).toContain('setIvMode(');
    expect(callbackBody('handleUseVix1dAsSigma')).toContain('setIvMode(');
  });

  it('references setIvMode nowhere but the reviewed wiring', () => {
    // Fails closed: any new reference changes the count, whether a call, an
    // inline arrow, a prop (`={setIvMode}`, `={setIvMode as …}`) or an object
    // shorthand (`{ setIvMode }`). The six: the useIvInputs destructure, the
    // call and deps of handleIvModeChange and of handleUseVix1dAsSigma, and
    // the useAutoFill input (auto-fill, not a user pick).
    expect(appCode.match(/\bsetIvMode\b/g)).toHaveLength(6);
  });

  it('hands no UI control the raw setIvMode, which skips the flag', () => {
    expect(appSource).not.toMatch(/=\{setIvMode\}/);
    expect(appSource).not.toMatch(/:\s*setIvMode\b/);
  });

  it('passes the selected date to IVInputSection', () => {
    // The term-structure card keys its live-quote fallback on the date.
    expect(ivInputSectionProps()).toContain('selectedDate={vix.selectedDate}');
  });

  it('hands useAutoFill the flag', () => {
    const inputs = /useAutoFill\(\{([\s\S]*?)\}\);/.exec(appSource)?.[1];
    expect(inputs).toMatch(/^\s+ivModeEdited,$/m);
  });
});
