// @vitest-environment node
import { existsSync, readFileSync, statSync } from 'node:fs';
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
 * A file starts a child process when it, or a module it imports (through
 * relative imports, other tests excluded), imports child_process, unless it
 * replaces that module outright with a `vi.mock` factory that takes no
 * parameter: session-status.test.mjs and watch-deploy.test.mjs do, run no
 * child and stay in `main`. A factory that takes `importOriginal` wraps the
 * real module, so its file counts. Tinyglobby loads through vitest's own
 * dependency tree, the copy vitest globs with.
 */

// vitest runs from the repo root (same convention as coverage-thresholds.test.mjs).
const ROOT = process.cwd();

const { globSync } = createRequire(
  createRequire(import.meta.url).resolve('vitest/package.json'),
)('tinyglobby');

/**
 * `from '<child_process>'`, `import '<child_process>'` and
 * `import('<child_process>')`, with or without the `node:` prefix.
 */
const CHILD_PROCESS_IMPORT =
  /\b(?:from|import)[\s(]*['"](?:node:)?child_process['"]/;

/** `vi.mock('<child_process>', () => ...)`: a factory with no parameter. */
const CHILD_PROCESS_REPLACED =
  /vi\.mock\(\s*['"](?:node:)?child_process['"]\s*,\s*\(\s*\)\s*=>/;

/** A relative import: `from './x.mjs'` or `import('../y')`. */
const RELATIVE_IMPORT = /\b(?:from|import)[\s(]*['"](\.{1,2}\/[^'"]+)['"]/g;

/** The code lines of a source: those that do not start a comment. */
function codeOf(source) {
  return source
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n');
}

const importsChildProcess = (code) => CHILD_PROCESS_IMPORT.test(code);
const replacesChildProcess = (code) => CHILD_PROCESS_REPLACED.test(code);

// The module name is spliced into the samples below, so that this file does not
// itself contain an import of it (the scan below reads this file too).
const NODE = 'node:child_process';
const BARE = 'child_process';

describe('the child_process rules (self-check of the detector)', () => {
  it.each([
    [`import { spawnSync } from '${NODE}';`, true],
    [`} from "${BARE}";`, true],
    [`const cp = await import('${NODE}');`, true],
    [` * calls spawnSync from '${NODE}'`, false],
    ["import path from 'node:path';", false],
  ])('importsChildProcess(%j) is %s', (line, expected) => {
    expect(importsChildProcess(codeOf(line))).toBe(expected);
  });

  it.each([
    [`vi.mock('${NODE}', () => ({ execFile: vi.fn() }));`, true],
    [`vi.mock('${BARE}', ()=>({}))`, true],
    [`vi.mock('${NODE}', async (importOriginal) => {`, false],
    ["vi.mock('node:fs', () => ({}));", false],
  ])('replacesChildProcess(%j) is %s', (line, expected) => {
    expect(replacesChildProcess(codeOf(line))).toBe(expected);
  });
});

/** Repo-relative, forward slashes. */
const slashed = (file) => file.split(path.sep).join('/');

/** The file a relative import names, or null for a missing file. */
function resolveImport(from, specifier) {
  const base = path.resolve(path.dirname(from), specifier);
  const candidates = [
    base,
    base.replace(/\.js$/, '.ts'),
    `${base}.ts`,
    `${base}.mjs`,
    `${base}.js`,
    path.join(base, 'index.ts'),
  ];
  return (
    candidates.find((file) => existsSync(file) && statSync(file).isFile()) ??
    null
  );
}

const isTestFile = (file) => /\.(?:test|spec)\.(?:ts|tsx|mjs)$/.test(file);

/** What one file says about child_process; each file is read once. */
const infos = new Map();
function infoOf(file) {
  let info = infos.get(file);
  if (info === undefined) {
    const code = codeOf(readFileSync(file, 'utf8'));
    info = {
      imports: importsChildProcess(code),
      replaces: replacesChildProcess(code),
      dependencies: [...code.matchAll(RELATIVE_IMPORT)]
        .map((match) => resolveImport(file, match[1]))
        .filter((dependency) => dependency !== null && !isTestFile(dependency)),
    };
    infos.set(file, info);
  }
  return info;
}

/** Whether running the test file starts a child process. */
function startsChildProcesses(testFile) {
  if (infoOf(testFile).replaces) return false;
  const seen = new Set();
  const pending = [testFile];
  while (pending.length > 0) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const info = infoOf(file);
    if (info.imports) return true;
    pending.push(...info.dependencies);
  }
  return false;
}

const byName = (a, b) => a.localeCompare(b);

/** The test files a vitest project collects, as vitest globs them. */
function filesOf({ include, exclude = configDefaults.exclude }) {
  return globSync(include, { cwd: ROOT, ignore: exclude, onlyFiles: true })
    .map(slashed)
    .sort(byName);
}

const everyTestFile = filesOf({ include: TEST_INCLUDE });
const spawning = everyTestFile.filter((file) =>
  startsChildProcesses(path.join(ROOT, file)),
);

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
    expect(missing).toEqual([]);
  });

  it('names only files that exist', () => {
    const gone = SPAWN_TEST_FILES.filter(
      (file) => !existsSync(path.join(ROOT, file)),
    );
    expect(gone).toEqual([]);
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

  it('run the spawn project first', () => {
    expect(spawn.sequence.groupOrder).toBeLessThan(main.sequence.groupOrder);
  });

  it('give the spawn project a few workers, not the machine', () => {
    expect(Number.isInteger(spawn.maxWorkers)).toBe(true);
    expect(spawn.maxWorkers).toBeGreaterThanOrEqual(1);
    expect(spawn.maxWorkers).toBeLessThanOrEqual(6);
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
