// @vitest-environment node
import path from 'node:path';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Guard for two import rules in eslint.config.ts: "browser code must not
 * import api/" (first block of cases) and "api/ must not import scripts/"
 * (second block, further down).
 *
 * Browser code and api/: Vite dev serves a browser import as a module at the
 * file's own path, so an import from api/ is requested under /api/, where the
 * dev proxy and the e2e specs' page.route('**\/api/**') stubs catch it and
 * the app never mounts. CI also skips E2E for api/-only changes because these
 * rules forbid that import. import-x/no-restricted-paths fails open: an
 * import its resolver can't resolve is silently allowed. A resolver or glob
 * change could switch the guard off without a single lint error, so these
 * tests lint representative imports with the real config and fail instead.
 *
 * api/ and scripts/: Vercel strips scripts/ from the build that compiles all
 * of api/, so an api/ import of it passes locally and fails the deploy. The
 * second block lints every import form (declaration, re-export, dynamic and
 * template-literal import(), import type, triple-slash reference) and the
 * resolved config, so a flat-config merge can't switch a part of it off.
 *
 * Each case lints source text at a virtual path (nothing is written to disk)
 * and asserts the exact set of guard-related rule IDs it reports.
 * Spec: docs/superpowers/specs/e2e-ci-repair-2026-10-26.md.
 */

// vitest runs from the repo root (same convention as coverage-floor.test.mjs).
const ROOT = process.cwd();

const GUARD_RULES = new Set([
  '@typescript-eslint/triple-slash-reference',
  'import-x/extensions',
  'import-x/no-restricted-paths',
  'no-restricted-imports',
  'no-restricted-syntax',
]);

/** Guard-related rule IDs reported for `code` linted as `file`, sorted. */
async function guardRuleIds(eslint, file, code) {
  const [result] = await eslint.lintText(code, {
    filePath: path.join(ROOT, file),
  });
  return result.messages
    .map((m) => m.ruleId ?? `FATAL: ${m.message}`)
    .filter((id) => GUARD_RULES.has(id) || id.startsWith('FATAL'))
    .sort();
}

const VALUE_USE = '\nexport const x = MIN_BUCKET_TRADES;\n';
const TYPE_USE = '\nexport type X = FlowRegimeBaseline;\n';

// [label, virtual file, code, expected rule IDs (sorted)]
const CASES = [
  [
    'src/types: extension-less import type from api/',
    'src/types/x.ts',
    `import type { FlowRegimeBaseline } from '../../api/_lib/flow-regime';${TYPE_USE}`,
    ['no-restricted-imports'],
  ],
  [
    'src/utils: extension-less value import from api/',
    'src/utils/x.ts',
    `import { MIN_BUCKET_TRADES } from '../../api/_lib/flow-regime';${VALUE_USE}`,
    ['import-x/extensions', 'no-restricted-imports'],
  ],
  [
    'src/utils: .js value import from api/',
    'src/utils/x.ts',
    `import { MIN_BUCKET_TRADES } from '../../api/_lib/flow-regime.js';${VALUE_USE}`,
    ['import-x/no-restricted-paths', 'no-restricted-imports'],
  ],
  [
    'src/utils nested folder: .js value import from api/',
    'src/utils/futures-gamma/x.ts',
    `import { MIN_BUCKET_TRADES } from '../../../api/_lib/flow-regime.js';${VALUE_USE}`,
    ['import-x/no-restricted-paths', 'no-restricted-imports'],
  ],
  [
    'component .tsx: extension-less import type from api/',
    'src/components/X/x.tsx',
    `import type { FlowRegimeBaseline } from '../../../api/_lib/flow-regime';${TYPE_USE}`,
    ['import-x/no-restricted-paths'],
  ],
  [
    'component .tsx: extension-less value import from api/',
    'src/components/X/x.tsx',
    `import { MIN_BUCKET_TRADES } from '../../../api/_lib/flow-regime';${VALUE_USE}`,
    ['import-x/no-restricted-paths'],
  ],
  [
    'component .tsx: .js value import from api/',
    'src/components/X/x.tsx',
    `import { MIN_BUCKET_TRADES } from '../../../api/_lib/flow-regime.js';${VALUE_USE}`,
    ['import-x/no-restricted-paths'],
  ],
  [
    'component .ts (not .tsx): extension-less value import from api/',
    'src/components/X/x.ts',
    `import { MIN_BUCKET_TRADES } from '../../../api/_lib/flow-regime';${VALUE_USE}`,
    ['import-x/no-restricted-paths'],
  ],
  [
    'src/__tests__ helper (not *.test): api/ import is exempt',
    'src/__tests__/helpers/x.ts',
    `import { MIN_BUCKET_TRADES } from '../../../api/_lib/flow-regime';${VALUE_USE}`,
    [],
  ],
  [
    'src/__tests__: api/ import is exempt',
    'src/__tests__/x.test.ts',
    `import { MIN_BUCKET_TRADES } from '../../api/_lib/flow-regime';${VALUE_USE}`,
    [],
  ],
  [
    'co-located *.test.ts: api/ import is exempt',
    'src/utils/x.test.ts',
    `import { MIN_BUCKET_TRADES } from '../../api/_lib/flow-regime.js';${VALUE_USE}`,
    [],
  ],
  [
    'src/utils: ./timezone.js stays clean',
    'src/utils/x.ts',
    "import { getETDateStr } from './timezone.js';\nexport const x = getETDateStr;\n",
    [],
  ],
  [
    'src/utils: extension-less ./timezone still fails the .js rule',
    'src/utils/x.ts',
    "import { getETDateStr } from './timezone';\nexport const x = getETDateStr;\n",
    ['import-x/extensions'],
  ],
];

describe('eslint: browser code must not import api/', () => {
  let eslint;

  // The first lint loads eslint.config.ts and its plugins (2.8 s idle, 79 to
  // 85 s on a loaded machine); pay it here, under this hook's own timeout, not
  // in the first case's 60 s. Later ESLint instances in this file reuse it.
  beforeAll(async () => {
    eslint = new ESLint({ cwd: ROOT });
    const [, file, code] = CASES[0];
    await guardRuleIds(eslint, file, code);
  }, 300_000);

  it.each(CASES)(
    '%s',
    async (_label, file, code, expected) => {
      expect(await guardRuleIds(eslint, file, code)).toEqual(expected);
    },
    60_000,
  );
});

/*
 * The other direction: api/ must not import scripts/. Vercel's build runs
 * `tsc --noEmit -p tsconfig.api.json`, which includes all of api/, tests
 * too, and .vercelignore strips scripts/ (all but write-build-info.mjs) from
 * the upload. An api/ file that imports scripts/ passes locally, where
 * scripts/ exists, and fails the deploy with TS2307. A type-only import fails
 * the same way, so it is flagged too. no-restricted-imports does not see a
 * dynamic import(), a template-literal import() or an import type
 * (`typeof import('x')`), so no-restricted-syntax selectors cover those. A
 * triple-slash `/// <reference path="…" />` (TS6053 when the file is gone) is
 * covered by @typescript-eslint/triple-slash-reference. The recommended preset
 * turns the rule on, and its default `path: 'never'` forbids path references.
 * Which files the Vercel build compiles is checked against the real resolver
 * by vercel-build-file-set.test.mjs; these cases cover the lint message.
 */
const SCRIPTS_USE = '\nexport const x = helper;\n';

// [label, virtual file, code, expected rule IDs (sorted)]
const SCRIPTS_CASES = [
  [
    'api/_lib: value import from scripts/',
    'api/_lib/x.ts',
    `import { helper } from '../../scripts/_lib/ticker-flow-backfill.js';${SCRIPTS_USE}`,
    ['no-restricted-imports'],
  ],
  [
    'api/cron: import type from scripts/',
    'api/cron/x.ts',
    `import type { helper } from '../../scripts/_lib/ticker-flow-backfill.js';${SCRIPTS_USE}`,
    ['no-restricted-imports'],
  ],
  [
    'api/ top level: value import from scripts/',
    'api/x.ts',
    `import { helper } from '../scripts/_lib/ticker-flow-backfill.js';${SCRIPTS_USE}`,
    ['no-restricted-imports'],
  ],
  [
    'api/__tests__ test: extension-less import from scripts/',
    'api/__tests__/x.test.ts',
    `import { helper } from '../../scripts/_lib/fire-flow-test-helpers';${SCRIPTS_USE}`,
    ['no-restricted-imports'],
  ],
  [
    'api/__tests__ helper (not *.test): import from scripts/',
    'api/__tests__/x-helpers.ts',
    `import { helper } from '../../scripts/_lib/fire-flow-test-helpers';${SCRIPTS_USE}`,
    ['no-restricted-imports'],
  ],
  [
    'api/_lib nested folder: value import from scripts/',
    'api/_lib/deep/x.ts',
    `import { helper } from '../../../scripts/_lib/ticker-flow-backfill.js';${SCRIPTS_USE}`,
    ['no-restricted-imports'],
  ],
  [
    'api/: re-export from scripts/',
    'api/_lib/x.ts',
    "export { helper } from '../../scripts/_lib/ticker-flow-backfill.js';\n",
    ['no-restricted-imports'],
  ],
  [
    'api/__tests__: dynamic import() of scripts/',
    'api/__tests__/x.test.ts',
    "const { helper } = await import('../../scripts/_lib/fire-flow-test-helpers');\nexport const x = helper;\n",
    ['no-restricted-syntax'],
  ],
  [
    'api/__tests__: typeof import() type argument pointing at scripts/',
    'api/__tests__/x.test.ts',
    "const mod = await vi.importActual<typeof import('../../scripts/_lib/ticker-flow-backfill.js')>('./pglite-migrations');\nexport const x = mod;\n",
    ['no-restricted-syntax'],
  ],
  [
    'api/_lib: import() type of scripts/ in a type alias',
    'api/_lib/x.ts',
    "export type Helper = import('../../scripts/_lib/ticker-flow-backfill.js').Backfill;\n",
    ['no-restricted-syntax'],
  ],
  [
    'api/_lib: typeof import() of scripts/ reaching a member (the qualifier path)',
    'api/_lib/x.ts',
    "export type Member = typeof import('../../scripts/_lib/x.js').member;\n",
    ['no-restricted-syntax'],
  ],
  [
    // Only the import type's own specifier counts. A scripts/ path used as a
    // type argument is a string literal type, which tsc never resolves, so a
    // descendant selector (`TSImportType Literal`) would be a false positive.
    'api/_lib: scripts/ path as a type argument of an import type stays clean',
    'api/_lib/x.ts',
    "export type A = import('./foo.js').T<'../../scripts/a.js'>;\n",
    [],
  ],
  // Non-normalized specifiers that still reach the top-level scripts/. A regex
  // can't resolve a path, so the rule is: a `..` segment, then optional `.` or
  // empty segments, then a `scripts` segment.
  [
    'api/_lib: ./../ prefix before scripts/',
    'api/_lib/x.ts',
    `import { helper } from './../../scripts/_lib/ticker-flow-backfill.js';${SCRIPTS_USE}`,
    ['no-restricted-imports'],
  ],
  [
    'api/_lib: a detour through a sibling folder before scripts/',
    'api/_lib/x.ts',
    `import { helper } from '../_lib/../../scripts/_lib/ticker-flow-backfill.js';${SCRIPTS_USE}`,
    ['no-restricted-imports'],
  ],
  [
    'api/_lib: a `.` segment between ../ and scripts/',
    'api/_lib/x.ts',
    `import { helper } from '.././scripts/_lib/ticker-flow-backfill.js';${SCRIPTS_USE}`,
    ['no-restricted-imports'],
  ],
  [
    'api/_lib: re-export through a detour to scripts/',
    'api/_lib/x.ts',
    "export { helper } from '../_lib/../../scripts/_lib/ticker-flow-backfill.js';\n",
    ['no-restricted-imports'],
  ],
  [
    'api/__tests__: dynamic import() with a ./../ prefix before scripts/',
    'api/__tests__/x.test.ts',
    "const { helper } = await import('./../../scripts/_lib/fire-flow-test-helpers');\nexport const x = helper;\n",
    ['no-restricted-syntax'],
  ],
  [
    'api/__tests__: dynamic import() with a detour before scripts/',
    'api/__tests__/x.test.ts',
    "const { helper } = await import('../_lib/../../scripts/_lib/fire-flow-test-helpers');\nexport const x = helper;\n",
    ['no-restricted-syntax'],
  ],
  [
    'api/_lib: import type with a ./../ prefix before scripts/',
    'api/_lib/x.ts',
    "export type Helper = import('./../../scripts/_lib/ticker-flow-backfill.js').Backfill;\n",
    ['no-restricted-syntax'],
  ],
  [
    'api/_lib: typeof import() with a detour before scripts/',
    'api/_lib/x.ts',
    "export type Mod = typeof import('../_lib/../../scripts/_lib/ticker-flow-backfill.js');\n",
    ['no-restricted-syntax'],
  ],
  // The tail of the path still counts when it has no trailing slash or has an
  // empty segment. A regex mutation that drops either one used to survive.
  [
    'api/_lib: an empty segment before scripts/',
    'api/_lib/x.ts',
    `import { helper } from '../..//scripts/_lib/ticker-flow-backfill.js';${SCRIPTS_USE}`,
    ['no-restricted-imports'],
  ],
  [
    'api/_lib: the bare scripts folder, no trailing slash',
    'api/_lib/x.ts',
    `import { helper } from '../../scripts';${SCRIPTS_USE}`,
    // The extension rule also fires: a folder import has no `.js`.
    ['import-x/extensions', 'no-restricted-imports'],
  ],
  [
    'api/__tests__: dynamic import() of the bare scripts folder',
    'api/__tests__/x.test.ts',
    "const { helper } = await import('../../scripts');\nexport const x = helper;\n",
    ['no-restricted-syntax'],
  ],
  // A case-insensitive checkout (Windows, macOS) resolves `../Scripts/x` to the
  // real folder, so the local build passes where the Linux build fails. Each
  // form needs its own case-insensitive match: an import declaration goes
  // through no-restricted-imports, the rest through three esquery regexes.
  [
    'api/_lib: import from a Scripts/ folder spelled with a capital',
    'api/_lib/x.ts',
    `import { helper } from '../../Scripts/_lib/ticker-flow-backfill.js';${SCRIPTS_USE}`,
    ['no-restricted-imports'],
  ],
  [
    'api/__tests__: dynamic import() of a Scripts/ folder spelled with a capital',
    'api/__tests__/x.test.ts',
    "const { helper } = await import('../../Scripts/_lib/fire-flow-test-helpers');\nexport const x = helper;\n",
    ['no-restricted-syntax'],
  ],
  [
    'api/__tests__: template-literal import() of a SCRIPTS/ folder in capitals',
    'api/__tests__/x.test.ts',
    'const { helper } = await import(`../../SCRIPTS/_lib/fire-flow-test-helpers`);\nexport const x = helper;\n',
    ['no-restricted-syntax'],
  ],
  [
    'api/_lib: import type of a Scripts/ folder spelled with a capital',
    'api/_lib/x.ts',
    "export type Helper = import('../../Scripts/_lib/ticker-flow-backfill.js').Backfill;\n",
    ['no-restricted-syntax'],
  ],
  // A template-literal specifier is no `Literal`, so it needs its own selector.
  [
    'api/__tests__: template-literal import() of scripts/',
    'api/__tests__/x.test.ts',
    'const { helper } = await import(`../../scripts/_lib/fire-flow-test-helpers`);\nexport const x = helper;\n',
    ['no-restricted-syntax'],
  ],
  [
    'api/__tests__: template-literal import() of scripts/ with a substitution',
    'api/__tests__/x.test.ts',
    'const { helper } = await import(`../../scripts/_lib/${name}`);\nexport const x = helper;\n',
    ['no-restricted-syntax'],
  ],
  [
    'api/__tests__: template-literal import() with a detour before scripts/',
    'api/__tests__/x.test.ts',
    'const { helper } = await import(`../_lib/../../scripts/_lib/fire-flow-test-helpers`);\nexport const x = helper;\n',
    ['no-restricted-syntax'],
  ],
  [
    'api/__tests__: template-literal import() of a sibling stays clean',
    'api/__tests__/x.test.ts',
    'const { helper } = await import(`./pglite-migrations`);\nexport const x = helper;\n',
    [],
  ],
  [
    'api/__tests__: template-literal import() with no static prefix stays clean',
    'api/__tests__/x.test.ts',
    'const { helper } = await import(`./${name}`);\nexport const x = helper;\n',
    [],
  ],
  [
    'api/__tests__: template-literal import() of a "scripts-" name stays clean',
    'api/__tests__/x.test.ts',
    'const { helper } = await import(`../_lib/scripts-registry.js`);\nexport const x = helper;\n',
    [],
  ],
  // A triple-slash reference is neither an import nor an import type.
  [
    'api/_lib: triple-slash reference path to scripts/',
    'api/_lib/x.ts',
    '/// <reference path="../../scripts/_lib/x.ts" />\nexport const x = 1;\n',
    ['@typescript-eslint/triple-slash-reference'],
  ],
  [
    'api/__tests__: triple-slash reference path to scripts/',
    'api/__tests__/x.test.ts',
    '/// <reference path="../../scripts/_lib/x.ts" />\nexport const x = 1;\n',
    ['@typescript-eslint/triple-slash-reference'],
  ],
  [
    // From api/_lib/, `../../scripts-foo/` is a root folder next to api/.
    'api/_lib: a "scripts-foo" folder next to api/ stays clean',
    'api/_lib/x.ts',
    `import { helper } from '../../scripts-foo/a.js';${SCRIPTS_USE}`,
    [],
  ],
  [
    // `../scripts-foo/` from api/_lib/ is api/scripts-foo/.
    'api/_lib: a "scripts-foo" folder inside api/ stays clean',
    'api/_lib/x.ts',
    `import { helper } from '../scripts-foo/a.js';${SCRIPTS_USE}`,
    [],
  ],
  [
    'api/_lib: a ./scripts-registry.js import stays clean',
    'api/_lib/x.ts',
    `import { helper } from './scripts-registry.js';${SCRIPTS_USE}`,
    [],
  ],
  [
    // Not top-level scripts/: no `..` segment leads into it, so it resolves
    // below the importing file's own folder. Pins the one-sided rule.
    'api/_lib: a scripts/ folder below the importing file stays clean',
    'api/_lib/x.ts',
    `import { helper } from './scripts/a.js';${SCRIPTS_USE}`,
    [],
  ],
  [
    'api/__tests__: typeof import() of a sibling stays clean',
    'api/__tests__/x.test.ts',
    "const mod = await vi.importActual<typeof import('./pglite-migrations')>('./pglite-migrations');\nexport const x = mod;\n",
    [],
  ],
  [
    'api/__tests__: a sibling helper import stays clean',
    'api/__tests__/x.test.ts',
    `import { helper } from './fire-flow-test-helpers';${SCRIPTS_USE}`,
    [],
  ],
  [
    'api/_lib: a module whose name only contains "scripts" stays clean',
    'api/_lib/x.ts',
    `import { helper } from '../_lib/scripts-registry.js';${SCRIPTS_USE}`,
    [],
  ],
  [
    'api/__tests__: dynamic import() of a sibling stays clean',
    'api/__tests__/x.test.ts',
    "const { helper } = await import('./pglite-migrations');\nexport const x = helper;\n",
    [],
  ],
  [
    'scripts/ importing api/ (the allowed direction) stays clean',
    'scripts/_lib/x.ts',
    `import { helper } from '../../api/_lib/flow-regime.js';${SCRIPTS_USE}`,
    [],
  ],
];

describe('eslint: api/ must not import scripts/', () => {
  let eslint;

  beforeAll(() => {
    eslint = new ESLint({ cwd: ROOT });
  });

  it.each(SCRIPTS_CASES)(
    '%s',
    async (_label, file, code, expected) => {
      expect(await guardRuleIds(eslint, file, code)).toEqual(expected);
    },
    60_000,
  );
});

/*
 * Flat config replaces a rule's options instead of merging them, so a block
 * added after the api/ guard that sets no-restricted-imports or
 * no-restricted-syntax for api/ files would switch part of it off without a
 * lint error. This reads the resolved config, so the failure names the rule.
 */
describe('eslint: the api/ scripts guard survives config merging', () => {
  let eslint;

  beforeAll(() => {
    eslint = new ESLint({ cwd: ROOT });
  });

  it.each(['api/_lib/x.ts', 'api/__tests__/x.test.ts'])(
    '%s resolves to the guard rules at error severity',
    async (file) => {
      const { rules } = await eslint.calculateConfigForFile(
        path.join(ROOT, file),
      );

      const [importsSeverity, importsOptions] = rules['no-restricted-imports'];
      expect(importsSeverity).toBe(2);
      expect(
        importsOptions.patterns.some(({ regex }) =>
          new RegExp(regex, 'u').test('../../scripts/x.js'),
        ),
      ).toBe(true);

      const [syntaxSeverity, ...selectors] = rules['no-restricted-syntax'];
      expect(syntaxSeverity).toBe(2);
      expect(selectors.map((s) => s.selector)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^ImportExpression > Literal\[/),
          expect.stringMatching(/^ImportExpression > TemplateLiteral\[/),
          expect.stringMatching(/^TSImportType > Literal\[/),
        ]),
      );

      expect(rules['@typescript-eslint/triple-slash-reference'][0]).toBe(2);
    },
    60_000,
  );
});
