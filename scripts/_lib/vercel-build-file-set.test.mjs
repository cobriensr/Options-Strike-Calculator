// @vitest-environment node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { GitError, runGit } from './git-run.mjs';
import {
  createStripMatcher,
  findStrippedAssetRefs,
  findStrippedBuildFiles,
} from './vercel-build-file-set.mjs';

// Both mocks wrap the real function, so every test runs real git and real
// file-system calls. A test queues one failing call (mockImplementationOnce) to
// reach what real git and a real disk won't produce on demand: `git init`
// failing, and the clean-up after it failing too.
vi.mock('./git-run.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runGit: vi.fn(actual.runGit) };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

// Every test spawns real git, synchronously, so a slow spawn can only be failed
// after it finishes. Under a loaded gate a one-spawn test took 15-19 s against
// the default 15 s; this is a ceiling, as in scratch-git.fixtures.mjs.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * Fails when a file Vercel strips would be compiled by its build.
 *
 * Vercel's build (`npm run build`) runs `tsc -b` (tsconfig.json: src, e2e)
 * and `tsc --noEmit -p tsconfig.api.json` (api) after .vercelignore has
 * removed scripts/ (all but write-build-info.mjs), ml/, e2e/, docs/,
 * sidecar/, uw-stream/ and more. A root file in a stripped path just
 * vanishes. A kept file that imports into a stripped path fails the deploy
 * with TS2307, while local runs and CI pass, because the folder exists there.
 * That is not limited to api/ importing scripts/: a src/ test importing
 * scripts/ breaks `tsc -b` the same way.
 *
 * A regex can't guard it. `ml/` is stripped, but `api/ml/` is a real endpoint
 * folder (api/__tests__/plots.test.ts imports ../ml/plots.js). So this builds
 * the real programs with the TypeScript API (config parsed as tsc parses it,
 * stripped roots dropped, `ts.createProgram`, no type-check) and asserts that
 * no source file outside node_modules lies under a path .vercelignore strips.
 * A failure prints the import chain, one line per importer:
 * `tsconfig.api.json: api/x.ts -> scripts/y.ts`.
 *
 * .vercelignore is matched by git, in a throwaway repo whose .gitignore is a
 * copy of it (see createStripMatcher): real gitignore semantics (`!`
 * negation, leading-`/` anchoring) with no second implementation and no new
 * dependency. The alternative, the `ignore` package, is only a transitive
 * dependency today, and pinning it would add a devDependency for one test.
 * The matcher is pinned against the real file below, so a git config that
 * changes the answers fails loudly instead of letting an offender through.
 * Its git runs apart from the machine's: the hostile-environment test pins
 * the GIT_* filter and `core.excludesFile=`; GIT_CONFIG_GLOBAL and
 * `--template=` each block a hostile global init.templateDir on their own, so
 * no environment can tell which one is missing, and the args test pins them.
 *
 * Case: a Windows or macOS checkout resolves `../Scripts/x` to the real
 * folder, so tsc reports a path Linux never has. Matching ignores case.
 *
 * vite build also reads files the TypeScript program never sees (CSS, JSON,
 * ?raw, new URL); the asset block scans for relative literals that name a
 * stripped path. Residuals, not covered:
 * - computed or root-absolute paths, and file reads in vite.config.ts;
 * - a bare directory literal (`'../docs'`, no trailing slash): the scan is a
 *   literal grep against a repo with no files in it, so the directory-only
 *   `/docs/` pattern needs the slash to match. `reportsDirectory:
 *   './coverage'` in vite.config.ts passes only because of this;
 * - the reverse, a false alarm: a quoted path in a comment, or a literal only
 *   vitest reads in vite.config.ts, is flagged though vite build ignores it;
 * - an ambient .d.ts in a stripped root (`e2e/globals.d.ts`): the root is
 *   dropped and nothing imports it, so it vanishes with no finding.
 *
 * The checker has fixture tests below, so a regression in it can't pass for
 * "nothing is stripped". Fixtures use a minimal tsconfig pair (no lib, no
 * types) with the build's include lists; the real run uses the real configs.
 */

// vitest runs from the repo root (same convention as eslint-api-guard.test.mjs).
const ROOT = process.cwd();

/** The retries Windows needs when a scanner or indexer holds a fresh file. */
const REMOVE = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };

/** Best effort: a temp dir that can't be removed is leaked, never a failure. */
function removeQuietly(dir) {
  try {
    rmSync(dir, REMOVE);
  } catch {
    // The OS clears its temp dir; a leaked scratch dir proves nothing.
  }
}

/** True on a case-insensitive file system (Windows, default macOS). */
const CASE_INSENSITIVE_FS = (() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'case-probe-'));
  try {
    writeFileSync(path.join(dir, 'Probe'), '');
    return existsSync(path.join(dir, 'probe'));
  } finally {
    removeQuietly(dir);
  }
})();

let matcher;
const scratchDirs = [];
const extraMatchers = [];

/** A temp dir that afterAll removes. */
function scratchDir(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

/** A matcher beside the shared one; afterAll disposes it. */
function makeMatcher(vercelIgnoreText) {
  const created = createStripMatcher(vercelIgnoreText);
  extraMatchers.push(created);
  return created;
}

/** What `fn` threw; fails the test when it returns instead. */
function thrownBy(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw, but it returned');
}

beforeAll(() => {
  matcher = createStripMatcher(
    readFileSync(path.join(ROOT, '.vercelignore'), 'utf8'),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => {
  // Every dispose and every scratch dir is attempted; none can fail the file.
  for (const created of [matcher, ...extraMatchers]) {
    try {
      created?.dispose();
    } catch {
      // Same as removeQuietly: a leaked matcher dir is not a test result.
    }
  }
  for (const dir of scratchDirs) removeQuietly(dir);
});

const COMPILER_OPTIONS = {
  module: 'esnext',
  moduleResolution: 'bundler',
  allowImportingTsExtensions: true,
  noEmit: true,
  noLib: true,
  types: [],
};

/** Every project has input in both build projects, so no config is empty. */
const BASE_FILES = {
  'src/main.ts': 'export {};\n',
  'api/index.ts': 'export {};\n',
};

/**
 * Writes a fixture repo under a new temp dir and returns its root. `files`
 * go under the root, `outside` beside it (a file the root does not own).
 */
function makeProject(files, outside = {}) {
  const base = scratchDir('vercel-file-set-');
  const root = path.join(base, 'repo');
  const write = (dir, rel, text) => {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  };
  write(
    root,
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: COMPILER_OPTIONS,
      include: ['src', 'e2e'],
    }),
  );
  write(
    root,
    'tsconfig.api.json',
    JSON.stringify({
      compilerOptions: COMPILER_OPTIONS,
      include: ['api'],
    }),
  );
  for (const [rel, text] of Object.entries({ ...BASE_FILES, ...files })) {
    write(root, rel, text);
  }
  for (const [rel, text] of Object.entries(outside)) write(base, rel, text);
  return root;
}

const offendersOf = (files, outside) =>
  findStrippedBuildFiles(makeProject(files, outside), matcher).offenders.sort();

const Y = 'export const y = 1;\nexport type Y = number;\n';
const USE_Y = "import { y } from '../scripts/y.js';\nexport const x = y;\n";

describe('createStripMatcher (the real .vercelignore)', () => {
  it.each([
    'scripts/x.ts',
    'scripts/_lib/y.ts',
    'ml/a.py',
    'e2e/a.ts',
    'docs/a.md',
    'README.md',
    'sidecar/src/a.py',
    'uw-stream/a.py',
    'pine/a.pine',
    // Case-insensitive: the checkout on Windows or macOS may spell it so.
    'Scripts/x.ts',
    'SCRIPTS/_lib/y.ts',
    'ML/a.py',
    'E2E/a.ts',
  ])('strips %s', (file) => {
    expect(matcher.strippedAmong([file])).toEqual(new Set([file]));
  });

  it.each([
    // The one exception inside scripts/.
    'scripts/write-build-info.mjs',
    // Anchored: only the root folder is stripped.
    'api/ml/plots.ts',
    'api/__tests__/ml/x.test.ts',
    'src/scripts/x.ts',
    'src/e2e/x.ts',
    'api/README.md',
    'src/main.ts',
    'api/_lib/scripts-registry.ts',
  ])('keeps %s', (file) => {
    expect(matcher.strippedAmong([file])).toEqual(new Set());
  });

  it('answers a mixed list in one call', () => {
    expect(
      matcher.strippedAmong(['src/a.ts', 'scripts/x.ts', 'api/ml/p.ts']),
    ).toEqual(new Set(['scripts/x.ts']));
  });

  it('throws a GitError when git check-ignore fails, instead of reporting nothing stripped', () => {
    // A path above the repo makes git exit 128; only 0 and 1 are answers.
    const err = thrownBy(() => matcher.strippedAmong(['..']));
    expect(err).toBeInstanceOf(GitError);
    expect(err.message).toMatch(
      /check-ignore --no-index --stdin -z: exit code 128: fatal: .*outside repository/,
    );
  });
});

describe('createStripMatcher (isolation from the machine)', () => {
  const realIgnore = readFileSync(path.join(ROOT, '.vercelignore'), 'utf8');
  const slash = (p) => p.replaceAll('\\', '/');

  /**
   * A home that would strip api/ through every route git has: its global
   * config (init.templateDir, core.excludesFile), the XDG default ignore file,
   * a template dir, and a repository its exclude file points at.
   */
  function hostileHome() {
    const home = scratchDir('hostile-home-');
    const write = (rel, text) => {
      const abs = path.join(home, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, text);
      return abs;
    };
    write('template/info/exclude', 'api/\n');
    write('global-ignore', 'api/\n');
    write('xdg/git/ignore', 'api/\n');
    write('repo/info/exclude', 'api/\n');
    // The least git accepts as a repository, for GIT_DIR to point at.
    write('repo/HEAD', 'ref: refs/heads/main\n');
    mkdirSync(path.join(home, 'repo', 'objects'));
    mkdirSync(path.join(home, 'repo', 'refs'));
    const config = write(
      '.gitconfig',
      [
        '[init]',
        `\ttemplateDir = "${slash(path.join(home, 'template'))}"`,
        '[core]',
        `\texcludesFile = "${slash(path.join(home, 'global-ignore'))}"`,
        '',
      ].join('\n'),
    );
    return { home, config };
  }

  /** Stubs the hostile environment into process.env; returns the home. */
  function stubHostileEnv() {
    const { home, config } = hostileHome();
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('XDG_CONFIG_HOME', path.join(home, 'xdg'));
    vi.stubEnv('GIT_CONFIG_GLOBAL', config);
    vi.stubEnv('GIT_TEMPLATE_DIR', path.join(home, 'template'));
    vi.stubEnv('GIT_DIR', path.join(home, 'repo'));
    vi.stubEnv('GIT_INDEX_FILE', path.join(home, 'repo', 'hostile-index'));
    return home;
  }

  // The control. Without it, the next test could pass on a fixture that no
  // longer does anything. A GIT_DIR with no work tree makes git treat the repo
  // as bare, which is an error rather than a wrong answer, so it is left out.
  it('is hostile to a plain git: the same environment strips api/', () => {
    const home = stubHostileEnv();
    const env = { ...process.env };
    delete env.GIT_DIR;
    delete env.GIT_INDEX_FILE;
    const stripsApi = (gitEnv, initFlags) => {
      const dir = scratchDir('control-');
      expect(
        runGit(['-C', dir, 'init', '-q', ...initFlags], gitEnv).status,
      ).toBe(0);
      const check = ['-C', dir, 'check-ignore', '--no-index', 'api/b.ts'];
      return runGit(check, gitEnv).status === 0;
    };
    // Its global config: init.templateDir and core.excludesFile.
    expect(stripsApi(env, [])).toBe(true);
    // The XDG default ignore file alone: no global config, no template.
    delete env.GIT_TEMPLATE_DIR;
    env.GIT_CONFIG_GLOBAL = path.join(home, 'no-such-config');
    expect(stripsApi(env, ['--template='])).toBe(true);
  });

  it('answers from .vercelignore alone, whatever git config and GIT_* variables surround it', () => {
    stubHostileEnv();
    expect(
      makeMatcher(realIgnore).strippedAmong(['api/b.ts', 'scripts/x.ts']),
    ).toEqual(new Set(['scripts/x.ts']));
  });

  it('runs git in its own directory, with no template and a global config of its own', () => {
    // GIT_CONFIG_GLOBAL and --template= each block a hostile global
    // init.templateDir alone, so no environment fails when only one is
    // dropped. This pins both on the call.
    vi.mocked(runGit).mockClear();
    makeMatcher('/x/\n').strippedAmong(['x/a.ts']);
    const [initCall, checkCall] = vi.mocked(runGit).mock.calls;
    const [initArgs, env] = initCall;
    const dir = initArgs[1];
    expect(initArgs).toEqual(['-C', dir, 'init', '-q', '--template=']);
    expect(checkCall[0].slice(0, 2)).toEqual(['-C', dir]);
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(path.dirname(env.GIT_CONFIG_GLOBAL)).toBe(dir);
    expect(existsSync(env.GIT_CONFIG_GLOBAL)).toBe(false);
  });
});

describe('createStripMatcher (failures)', () => {
  /** The dir the matcher made, from the `-C <dir>` of its first git call. */
  const dirOfFirstGitCall = () => vi.mocked(runGit).mock.calls[0][0][1];

  it('throws a GitError naming the command when git is not installed', () => {
    vi.stubEnv('PATH', scratchDir('no-git-path-'));
    vi.mocked(runGit).mockClear();
    const err = thrownBy(() => createStripMatcher('/x/\n'));
    expect(err).toBeInstanceOf(GitError);
    expect(err.message).toMatch(/^git -C .+ init -q.*: spawnSync git ENOENT$/);
    expect(existsSync(dirOfFirstGitCall())).toBe(false);
  });

  it("throws a GitError with git's own message when git init fails, and removes its dir", () => {
    vi.mocked(runGit).mockClear();
    vi.mocked(runGit).mockImplementationOnce(() => ({
      status: 128,
      stdout: '',
      stderr: 'fatal: cannot mkdir .git\n',
    }));
    const err = thrownBy(() => createStripMatcher('/x/\n'));
    expect(err).toBeInstanceOf(GitError);
    expect(err.detail).toBe('exit code 128: fatal: cannot mkdir .git');
    expect(err.message).toMatch(/^git -C .+ init -q.*: exit code 128/);
    expect(existsSync(dirOfFirstGitCall())).toBe(false);
  });

  it('reports the original error when removing its dir fails as well', () => {
    vi.mocked(runGit).mockClear();
    vi.mocked(runGit).mockImplementationOnce(() => ({
      status: 128,
      stdout: '',
      stderr: 'fatal: cannot mkdir .git\n',
    }));
    vi.mocked(rmSync).mockImplementationOnce(() => {
      throw new Error('EBUSY: resource busy or locked');
    });
    const err = thrownBy(() => createStripMatcher('/x/\n'));
    // The dir the failed clean-up left behind.
    removeQuietly(dirOfFirstGitCall());
    expect(err).toBeInstanceOf(GitError);
    expect(err.detail).toBe('exit code 128: fatal: cannot mkdir .git');
  });
});

describe('findStrippedBuildFiles (fixtures)', () => {
  // Each break is reported, with the chain that names the importer.
  it.each([
    [
      'a value import from api/',
      { 'api/x.ts': USE_Y, 'scripts/y.ts': Y },
      ['tsconfig.api.json: api/x.ts -> scripts/y.ts'],
    ],
    [
      'an import type from api/',
      {
        'api/x.ts':
          "import type { Y } from '../scripts/y.js';\nexport type X = Y;\n",
        'scripts/y.ts': Y,
      },
      ['tsconfig.api.json: api/x.ts -> scripts/y.ts'],
    ],
    [
      'an import() type in api/',
      {
        'api/x.ts': "export type X = import('../scripts/y.js').Y;\n",
        'scripts/y.ts': Y,
      },
      ['tsconfig.api.json: api/x.ts -> scripts/y.ts'],
    ],
    [
      'a dynamic import() in api/',
      {
        'api/x.ts': "export const load = () => import('../scripts/y.js');\n",
        'scripts/y.ts': Y,
      },
      ['tsconfig.api.json: api/x.ts -> scripts/y.ts'],
    ],
    [
      'a re-export in api/',
      {
        'api/x.ts': "export { y } from '../scripts/y.js';\n",
        'scripts/y.ts': Y,
      },
      ['tsconfig.api.json: api/x.ts -> scripts/y.ts'],
    ],
    [
      'a triple-slash path reference in api/',
      {
        'api/x.ts': '/// <reference path="../scripts/y.ts" />\nexport {};\n',
        'scripts/y.ts': Y,
      },
      ['tsconfig.api.json: api/x.ts -> scripts/y.ts'],
    ],
    [
      'a test in src/ (tsc -b)',
      { 'src/x.test.ts': USE_Y, 'scripts/y.ts': Y },
      ['tsconfig.json: src/x.test.ts -> scripts/y.ts'],
    ],
    [
      'an import type in a src/ test (tsc -b)',
      {
        'src/x.test.ts':
          "import type { Y } from '../scripts/y.js';\nexport type X = Y;\n",
        'scripts/y.ts': Y,
      },
      ['tsconfig.json: src/x.test.ts -> scripts/y.ts'],
    ],
    [
      'src/ importing a stripped e2e/ file that is also a dropped root',
      {
        'src/x.ts': "export { y } from '../e2e/helpers.js';\n",
        'e2e/helpers.ts': Y,
      },
      ['tsconfig.json: src/x.ts -> e2e/helpers.ts'],
    ],
    [
      'api/ importing the root ml/, not api/ml/',
      {
        'api/x.ts': "export { y } from '../ml/model.js';\n",
        'ml/model.ts': Y,
      },
      ['tsconfig.api.json: api/x.ts -> ml/model.ts'],
    ],
    [
      'a transitive import through src/, named by the whole chain',
      {
        'api/x.ts': "export { y } from '../src/util.js';\n",
        'src/util.ts': "export { y } from '../scripts/y.js';\n",
        'scripts/y.ts': Y,
      },
      [
        // The api project reaches src/util.ts through api/x.ts, and the src
        // project has it as a root.
        'tsconfig.api.json: api/x.ts -> src/util.ts -> scripts/y.ts',
        'tsconfig.json: src/util.ts -> scripts/y.ts',
      ],
    ],
    [
      'a stripped file that imports more stripped files lists only the first',
      {
        'api/x.ts': USE_Y,
        'scripts/y.ts': "export { z as y } from './z.js';\n",
        'scripts/z.ts': 'export const z = 1;\n',
      },
      ['tsconfig.api.json: api/x.ts -> scripts/y.ts'],
    ],
    [
      'every importer of one stripped file, not only the first',
      {
        'api/a.ts': USE_Y,
        'api/b.ts': USE_Y,
        'scripts/y.ts': Y,
      },
      [
        'tsconfig.api.json: api/a.ts -> scripts/y.ts',
        'tsconfig.api.json: api/b.ts -> scripts/y.ts',
      ],
    ],
    [
      'importers at different depths, each with its own chain',
      {
        'api/x.ts': "export { y } from '../src/util.js';\n",
        'src/util.ts': "export { y } from '../scripts/y.js';\n",
        'api/z.ts': USE_Y,
        'scripts/y.ts': Y,
      },
      [
        'tsconfig.api.json: api/x.ts -> src/util.ts -> scripts/y.ts',
        'tsconfig.api.json: api/z.ts -> scripts/y.ts',
        'tsconfig.json: src/util.ts -> scripts/y.ts',
      ],
    ],
    [
      'one importer that names the same stripped file twice (one line)',
      {
        'api/x.ts': `${USE_Y}export type X2 = import('../scripts/y.js').Y;\n`,
        'scripts/y.ts': Y,
      },
      ['tsconfig.api.json: api/x.ts -> scripts/y.ts'],
    ],
  ])('reports %s', (_name, files, expected) => {
    expect(offendersOf(files)).toEqual(expected);
  });

  // The config itself pulls a stripped file in: nothing imports it, so there is
  // no importer to name, and it is listed on its own beside the ones that have
  // one (the old code listed only the importers whenever any existed).
  it('reports a stripped file the config pulls in (typeRoots) beside an import', () => {
    const root = makeProject({
      'src/x.test.ts': USE_Y,
      'scripts/y.ts': Y,
      'scripts/typings/mine/index.d.ts': 'declare const mine: number;\n',
    });
    writeFileSync(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          ...COMPILER_OPTIONS,
          typeRoots: ['./scripts/typings'],
          types: ['mine'],
        },
        include: ['src', 'e2e'],
      }),
    );
    expect(findStrippedBuildFiles(root, matcher).offenders.sort()).toEqual([
      'tsconfig.json: scripts/typings/mine/index.d.ts',
      'tsconfig.json: src/x.test.ts -> scripts/y.ts',
    ]);
  });

  // The case a mismatch resolves only where the file system ignores case.
  // Where it does not, tsc can't find the file, so there is nothing to
  // report; the matcher cases above pin the case-insensitive match itself.
  it.runIf(CASE_INSENSITIVE_FS)(
    'reports an import whose case differs from the folder',
    () => {
      const offenders = offendersOf({
        'api/x.ts':
          "import { y } from '../Scripts/y.js';\nexport const x = y;\n",
        'scripts/y.ts': Y,
      });
      // tsc may report either spelling; the path is the same file.
      expect(offenders.map((line) => line.toLowerCase())).toEqual([
        'tsconfig.api.json: api/x.ts -> scripts/y.ts',
      ]);
    },
  );

  // Nothing here may be reported.
  it.each([
    [
      'api/ml/ (a real endpoint folder) imported from a test',
      {
        'api/ml/plots.ts': Y,
        'api/__tests__/plots.test.ts':
          "import { y } from '../ml/plots.js';\nexport const x = y;\n",
        'api/__tests__/ml/trigger.test.ts':
          "import { y } from '../../ml/plots.js';\nexport const x = y;\n",
      },
    ],
    [
      'a stripped root that imports a stripped path (it never builds)',
      {
        'e2e/a.spec.ts':
          "import { y } from '../scripts/y.js';\nexport const x = y;\n",
        'scripts/y.ts': Y,
      },
    ],
    [
      'stripped files nothing imports',
      { 'scripts/y.ts': Y, 'ml/model.ts': Y, 'docs/x.ts': Y },
    ],
    [
      'a scripts/ folder below src/ (the rule is anchored to the root)',
      {
        'src/scripts/ok.ts': Y,
        'src/a.ts': "export { y } from './scripts/ok.js';\n",
      },
    ],
    [
      'a node_modules path that matches a pattern',
      {
        'node_modules/pkg/index.d.ts':
          '/// <reference path="./__pycache__/t.d.ts" />\nexport declare const p: T;\n',
        'node_modules/pkg/__pycache__/t.d.ts': 'type T = number;\n',
        'api/x.ts': "export { p } from 'pkg';\n",
      },
    ],
  ])('stays clean for %s', (_name, files) => {
    expect(offendersOf(files)).toEqual([]);
  });

  it('ignores a file outside the repo root', () => {
    expect(
      offendersOf(
        { 'api/x.ts': "export { s } from '../../shared.js';\n" },
        { 'shared.ts': 'export const s = 1;\n' },
      ),
    ).toEqual([]);
  });

  it('counts the roots it dropped and the files it compiled', () => {
    const { stats } = findStrippedBuildFiles(
      makeProject({ 'e2e/a.spec.ts': Y, 'e2e/b.spec.ts': Y }),
      matcher,
    );
    expect(stats).toEqual([
      { config: 'tsconfig.json', roots: 3, droppedRoots: 2, projectFiles: 1 },
      {
        config: 'tsconfig.api.json',
        roots: 1,
        droppedRoots: 0,
        projectFiles: 1,
      },
    ]);
  });

  it('throws when every root is stripped, instead of passing vacuously', () => {
    const root = makeProject({});
    writeFileSync(
      path.join(root, 'tsconfig.api.json'),
      JSON.stringify({
        compilerOptions: COMPILER_OPTIONS,
        include: ['scripts'],
      }),
    );
    mkdirSync(path.join(root, 'scripts'));
    writeFileSync(path.join(root, 'scripts', 'only.ts'), Y);
    expect(() => findStrippedBuildFiles(root, matcher)).toThrow(
      /tsconfig\.api\.json: .vercelignore strips every root file/,
    );
  });

  it('throws on a config it cannot parse', () => {
    const root = makeProject({});
    writeFileSync(path.join(root, 'tsconfig.api.json'), '{ "include": [');
    expect(() => findStrippedBuildFiles(root, matcher)).toThrow(
      /tsconfig\.api\.json:/,
    );
  });
});

describe('findStrippedAssetRefs (fixtures)', () => {
  it.each([
    [
      'a CSS @import',
      { 'src/a.css': "@import '../docs/x.css';\n" },
      ["src/a.css: '../docs/x.css' -> docs/x.css"],
    ],
    [
      'a CSS url()',
      { 'src/a.css': '.a { background: url(../scripts/x.png); }\n' },
      ["src/a.css: '../scripts/x.png' -> scripts/x.png"],
    ],
    [
      'a ?raw import',
      {
        'src/a.ts': "import t from '../ml/notes.md?raw';\nexport default t;\n",
      },
      ["src/a.ts: '../ml/notes.md?raw' -> ml/notes.md"],
    ],
    [
      'new URL(…, import.meta.url)',
      {
        'src/components/a.ts':
          "export const u = new URL('../../scripts/x.json', import.meta.url);\n",
      },
      ["src/components/a.ts: '../../scripts/x.json' -> scripts/x.json"],
    ],
    [
      'import.meta.glob',
      { 'src/a.ts': "export const m = import.meta.glob('../docs/*.md');\n" },
      ["src/a.ts: '../docs/*.md' -> docs/*.md"],
    ],
    [
      'an index.html attribute',
      {
        'index.html': '<script type="module" src="./scripts/boot.js"></script>',
      },
      ["index.html: './scripts/boot.js' -> scripts/boot.js"],
    ],
  ])('reports %s', (_name, files, expected) => {
    expect(findStrippedAssetRefs(makeProject(files), matcher)).toEqual(
      expected,
    );
  });

  it.each([
    [
      'a .test file (vite build never reads one)',
      { 'src/b.test.ts': "export const p = '../scripts/x.json';\n" },
    ],
    [
      'a .spec file',
      { 'src/b.spec.tsx': "export const p = '../scripts/x.json';\n" },
    ],
    [
      'a helper in a __tests__ folder, whose name is no test name',
      {
        'src/__tests__/helpers/h.ts':
          "export const p = '../../../scripts/x';\n",
      },
    ],
    [
      'a scripts/ folder below src/',
      { 'src/a.ts': "import d from './scripts/ok.json';\nexport default d;\n" },
    ],
    [
      'a sibling asset and a path that leaves the repo',
      {
        'src/a.css': "@import './b.css';\n",
        'src/c.ts': "export const p = '../../../docs/x';\n",
      },
    ],
    // `../..` from src/ is the folder above the repo; git exits 128 on it, and
    // that used to fail the whole scan. `../` is the repo root, which is fine.
    [
      'a path that lands on the folder above the repo',
      { 'src/c.ts': "export const p = '../..';\n" },
    ],
    [
      'a path that lands on the folder above the repo, with a slash',
      { 'src/c.ts': "export const p = '../../';\n" },
    ],
    [
      'a path that lands on the repo root',
      { 'src/c.ts': "export const p = '../';\n" },
    ],
    ['an api/ file (vite build never reads api/)', { 'api/x.ts': USE_Y }],
  ])('stays clean for %s', (_name, files) => {
    expect(findStrippedAssetRefs(makeProject(files), matcher)).toEqual([]);
  });
});

describe('the build the checker mirrors', () => {
  const scripts = JSON.parse(
    readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
  ).scripts;

  // findStrippedBuildFiles walks tsconfig.json and tsconfig.api.json. A third
  // tsc project in `npm run build` would compile files it never looks at.
  it('runs tsc for exactly the two projects the checker walks', () => {
    const tscCalls = [...scripts.build.matchAll(/\btsc\b[^&]*/g)].map((m) =>
      m[0].trim(),
    );
    expect(tscCalls).toEqual(['tsc -b', 'tsc --noEmit -p tsconfig.api.json']);
  });

  it('has a tsconfig.json that `tsc -b` builds alone, with no project references', () => {
    const { config } = ts.readConfigFile(
      path.join(ROOT, 'tsconfig.json'),
      ts.sys.readFile,
    );
    expect(config.references).toBeUndefined();
  });
});

describe('the real repo', () => {
  it('compiles no file .vercelignore strips, in either build project', () => {
    const started = performance.now();
    const { offenders, stats } = findStrippedBuildFiles(ROOT, matcher);
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    expect(offenders, `build file set, ${seconds} s`).toEqual([]);
    // Not vacuous: each project compiled a real number of files.
    expect(stats.map((s) => s.config)).toEqual([
      'tsconfig.json',
      'tsconfig.api.json',
    ]);
    for (const { projectFiles } of stats) {
      expect(projectFiles).toBeGreaterThan(100);
    }
  }, 180_000);

  it('reads no file from a stripped path in vite build', () => {
    expect(findStrippedAssetRefs(ROOT, matcher)).toEqual([]);
  }, 60_000);
});
