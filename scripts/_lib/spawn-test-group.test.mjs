// @vitest-environment node
import { readFileSync, statSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { configDefaults } from 'vitest/config';
import config, { SPAWN_TEST_FILES, TEST_INCLUDE } from '../../vite.config.ts';

/**
 * Guard for the `spawn` and `main` vitest projects in vite.config.ts.
 *
 * The `spawn` project runs the test files that start child processes first
 * and a few at a time; the `main` project runs everything else at full width
 * afterwards (docs/superpowers/specs/gate-spawn-test-group-2026-11-19.md).
 * That only helps while every spawning file is in the list: one that is left
 * out runs at full width again, and nothing fails until a load spike makes it
 * time out. So these tests fail when a test file that starts a child process
 * is missing from SPAWN_TEST_FILES, when an entry has no file, and when the
 * two projects stop splitting the test files exactly. The same idea as
 * coverage-thresholds.test.mjs, which fails when a coverage glob matches no
 * files.
 *
 * A file starts a child process when it, or a module it reaches, holds a
 * quoted `child_process` or `node:child_process` string in code: an import, a
 * `require`, `createRequire(...)('child_process')`, `getBuiltinModule` or
 * `vi.importActual`. It reaches a module through any quoted `./` or `../`
 * string that names a code file, whether in an import, a `new URL` or a path
 * join, and through other test files. The one exemption: a file that replaces
 * the module outright with a `vi.mock` factory that takes no parameter, such
 * as session-status.test.mjs and watch-deploy.test.mjs. The mock covers every
 * import of the module in the files the test imports, so those run no child
 * and the file stays in `main`. Two things still count. A use the mock does
 * not cover, in the file or in a file it reaches: a `require`, `createRequire`,
 * `getBuiltinModule`, `vi.importActual`, or a `vi.doUnmock` that takes the mock
 * away. And a file the test loads at run time with `import()`, `require()` or
 * `vi.importActual()`, or one it reaches, if it names the module at all: the
 * factory may be the one loading it, and vitest gives a file the factory loads
 * the real module. The guard cannot tell a load in the factory from one in a
 * test body, so a mocked file that loads its module under test that way would
 * be listed though it runs no child. A factory that takes `importOriginal`
 * wraps the real module, so its file counts.
 *
 * The limits of a guard that reads literals: a probe source built inside a
 * template string, two `vi.mock` calls for the same module, and a `/*` inside a
 * template literal can each hide a spawn from it. The file then just runs at
 * full width, in `main`.
 *
 * Tinyglobby loads through vitest's own dependency tree, the copy vitest
 * globs with.
 */

// vitest runs from the repo root (same convention as coverage-thresholds.test.mjs).
const ROOT = process.cwd();

const { globSync } = createRequire(
  createRequire(import.meta.url).resolve('vitest/package.json'),
)('tinyglobby');

// The module's name is spliced into the samples below, so that this file holds
// no quoted literal of it (the scan below reads this file too).
const CP = ['child', 'process'].join('_');
const NODE_CP = `node:${CP}`;

/** A quoted `child_process` or `node:child_process`, in any kind of quote. */
const CHILD_PROCESS_LITERAL = /(['"`])(?:node:)?child_process\1/;

/**
 * The uses a `vi.mock` of the module covers: a static or dynamic import, and
 * the `vi.mock` call's own argument.
 */
const MOCKED_USES =
  /(?:\b(?:from|import)[\s(]*|\bvi\.mock\(\s*)(['"`])(?:node:)?child_process\1/g;

/** `vi.mock('<child_process>', () => ...)`, async or a function, no parameter. */
const PARAMETERLESS_FACTORY =
  /\bvi\.mock\(\s*(['"`])(?:node:)?child_process\1\s*,\s*(?:async\s*)?(?:\(\s*\)\s*=>|function\s*\(\s*\)\s*\{)/;

/** A quoted relative path, as in vercel-build-file-set.mjs. */
const RELATIVE_LITERAL = /(['"`])(\.{1,2}\/[^'"`\r\n]*)\1/g;

/**
 * A relative path loaded at run time: `import('./x')`, `require('./x')` or
 * `vi.importActual('./x')`. A mock factory that does this gets the real module
 * for the file and for everything the file reaches.
 */
const LOADED_LITERAL =
  /\b(?:import|require|importActual)\s*\(\s*(['"`])(\.{1,2}\/[^'"`\r\n]*)\1/g;

const CODE_FILE = /\.[cm]?[jt]sx?$/;
const EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
];
/** TypeScript writes the compiled extension in an import of a source file. */
const SOURCE_OF = {
  '.js': ['.ts', '.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
  '.jsx': ['.tsx'],
};

/**
 * A source with its comments blanked: line comments, and block comments even
 * when code follows on the line where one ends. A `/*` inside a string, such
 * as a glob, only counts at the start of a line.
 */
function codeOf(source) {
  let inBlock = false;
  return source
    .split('\n')
    .map((line) => {
      let rest = line;
      while (inBlock || rest.trimStart().startsWith('/*')) {
        if (!inBlock) {
          inBlock = true;
          rest = rest.trimStart().slice(2);
        }
        const end = rest.indexOf('*/');
        if (end === -1) return '';
        rest = rest.slice(end + 2);
        inBlock = false;
      }
      return rest.trimStart().startsWith('//') ? '' : rest;
    })
    .join('\n');
}

/**
 * Whether the code names the module in a way a `vi.mock` does not cover: what
 * is left once the covered uses are gone. A require, a createRequire call,
 * getBuiltinModule and vi.importActual leave a literal behind, and so does a
 * vi.doUnmock or a vi.unmock, which takes the mock away again.
 */
function bypassesMock(code) {
  return CHILD_PROCESS_LITERAL.test(code.replace(MOCKED_USES, ''));
}

/** The files a relative path may name, most likely first. */
function candidatesOf(base) {
  const extension = path.extname(base);
  const stem = base.slice(0, base.length - extension.length);
  return [
    base,
    ...(SOURCE_OF[extension] ?? []).map((source) => `${stem}${source}`),
    ...EXTENSIONS.map((suffix) => `${base}${suffix}`),
    ...EXTENSIONS.map((suffix) => path.join(base, `index${suffix}`)),
  ];
}

/**
 * Whether running a test file starts a child process. `read` gives a file's
 * source, or undefined when there is no such file.
 */
function createDetector(read) {
  const sources = new Map();
  const sourceOf = (file) => {
    if (!sources.has(file)) sources.set(file, read(file));
    return sources.get(file);
  };

  function resolveLiteral(from, literal) {
    const base = path.resolve(path.dirname(from), literal);
    return candidatesOf(base).find(
      (file) => CODE_FILE.test(file) && sourceOf(file) !== undefined,
    );
  }

  /** What one file says about child_process; each file is read once. */
  const infos = new Map();
  function infoOf(file) {
    let info = infos.get(file);
    if (info === undefined) {
      const source = sourceOf(file);
      const code = source === undefined ? '' : codeOf(source);
      info = {
        names: CHILD_PROCESS_LITERAL.test(code),
        bypasses: bypassesMock(code),
        replaces: PARAMETERLESS_FACTORY.test(code),
        dependencies: resolveAll(file, code, RELATIVE_LITERAL),
        loaded: resolveAll(file, code, LOADED_LITERAL),
      };
      infos.set(file, info);
    }
    return info;
  }

  function resolveAll(file, code, literal) {
    return [...code.matchAll(literal)]
      .map((match) => resolveLiteral(file, match[2]))
      .filter((dependency) => dependency !== undefined);
  }

  /** Whether `key` holds for a start file or any file it reaches. */
  function reaches(starts, key) {
    const seen = new Set();
    const pending = [...starts];
    while (pending.length > 0) {
      const file = pending.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      const info = infoOf(file);
      if (info[key]) return true;
      pending.push(...info.dependencies);
    }
    return false;
  }

  return function startsChildProcesses(testFile) {
    const test = infoOf(testFile);
    if (!test.replaces) return reaches([testFile], 'names');
    // The test file's mock covers every import in the files it reaches, so
    // there only a use past the mock counts.
    if (reaches([testFile], 'bypasses')) return true;
    // A file loaded at run time may be loaded by the factory itself, and then
    // it and everything it reaches get the real module: the strict check.
    return reaches(test.loaded, 'names');
  };
}

/** The source of a file on disk, or undefined for a directory or a missing file. */
function readFromDisk(file) {
  try {
    return statSync(file).isFile() ? readFileSync(file, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

describe('the detector, on small trees of files', () => {
  /** Whether `main.test.mjs` of the tree starts a child process. */
  function startsIn(files) {
    const at = (name) => path.resolve('/fx', name);
    const tree = new Map(
      Object.entries(files).map(([name, source]) => [at(name), source]),
    );
    return createDetector((file) => tree.get(file))(at('main.test.mjs'));
  }

  const lines = (...parts) => parts.join('\n');
  const helperImports = { 'fx-helper.mjs': `import cp from '${NODE_CP}';` };

  it.each([
    ['a static import', `import { spawnSync } from '${NODE_CP}';`],
    ['a bare specifier without the node: prefix', `import cp from "${CP}";`],
    ['a dynamic import', `const cp = await import('${NODE_CP}');`],
    ['a require', `const cp = require('${CP}');`],
    [
      'createRequire',
      lines(
        `const require = createRequire(import.meta.url);`,
        `const cp = require('${NODE_CP}');`,
      ),
    ],
    ['getBuiltinModule', `const cp = process.getBuiltinModule('${NODE_CP}');`],
    ['vi.importActual', `const cp = await vi.importActual('${NODE_CP}');`],
    ['a template literal', 'const cp = require(`' + NODE_CP + '`);'],
    [
      'a factory that takes importOriginal',
      lines(
        `vi.mock('${NODE_CP}', async (importOriginal) => importOriginal());`,
        `import { spawnSync } from '${NODE_CP}';`,
      ),
    ],
    [
      'a parameterless factory that wraps the real module',
      lines(
        `vi.mock('${NODE_CP}', async () => vi.importActual('${NODE_CP}'));`,
        `import { spawnSync } from '${NODE_CP}';`,
      ),
    ],
    [
      'a parameterless factory next to a require, which it does not cover',
      lines(
        `vi.mock('${NODE_CP}', () => ({ execFile: vi.fn() }));`,
        `const cp = require('${NODE_CP}');`,
      ),
    ],
    [
      'a parameterless factory undone by vi.doUnmock',
      lines(
        `vi.mock('${NODE_CP}', () => ({ execFile: vi.fn() }));`,
        `vi.doUnmock('${NODE_CP}');`,
        `import { execFile } from '${NODE_CP}';`,
      ),
    ],
    [
      'a parameterless factory undone by vi.unmock',
      lines(
        `vi.mock('${NODE_CP}', () => ({}));`,
        `vi.unmock('${NODE_CP}');`,
        `import cp from '${NODE_CP}';`,
      ),
    ],
    [
      'code after a block comment on the same line',
      `/* note */ import cp from '${NODE_CP}';`,
    ],
    [
      'code after a block comment that closes on a later line',
      lines('/*', ' * note', ` */ import cp from '${NODE_CP}';`),
    ],
    [
      'code after a glob in a string, which holds a slash and a star',
      lines(`const glob = 'src/**/*.ts';`, `import cp from '${NODE_CP}';`),
    ],
  ])('finds %s', (_label, source) => {
    expect(startsIn({ 'main.test.mjs': source })).toBe(true);
  });

  it.each([
    [
      'an import of a module that imports it',
      `import { run } from './fx-helper.mjs';`,
    ],
    [
      'a new URL, not an import',
      `const helper = new URL('./fx-helper.mjs', import.meta.url);`,
    ],
    [
      'a path join with a quoted relative path',
      `const helper = path.join(here, './fx-helper.mjs');`,
    ],
  ])('follows %s', (_label, source) => {
    expect(startsIn({ 'main.test.mjs': source, ...helperImports })).toBe(true);
  });

  it.each([
    ['createRequire', `createRequire(import.meta.url)('${NODE_CP}');`],
    ['getBuiltinModule', `process.getBuiltinModule('${NODE_CP}');`],
    ['vi.importActual', `await vi.importActual('${NODE_CP}');`],
  ])(
    'finds %s in a helper, which a parameterless mock does not cover',
    (_label, use) => {
      expect(
        startsIn({
          'main.test.mjs': lines(
            `vi.mock('${NODE_CP}', () => ({}));`,
            `import { run } from './fx-helper.mjs';`,
          ),
          'fx-helper.mjs': `const cp = ${use}`,
        }),
      ).toBe(true);
    },
  );

  it('finds getBuiltinModule in a helper that the factory loads', () => {
    expect(
      startsIn({
        'main.test.mjs': `vi.mock('${NODE_CP}', async () => (await import('./fx-real.mjs')).default);`,
        'fx-real.mjs': `export default process.getBuiltinModule('${NODE_CP}');`,
      }),
    ).toBe(true);
  });

  // Vitest gives a file that the factory loads the real module, so a plain
  // import in that file spawns, though the same import in a file the test
  // imports statically gets the mock.
  const factoryLoading = (load) =>
    lines(
      `vi.mock('${NODE_CP}', async () => {`,
      `  ${load}`,
      `  return { spawnSync: real.spawnSync };`,
      `});`,
    );

  it.each([
    ['an import()', `const { real } = await import('./fx-real.mjs');`],
    ['a require', `const { real } = require('./fx-real.mjs');`],
    [
      'vi.importActual',
      `const { real } = await vi.importActual('./fx-real.mjs');`,
    ],
  ])(
    'finds a plain import in a helper that the factory loads with %s',
    (_label, load) => {
      expect(
        startsIn({
          'main.test.mjs': factoryLoading(load),
          'fx-real.mjs': lines(
            `import * as cp from '${NODE_CP}';`,
            `export const real = cp;`,
          ),
        }),
      ).toBe(true);
    },
  );

  it('finds a plain import two static imports behind a helper that the factory loads', () => {
    expect(
      startsIn({
        'main.test.mjs': factoryLoading(
          `const { real } = await import('./fx-real.mjs');`,
        ),
        'fx-real.mjs': `export { real } from './fx-inner.mjs';`,
        'fx-inner.mjs': lines(
          `import * as cp from '${NODE_CP}';`,
          `export const real = cp;`,
        ),
      }),
    ).toBe(true);
  });

  it('counts a module that a test body loads with import(), which looks the same as the factory loading it', () => {
    expect(
      startsIn({
        'main.test.mjs': lines(
          `vi.mock('${NODE_CP}', () => ({}));`,
          `it('x', async () => { await import('./fx-helper.mjs'); });`,
        ),
        ...helperImports,
      }),
    ).toBe(true);
  });

  it('follows an import of another test file', () => {
    expect(
      startsIn({
        'main.test.mjs': `import './fx-other.test.mjs';`,
        'fx-other.test.mjs': `import cp from '${NODE_CP}';`,
      }),
    ).toBe(true);
  });

  it.each([
    ['./fx-h.tsx', 'fx-h.tsx'],
    ['./fx-h.mts', 'fx-h.mts'],
    ['./fx-h.cts', 'fx-h.cts'],
    ['./fx-h.cjs', 'fx-h.cjs'],
    ['./fx-h.jsx', 'fx-h.jsx'],
    ['./fx-h.js', 'fx-h.ts'],
    ['./fx-h.js', 'fx-h.tsx'],
    ['./fx-h.mjs', 'fx-h.mts'],
    ['./fx-h.cjs', 'fx-h.cts'],
    ['./fx-h.jsx', 'fx-h.tsx'],
    ['./fx-h', 'fx-h.mts'],
    ['./fx-h', 'fx-h.cjs'],
    ['./fx-dir', 'fx-dir/index.ts'],
    ['./fx-dir', 'fx-dir/index.tsx'],
    ['./fx-dir', 'fx-dir/index.mjs'],
  ])('resolves %s to %s', (specifier, file) => {
    expect(
      startsIn({
        'main.test.mjs': `import x from '${specifier}';`,
        [file]: `import cp from '${NODE_CP}';`,
      }),
    ).toBe(true);
  });

  it.each([
    ['no use of the module', `import path from 'node:path';`],
    ['the name in a line comment', `// import cp from '${NODE_CP}';`],
    [
      'the name in a block comment',
      lines('/*', ` * from '${NODE_CP}'`, ' */', 'const x = 1;'),
    ],
    [
      'the name in a block comment before code on the same line',
      `/* import cp from '${NODE_CP}' */ const x = 1;`,
    ],
    [
      'a parameterless factory that replaces the module, and its import',
      lines(
        `vi.mock('${NODE_CP}', () => ({ execFile: vi.fn() }));`,
        `import { execFile } from '${NODE_CP}';`,
      ),
    ],
    [
      'an async parameterless factory that replaces the module',
      lines(
        `vi.mock('${NODE_CP}', async () => ({ execFile: vi.fn() }));`,
        `const { execFile } = await import('${NODE_CP}');`,
      ),
    ],
    [
      'a function factory with no parameter',
      lines(
        `vi.mock('${CP}', function () { return {}; });`,
        `import cp from '${CP}';`,
      ),
    ],
    [
      'a replaced module and a helper that imports it, under the same mock',
      lines(
        `vi.mock('${NODE_CP}', () => ({}));`,
        `import { run } from './fx-helper.mjs';`,
      ),
    ],
    [
      'a parameterless factory and a run-time load of a module that never names it',
      lines(
        `vi.mock('${NODE_CP}', () => ({}));`,
        `const { x } = await import('./fx-plain.mjs');`,
      ),
    ],
    [
      'a relative path to a file that is not there',
      `const x = new URL('./fx-missing.mjs', import.meta.url);`,
    ],
    [
      'a relative path to a file that is not code',
      `const x = './fx-data.json';`,
    ],
  ])('finds nothing in %s', (_label, source) => {
    expect(
      startsIn({
        'main.test.mjs': source,
        ...helperImports,
        'fx-plain.mjs': `export const x = 1;`,
        'fx-data.json': `{ "cp": "${CP}" }`,
      }),
    ).toBe(false);
  });

  it('stops on files that import each other', () => {
    expect(
      startsIn({
        'main.test.mjs': `import './fx-a.mjs';`,
        'fx-a.mjs': `import './fx-b.mjs';`,
        'fx-b.mjs': `import './fx-a.mjs';\nimport './main.test.mjs';`,
      }),
    ).toBe(false);
  });
});

const byName = (a, b) => a.localeCompare(b);

/** The test files a vitest project collects, as vitest globs them. */
function filesOf({ include, exclude = configDefaults.exclude }) {
  return globSync(include, { cwd: ROOT, ignore: exclude, onlyFiles: true })
    .map((file) => file.split(path.sep).join('/'))
    .sort(byName);
}

const startsChildProcesses = createDetector(readFromDisk);
const everyTestFile = filesOf({ include: TEST_INCLUDE });
const spawning = everyTestFile.filter((file) =>
  startsChildProcesses(path.join(ROOT, file)),
);

const isTestFile = (file) => /\.(?:test|spec)\.(?:ts|tsx|mjs)$/.test(file);

describe('SPAWN_TEST_FILES', () => {
  it('finds the test files that start a child process, directly or through a fixture', () => {
    // A detector that finds nothing would pass every test below.
    expect(spawning).toEqual(
      expect.arrayContaining([
        'api/__tests__/no-database-guard.test.ts',
        'scripts/_lib/spawn-timeout.test.mjs',
        'scripts/_lib/prune-worktrees.test.mjs',
        'scripts/_lib/vercel-build-file-set.test.mjs',
      ]),
    );
  });

  it('leaves out the tests that replace child_process outright', () => {
    expect(spawning).not.toContain('scripts/_lib/session-status.test.mjs');
    expect(spawning).not.toContain('scripts/_lib/watch-deploy.test.mjs');
  });

  it('lists every test file that starts a child process', () => {
    const missing = spawning.filter((file) => !SPAWN_TEST_FILES.includes(file));
    expect(missing, 'add these to SPAWN_TEST_FILES in vite.config.ts').toEqual(
      [],
    );
  });

  it('names only files that exist', () => {
    const gone = SPAWN_TEST_FILES.filter(
      (file) => readFromDisk(path.join(ROOT, file)) === undefined,
    );
    expect(
      gone,
      'remove these from SPAWN_TEST_FILES in vite.config.ts',
    ).toEqual([]);
  });

  it('names only test files, each once, in sorted order', () => {
    expect(SPAWN_TEST_FILES.filter((file) => !isTestFile(file))).toEqual([]);
    expect(SPAWN_TEST_FILES).toEqual(
      [...new Set(SPAWN_TEST_FILES)].sort(byName),
    );
  });
});

describe('the spawn and main projects', () => {
  const projects = config.test.projects.map((project) => project.test);
  const spawn = projects.find((project) => project.name === 'spawn');
  const main = projects.find((project) => project.name === 'main');

  it('are the only two, and both extend the root config', () => {
    expect(projects.map((project) => project.name).sort(byName)).toEqual([
      'main',
      'spawn',
    ]);
    expect(config.test.projects.map((project) => project.extends)).toEqual([
      true,
      true,
    ]);
  });

  it('leave the root config without a test.include', () => {
    expect(
      config.test.include,
      "a project that extends the root config gets its own include joined onto the root's (vite mergeConfig concatenates arrays), so a root include would put every test file in the spawn project",
    ).toBeUndefined();
  });

  it('run the spawn project first, in a group above 0', () => {
    expect(spawn.sequence.groupOrder).toBeLessThan(main.sequence.groupOrder);
    expect(
      spawn.sequence.groupOrder,
      'a group-0 project with one worker is moved into vitest sequential group, which runs after every other group',
    ).toBeGreaterThanOrEqual(1);
  });

  it('give the spawn project a few workers, never more than the machine would', () => {
    expect(Number.isInteger(spawn.maxWorkers)).toBe(true);
    expect(spawn.maxWorkers).toBeGreaterThanOrEqual(1);
    expect(spawn.maxWorkers).toBeLessThanOrEqual(6);
    expect(spawn.maxWorkers).toBeLessThanOrEqual(
      Math.max(1, availableParallelism() - 1),
    );
    expect(main.maxWorkers).toBeUndefined();
  });

  it('keep vitest default exclusions in main, and drop every spawn file', () => {
    expect(main.exclude).toEqual(
      expect.arrayContaining([...configDefaults.exclude, ...SPAWN_TEST_FILES]),
    );
  });

  it('make the spawn project exactly SPAWN_TEST_FILES', () => {
    expect(filesOf(spawn)).toEqual([...SPAWN_TEST_FILES]);
  });

  it('put every test file in exactly one of them', () => {
    const inSpawn = filesOf(spawn);
    const inMain = filesOf(main);
    expect(inSpawn.filter((file) => inMain.includes(file))).toEqual([]);
    expect([...inSpawn, ...inMain].sort(byName)).toEqual(everyTestFile);
  });
});
