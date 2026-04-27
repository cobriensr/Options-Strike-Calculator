import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const appSource = readFileSync(path.resolve(__dirname, '../App.tsx'), 'utf-8');

const RESULTS_ID = 'results';

function extractNavSectionIds(source: string): string[] {
  const navMatch = source.match(
    /navSections\s*=\s*useMemo<NavSection\[\]>\(\(\)\s*=>\s*\{([\s\S]*?)\},\s*\[/,
  );
  if (!navMatch) {
    throw new Error('Could not locate navSections useMemo in App.tsx');
  }
  return [...navMatch[1]!.matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]!);
}

function extractJsxIds(source: string): Set<string> {
  return new Set(
    [...source.matchAll(/id="([a-z][a-z0-9-]*)"/g)].map((m) => m[1]!),
  );
}

describe('App nav anchor alignment', () => {
  it('every navSections id has a matching DOM id in App.tsx', () => {
    const navIds = extractNavSectionIds(appSource);
    expect(navIds.length).toBeGreaterThan(15);

    const jsxIds = extractJsxIds(appSource);
    const missing = navIds.filter((id) => !jsxIds.has(id) && id !== RESULTS_ID);
    expect(missing).toEqual([]);
  });

  it('does not reference the dead sec-futures-calc anchor', () => {
    expect(appSource).not.toContain("'sec-futures-calc'");
    expect(appSource).not.toContain('id="sec-futures-calc"');
  });

  it('renders both halves of the split market-flow section', () => {
    expect(appSource).toContain('id="sec-market-internals"');
    expect(appSource).toContain('id="sec-market-flow"');
  });

  it('skip-to-results link still targets the results anchor', () => {
    expect(appSource).toContain('href="#results"');
  });
});
