// @vitest-environment node
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ESLint } from 'eslint';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Drift guard for the `.js` extension rule's scope in eslint.config.ts.
 *
 * Vercel runs api/ under Node's strict ESM resolver, so every src/ file
 * that api/ imports (directly or transitively) needs `.js` on its relative
 * imports, or the production Function dies with ERR_MODULE_NOT_FOUND while
 * local dev and tests pass. `import-x/extensions` only checks the files in
 * API_COMPILED_SRC. A src/ file outside it that api/ starts importing would
 * go unchecked, as src/components/LotteryFinder/ct-window.ts did until
 * 2026-10-29. This walks the real api/ import graph into src/ (static
 * imports, re-exports and dynamic import()) and fails on any reached file
 * the rule doesn't cover. The walker has its own fixture tests below, so a
 * regression in it can't pass for "api/ imports nothing new".
 */

// vitest runs from the repo root (same convention as eslint-api-guard.test.mjs).
const ROOT = process.cwd();

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
 * Relative specifiers of the file's value imports, re-exports and dynamic
 * `import('…')` calls with a string-literal argument, wherever they sit in
 * the file (an import() usually sits inside a function). `import type`,
 * `export type … from` and type-position `import('…')` types are skipped:
 * they're erased at compile time, so they never reach Node's resolver. A
 * computed specifier can't be resolved statically and is skipped too.
 */
function relativeValueImports(file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
  );
  const specs = [];
  const visit = (node) => {
    let spec;
    if (ts.isImportDeclaration(node)) {
      if (node.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword)
        spec = node.moduleSpecifier;
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly) spec = node.moduleSpecifier;
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      spec = node.arguments[0];
    }
    if (
      spec != null &&
      ts.isStringLiteralLike(spec) &&
      spec.text.startsWith('.')
    ) {
      specs.push(spec.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specs;
}

/**
 * The .ts/.tsx file a relative specifier resolves to, or undefined. A `.js`
 * or `.ts` suffix is dropped first (tsconfig.api.json sets
 * allowImportingTsExtensions), then x.ts, x.tsx and x/index.ts are tried.
 */
function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const stem = base.replace(/\.(js|ts)$/, '');
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

/** src/ files reached from `root`/api through value imports, root-relative. */
function srcFilesImportedByApi(root) {
  const srcDir = path.join(root, 'src') + path.sep;
  const queue = sourceFiles(path.join(root, 'api'));
  const reached = new Set();
  while (queue.length > 0) {
    const file = queue.shift();
    for (const spec of relativeValueImports(file)) {
      const target = resolveRelative(file, spec);
      if (target == null || !target.startsWith(srcDir) || reached.has(target)) {
        continue;
      }
      reached.add(target);
      queue.push(target);
    }
  }
  return [...reached]
    .map((f) => path.relative(root, f).split(path.sep).join('/'))
    .sort();
}

describe('eslint-api-src-scope walker (fixtures)', () => {
  let fixtureDir;

  beforeAll(() => {
    fixtureDir = mkdtempSync(path.join(tmpdir(), 'eslint-api-src-scope-'));
  });

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  /** Writes `files` (relative path → source) under `fixtureDir/name`. */
  function makeTree(name, files) {
    const root = path.join(fixtureDir, name);
    for (const [rel, text] of Object.entries(files)) {
      const abs = path.join(root, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, text);
    }
    return root;
  }

  describe('relativeValueImports', () => {
    function specsOf(code) {
      const root = makeTree('specs', { 'fixture.ts': code });
      return relativeValueImports(path.join(root, 'fixture.ts'));
    }

    it.each([
      ['a named import', "import { a } from './a.js';"],
      ['a default import', "import a from './a.js';"],
      ['a namespace import', "import * as a from './a.js';"],
      ['a side-effect import', "import './a.js';"],
      ['an inline type specifier alone', "import { type A } from './a.js';"],
      [
        'an inline type specifier beside a value',
        "import { type A, b } from './a.js';",
      ],
      ['a named re-export', "export { a } from './a.js';"],
      ['a star re-export', "export * from './a.js';"],
      ['a namespace re-export', "export * as a from './a.js';"],
      ['a top-level dynamic import', "const m = await import('./a.js');"],
      [
        'a dynamic import inside a function',
        "async function f() { return (await import('./a.js')).x; }",
      ],
      ['a dynamic import in a callback', "load(() => import('./a.js'));"],
      ['a dynamic import with a then chain', "import('./a.js').then(() => 1);"],
    ])('keeps %s', (_name, code) => {
      expect(specsOf(code)).toEqual(['./a.js']);
    });

    it.each([
      ['an import type', "import type { A } from './a.js';"],
      ['a default import type', "import type A from './a.js';"],
      ['a namespace import type', "import type * as A from './a.js';"],
      ['an export type … from', "export type { A } from './a.js';"],
      ['an export type * from', "export type * from './a.js';"],
      ['an export type * as … from', "export type * as A from './a.js';"],
      ['a typeof import() type', "type T = typeof import('./a.js');"],
      ['an import() type', "type T = import('./a.js').A;"],
      ['a local export with no specifier', 'const a = 1;\nexport { a };'],
      [
        'a package import',
        "import { z } from 'zod';\nimport fs from 'node:fs';",
      ],
      ['a package dynamic import', "await import('zod');"],
      ['a computed dynamic import', 'await import(name);'],
      [
        'a template dynamic import with a substitution',
        'await import(`./${name}.js`);',
      ],
      [
        'a specifier inside a comment or a string',
        "// import('./a.js')\nconst s = \"import('./a.js')\";",
      ],
    ])('skips %s', (_name, code) => {
      expect(specsOf(code)).toEqual([]);
    });

    it('returns specifiers verbatim, in source order', () => {
      expect(
        specsOf(
          "import { a } from './a';\nexport * from '../b.js';\nimport('./c.ts');",
        ),
      ).toEqual(['./a', '../b.js', './c.ts']);
    });
  });

  describe('resolveRelative', () => {
    let root;
    let caller;

    beforeAll(() => {
      root = makeTree('resolve', {
        'caller.ts': '',
        'foo.ts': '',
        'comp.tsx': '',
        'dir/index.ts': '',
        'bar/baz.ts': '',
      });
      caller = path.join(root, 'caller.ts');
    });

    const rel = (resolved) =>
      resolved == null
        ? undefined
        : path.relative(root, resolved).split(path.sep).join('/');

    it.each([
      ['./foo.js', 'foo.ts'],
      ['./foo', 'foo.ts'],
      ['./foo.ts', 'foo.ts'],
      ['./comp.js', 'comp.tsx'],
      ['./comp', 'comp.tsx'],
      ['./dir', 'dir/index.ts'],
      ['./dir/index.js', 'dir/index.ts'],
      ['./bar/baz.js', 'bar/baz.ts'],
      ['./missing.js', undefined],
      ['./dir.js', undefined],
    ])('resolves %s to %s', (spec, expected) => {
      expect(rel(resolveRelative(caller, spec))).toBe(expected);
    });
  });

  describe('srcFilesImportedByApi', () => {
    let reached;

    beforeAll(() => {
      const root = makeTree('graph', {
        'api/handler.ts': [
          "import { a } from '../src/utils/a.js';",
          "import type { OnlyType } from '../src/types/only-type.js';",
          "import { helper } from './_lib/helper.js';",
          "export async function load() { return import('../src/data/lazy.js'); }",
        ].join('\n'),
        'api/_lib/helper.ts': 'export const helper = 1;',
        // A __tests__ helper (not named *.test.ts) and a *.test.ts file each
        // import test-only.ts; neither may count as production api/ code.
        'api/__tests__/helpers.ts':
          "import { t } from '../../src/utils/test-only.js';",
        'api/skipped.test.ts': "import { t } from '../src/utils/test-only.js';",
        'src/utils/a.ts': [
          "import { b } from './b.js';",
          "export * from '../components/widget/index.js';",
        ].join('\n'),
        'src/utils/b.ts':
          "import { a } from './a.js';\nexport const b = a ?? 1;",
        'src/components/widget/index.ts': 'export const widget = 1;',
        'src/data/lazy.ts': "import { dep } from './lazy-dep';",
        'src/data/lazy-dep.ts': 'export const dep = 1;',
        'src/types/only-type.ts': 'export type OnlyType = string;',
        'src/utils/test-only.ts': 'export const t = 1;',
        'src/unrelated.ts': 'export const u = 1;',
      });
      reached = srcFilesImportedByApi(root);
    });

    it('follows static imports transitively, through a cycle and an index file', () => {
      expect(reached).toEqual(
        expect.arrayContaining([
          'src/utils/a.ts',
          'src/utils/b.ts',
          'src/components/widget/index.ts',
        ]),
      );
    });

    it('follows a dynamic import() and the imports behind it', () => {
      expect(reached).toEqual(
        expect.arrayContaining(['src/data/lazy.ts', 'src/data/lazy-dep.ts']),
      );
    });

    it('ignores type-only imports, test files and unreached src/ files', () => {
      expect(reached).not.toContain('src/types/only-type.ts');
      expect(reached).not.toContain('src/utils/test-only.ts');
      expect(reached).not.toContain('src/unrelated.ts');
    });

    it('returns exactly the reached files, sorted and root-relative', () => {
      expect(reached).toEqual([
        'src/components/widget/index.ts',
        'src/data/lazy-dep.ts',
        'src/data/lazy.ts',
        'src/utils/a.ts',
        'src/utils/b.ts',
      ]);
    });
  });
});

describe('eslint: the .js extension rule covers every src/ file api/ imports', () => {
  let eslint;
  const files = srcFilesImportedByApi(ROOT);

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
