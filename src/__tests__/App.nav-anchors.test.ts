import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { getPanelRegistry } from '../constants/panel-registry';

const appSource = readFileSync(path.resolve(__dirname, '../App.tsx'), 'utf-8');

const RESULTS_ID = 'results';

/**
 * Returns every panel id from the registry across both auth states and
 * both market-context states — the union covers what could ever appear
 * in the nav.
 */
function allRegistryIds(): string[] {
  const seen = new Set<string>();
  for (const isAuthenticated of [false, true] as const) {
    for (const hasMarketOrSnapshot of [false, true] as const) {
      for (const entry of getPanelRegistry({
        isAuthenticated,
        hasMarketOrSnapshot,
      })) {
        seen.add(entry.id);
      }
    }
  }
  return [...seen];
}

/**
 * Pulls every renderer key out of the `panelMap` useMemo body in
 * App.tsx (Phase 2O refactor: the old `panelRenderers` Record literal
 * was lifted into a `useMemo<Map<string, () => ReactNode>>(...)` whose
 * body is `new Map<...>([ ['id', () => ...], ... ])`). The map is the
 * source of truth for what App actually renders.
 * Spec: panel-reordering-2026-05-17.md; extraction: Phase 2O.
 */
function extractRendererKeys(source: string): Set<string> {
  const mapRe =
    /new Map<string,\s*\(\)\s*=>\s*ReactNode>\(\[([\s\S]*?)\]\),\s*$\s*\[/m;
  const mapMatch = mapRe.exec(source);
  if (!mapMatch) {
    throw new Error('Could not locate panelMap initializer in App.tsx');
  }
  const body = mapMatch[1]!;
  const keys = new Set<string>();
  for (const m of body.matchAll(/^\s+'([^']+)',\s*$/gm)) {
    keys.add(m[1]!);
  }
  return keys;
}

/**
 * Pulls every DOM-anchored id="..." attribute literal out of App.tsx.
 */
function extractJsxIds(source: string): Set<string> {
  return new Set(
    [...source.matchAll(/id="([a-z][a-z0-9-]*)"/g)].map((m) => m[1]!),
  );
}

describe('App panel alignment', () => {
  it('every registry panel id has a renderer entry in App.tsx', () => {
    const registryIds = allRegistryIds();
    expect(registryIds.length).toBeGreaterThan(15);

    const rendererKeys = extractRendererKeys(appSource);
    const missing = registryIds.filter((id) => !rendererKeys.has(id));
    expect(missing).toEqual([]);
  });

  it('every renderer key has either a DOM id anchor or is the results pin', () => {
    const rendererKeys = extractRendererKeys(appSource);
    const jsxIds = extractJsxIds(appSource);
    const missing = [...rendererKeys].filter(
      (id) => id !== RESULTS_ID && !jsxIds.has(id),
    );
    expect(missing).toEqual([]);
  });

  it('does not reference the dead sec-futures-calc anchor', () => {
    expect(appSource).not.toContain("'sec-futures-calc'");
    expect(appSource).not.toContain('id="sec-futures-calc"');
  });

  it('skip-to-results link still targets the results anchor', () => {
    expect(appSource).toContain('href="#results"');
  });
});
