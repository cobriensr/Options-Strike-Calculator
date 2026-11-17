// @vitest-environment node
import path from 'node:path';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Guard for the "browser code must not import api/" rules in eslint.config.ts.
 *
 * Vite dev serves a browser import as a module at the file's own path, so an
 * import from api/ is requested under /api/, where the dev proxy and the e2e
 * specs' page.route('**\/api/**') stubs catch it and the app never mounts.
 * CI also skips E2E for api/-only changes because these rules forbid that
 * import. import-x/no-restricted-paths fails open: an import its resolver
 * can't resolve is silently allowed. A resolver or glob change could switch
 * the guard off without a single lint error, so these tests lint
 * representative imports with the real config and fail instead.
 *
 * Each case lints source text at a virtual path (nothing is written to disk)
 * and asserts the exact set of guard-related rule IDs it reports.
 * Spec: docs/superpowers/specs/e2e-ci-repair-2026-10-26.md.
 */

// vitest runs from the repo root (same convention as coverage-floor.test.mjs).
const ROOT = process.cwd();

const GUARD_RULES = new Set([
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

  beforeAll(() => {
    eslint = new ESLint({ cwd: ROOT });
  });

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
 * dynamic import(), so a no-restricted-syntax selector covers that.
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
