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
 * Pulls every renderer key out of the `panelRenderers` Record literal
 * in App.tsx. The map is the source of truth for what App actually
 * renders post-Phase-3-refactor (spec: panel-reordering-2026-05-17.md).
 * Quoted keys (`'sec-x':`) and bare keys (`results:`) both supported.
 */
function extractRendererKeys(source: string): Set<string> {
  const mapMatch = source.match(
    /panelRenderers:\s*Record<string,\s*\(\)\s*=>\s*ReactNode>\s*=\s*\{([\s\S]*?)^\s{18}\};/m,
  );
  if (!mapMatch) {
    throw new Error('Could not locate panelRenderers map in App.tsx');
  }
  const body = mapMatch[1]!;
  const keys = new Set<string>();
  for (const m of body.matchAll(/^\s+'([^']+)':\s*\(\)\s*=>/gm)) {
    keys.add(m[1]!);
  }
  for (const m of body.matchAll(/^\s+(results):\s*\(\)\s*=>/gm)) {
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
