// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ESLint } from 'eslint';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Drift guard for the `.js` extension rule's scope in eslint.config.ts.
 *
 * Vercel runs api/ under Node's strict ESM resolver, so every src/ file
 * that api/ imports (directly or transitively) needs `.js` on its relative
 * imports, or the production Function dies with ERR_MODULE_NOT_FOUND while
 * local dev and tests pass. `import-x/extensions` only checks the files in
 * API_COMPILED_SRC. A src/ file outside it that api/ starts importing would
 * go unchecked, as src/components/LotteryFinder/ct-window.ts did until
 * 2026-10-29. This walks the real api/ import graph into src/ and fails on
 * any reached file the rule doesn't cover.
 */

// vitest runs from the repo root (same convention as eslint-api-guard.test.mjs).
const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src') + path.sep;

/** Non-test .ts files under `dir`, skipping __tests__ folders. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') out.push(...sourceFiles(p));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Relative specifiers of the file's value imports and re-exports.
 * `import type` and `export type … from` are skipped: they're erased at
 * compile time, so they never reach Node's resolver.
 */
function relativeValueImports(file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
  );
  const specs = [];
  for (const stmt of source.statements) {
    let typeOnly;
    if (ts.isImportDeclaration(stmt)) {
      typeOnly = stmt.importClause?.isTypeOnly === true;
    } else if (ts.isExportDeclaration(stmt)) {
      typeOnly = stmt.isTypeOnly;
    } else {
      continue;
    }
    const spec = stmt.moduleSpecifier;
    if (typeOnly || spec == null || !ts.isStringLiteral(spec)) continue;
    if (spec.text.startsWith('.')) specs.push(spec.text);
  }
  return specs;
}

/** The .ts/.tsx file a relative specifier resolves to, or undefined. */
function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const stem = base.endsWith('.js') ? base.slice(0, -3) : base;
  return [`${stem}.ts`, `${stem}.tsx`, path.join(base, 'index.ts')].find(
    (candidate) => {
      try {
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    },
  );
}

/** src/ files reached from api/ through value imports, repo-relative. */
function srcFilesImportedByApi() {
  const queue = sourceFiles(path.join(ROOT, 'api'));
  const reached = new Set();
  while (queue.length > 0) {
    const file = queue.shift();
    for (const spec of relativeValueImports(file)) {
      const target = resolveRelative(file, spec);
      if (target == null || !target.startsWith(SRC) || reached.has(target)) {
        continue;
      }
      reached.add(target);
      queue.push(target);
    }
  }
  return [...reached]
    .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
    .sort();
}

describe('eslint: the .js extension rule covers every src/ file api/ imports', () => {
  let eslint;
  const files = srcFilesImportedByApi();

  beforeAll(() => {
    eslint = new ESLint({ cwd: ROOT });
  });

  it('finds the known api/-imported src/ files (the walk is not empty)', () => {
    expect(files).toContain('src/utils/timezone.ts');
    expect(files).toContain('src/data/marketHours.ts');
    expect(files).toContain('src/components/LotteryFinder/ct-window.ts');
  });

  it.each(files)(
    '%s is checked by import-x/extensions',
    async (file) => {
      const config = await eslint.calculateConfigForFile(path.join(ROOT, file));
      const rule = config?.rules?.['import-x/extensions'];
      const severity = Array.isArray(rule) ? rule[0] : rule;
      expect(
        severity === 2 || severity === 'error',
        `${file} is imported by api/ but sits outside API_COMPILED_SRC in eslint.config.ts`,
      ).toBe(true);
    },
    60_000,
  );
});
