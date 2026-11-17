/**
 * What Vercel's build compiles, checked against what .vercelignore strips.
 *
 * `npm run build` runs `tsc -b` (tsconfig.json: src and e2e) and
 * `tsc --noEmit -p tsconfig.api.json` (api) after .vercelignore has removed
 * scripts/, ml/, e2e/, docs/ and the rest from the upload. A root file that is
 * stripped simply vanishes. A kept file whose import resolves into a stripped
 * path fails the deploy (TS2307), while local and CI runs pass, because every
 * folder exists there. vercel-build-file-set.test.mjs runs these checks.
 *
 * Node builtins plus `typescript` only. Matching uses git itself, see
 * createStripMatcher.
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { GitError, runGit } from './git-run.mjs';

/**
 * The tsc projects `npm run build` compiles, in the order it runs them. The
 * test pins that package.json's `build` script runs tsc for these two only.
 */
const BUILD_TSCONFIGS = ['tsconfig.json', 'tsconfig.api.json'];

/** rmSync retries on Windows, where a scanner can hold a fresh file for a moment. */
const REMOVE_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100,
};

/**
 * Which repo-relative paths .vercelignore strips, by asking git. The file is
 * copied to the .gitignore of a throwaway repo, so `!` negation, leading-`/`
 * anchoring (`/ml/` is the root folder, not `api/ml/`), `**` and directory
 * patterns behave as gitignore defines them, with no second implementation to
 * drift from it. `ignore` (the npm package) would do the same without a
 * spawn, but it would be a new dependency for one test, and git is already
 * required to work in this repo.
 *
 * Matching is case-insensitive (`core.ignorecase=true`): on Windows or macOS a
 * mismatched `../Scripts/x` resolves to the real folder, so the local build
 * passes. Nothing from the machine can leak into the answer:
 * - every GIT_* variable is dropped (GIT_DIR, GIT_INDEX_FILE, GIT_TEMPLATE_DIR
 *   and GIT_CONFIG_* tie git to another repository or config);
 * - GIT_CONFIG_GLOBAL names a file that does not exist, so the user's
 *   ~/.gitconfig and XDG config are not read, and GIT_CONFIG_NOSYSTEM skips
 *   the system config;
 * - `git init --template=` copies no template (a template's info/exclude is a
 *   repository-wide ignore file);
 * - `core.excludesFile=` empties the global excludes file, and with it the XDG
 *   default (`$XDG_CONFIG_HOME/git/ignore`) git falls back to when none is set.
 * Git runs as `git -C <dir>` in the throwaway repo.
 *
 * @param {string} vercelIgnoreText the contents of .vercelignore
 * @returns {{ strippedAmong: (paths: string[]) => Set<string>, dispose: () => void }}
 * @throws {GitError} when git is missing, or `git init` or `check-ignore` fails.
 */
export function createStripMatcher(vercelIgnoreText) {
  const dir = mkdtempSync(path.join(tmpdir(), 'vercelignore-'));
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        // Windows env names are case-insensitive: `Git_Dir` is GIT_DIR there.
        ([name]) => !name.toUpperCase().startsWith('GIT_'),
      ),
    ),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(dir, 'no-gitconfig'),
  };
  /** Git in `dir`; a status outside `okStatuses` throws a GitError. */
  const git = (args, { input, okStatuses = [0] } = {}) => {
    const fullArgs = ['-C', dir, ...args];
    const result = runGit(fullArgs, env, { input });
    if (!okStatuses.includes(result.status)) {
      const stderr = result.stderr.trim();
      const reason = stderr === '' ? '' : `: ${stderr}`;
      throw new GitError(fullArgs, `exit code ${result.status}${reason}`);
    }
    return result;
  };

  try {
    git(['init', '-q', '--template=']);
    writeFileSync(
      path.join(dir, '.gitignore'),
      vercelIgnoreText.replaceAll('\r\n', '\n'),
    );
  } catch (error) {
    try {
      rmSync(dir, REMOVE_OPTIONS);
    } catch {
      // A clean-up failure must not replace the error that caused it.
    }
    throw error;
  }

  return {
    /** The subset of `paths` (repo-relative, '/'-separated) that is stripped. */
    strippedAmong(paths) {
      if (paths.length === 0) return new Set();
      // Exit 0: some path is ignored. 1: none is. Anything else is a failure,
      // and throws.
      const result = git(
        [
          '-c',
          'core.ignorecase=true',
          '-c',
          'core.excludesFile=',
          'check-ignore',
          '--no-index',
          '--stdin',
          '-z',
        ],
        { input: `${paths.join('\0')}\0`, okStatuses: [0, 1] },
      );
      return new Set(result.stdout.split('\0').filter(Boolean));
    },
    dispose() {
      rmSync(dir, REMOVE_OPTIONS);
    },
  };
}

/**
 * `file` relative to `root`, '/'-separated, or null when it lies outside.
 * The prefix is compared without case: tsc keeps the case a specifier was
 * written in, and a Windows drive letter differs by case too.
 */
function relativeTo(root, file) {
  const normalized = file.replaceAll('\\', '/');
  const base = root.replaceAll('\\', '/');
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return normalized.toLowerCase().startsWith(prefix.toLowerCase())
    ? normalized.slice(prefix.length)
    : null;
}

const inNodeModules = (rel) => rel.split('/').includes('node_modules');

/** Parses a tsconfig as `tsc -p` does; throws on any config error. */
function readProject(root, configName) {
  // tsc's own paths are '/'-separated, and it asserts as much on a bad file.
  const configPath = path.join(root, configName).replaceAll('\\', '/');
  const fail = (problem) => {
    throw new Error(
      `${configName}: ${ts.flattenDiagnosticMessageText(problem.messageText, '\n')}`,
    );
  };
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) fail(read.error);
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    root,
    undefined,
    configPath,
  );
  if (parsed.errors.length > 0) fail(parsed.errors[0]);
  return parsed;
}

/**
 * Files `file` pulls in: imports, re-exports, `import()` calls and types, and
 * triple-slash path references (exact path only). Unresolved ones are left
 * out. Only used to name the importer of an offender, so it re-resolves with
 * the program's options instead of reading the program's internals.
 */
function dependencies(file, text, options) {
  const info = ts.preProcessFile(text, true, true);
  const deps = [];
  for (const { fileName } of info.importedFiles) {
    const { resolvedModule } = ts.resolveModuleName(
      fileName,
      file,
      options,
      ts.sys,
    );
    if (resolvedModule != null) deps.push(resolvedModule.resolvedFileName);
  }
  for (const { fileName } of info.referencedFiles) {
    deps.push(path.resolve(path.dirname(file), fileName).replaceAll('\\', '/'));
  }
  return deps;
}

/**
 * Builds the program for each build project the way Vercel would see it and
 * lists every file it compiles that .vercelignore strips.
 *
 * Per project: parse the config with the TypeScript API, drop the root files
 * the upload strips (they don't exist on Vercel), create the program from the
 * rest (no type-check), and take every source file under `root` that is not in
 * node_modules (a junctioned node_modules lies outside `root` altogether).
 * Each hit comes back as one line per importer,
 * `tsconfig.api.json: api/x.ts -> src/util.ts -> scripts/y.ts`, the import
 * chain from a kept root to the first stripped file. Files only reachable
 * through that file are not listed again. A stripped file that nothing
 * imports but the program has anyway (a `typeRoots` folder) is one line with
 * no chain.
 *
 * Residual, not covered: an ambient .d.ts in a stripped root (say
 * `e2e/globals.d.ts`) is dropped with the root and nothing imports it, so the
 * globals it declared vanish on Vercel with no finding here.
 *
 * @param {string} root repo root
 * @param {{ strippedAmong: (paths: string[]) => Set<string> }} matcher
 * @returns {{ offenders: string[], stats: Array<{ config: string, roots: number, droppedRoots: number, projectFiles: number }> }}
 */
export function findStrippedBuildFiles(root, matcher) {
  const offenders = [];
  const stats = [];
  for (const config of BUILD_TSCONFIGS) {
    const { options, fileNames } = readProject(root, config);

    const rootRels = fileNames.map((file) => relativeTo(root, file));
    const strippedRoots = matcher.strippedAmong(rootRels.filter(Boolean));
    const kept = fileNames.filter((_, i) => !strippedRoots.has(rootRels[i]));
    if (kept.length === 0) {
      throw new Error(`${config}: .vercelignore strips every root file`);
    }

    const program = ts.createProgram({ rootNames: kept, options });
    const rels = new Map();
    for (const { fileName } of program.getSourceFiles()) {
      const rel = relativeTo(root, fileName);
      if (rel != null && !inNodeModules(rel)) rels.set(fileName, rel);
    }
    const stripped = matcher.strippedAmong([...rels.values()]);
    const hits = [...rels].filter(([, rel]) => stripped.has(rel));
    stats.push({
      config,
      roots: fileNames.length,
      droppedRoots: fileNames.length - kept.length,
      projectFiles: rels.size,
    });
    if (hits.length === 0) continue;

    // Name the importers. `importsOf` is a file's imports that lie in the
    // program under `root`. Walk them from the kept roots, through kept files
    // only: a stripped file ends the path, and every kept file that imports it
    // is recorded. `parent` is the first route to each kept file.
    const importsOf = (file) => {
      const text = program.getSourceFile(file)?.text;
      return text == null
        ? []
        : dependencies(file, text, options).filter((dep) => rels.has(dep));
    };
    const parent = new Map();
    const importers = new Map();
    const seen = new Set(kept);
    const queue = [...kept];
    while (queue.length > 0) {
      const file = queue.shift();
      for (const dep of importsOf(file)) {
        if (stripped.has(rels.get(dep))) {
          if (!importers.has(dep)) importers.set(dep, new Set());
          importers.get(dep).add(file);
        } else if (!seen.has(dep)) {
          seen.add(dep);
          parent.set(dep, file);
          queue.push(dep);
        }
      }
    }
    // What a stripped file itself imports is the same break, so those files
    // get no line of their own (the first stripped file on a path is named).
    const covered = new Set(importers.keys());
    const pending = [...covered];
    while (pending.length > 0) {
      for (const dep of importsOf(pending.pop())) {
        if (!covered.has(dep)) {
          covered.add(dep);
          pending.push(dep);
        }
      }
    }
    const routeTo = (file) => {
      const route = [file];
      for (let up = parent.get(file); up != null; up = parent.get(up)) {
        route.unshift(up);
      }
      return route.map((f) => rels.get(f)).join(' -> ');
    };
    for (const [file, rel] of hits) {
      const from = importers.get(file);
      if (from != null) {
        for (const importer of from) {
          offenders.push(`${config}: ${routeTo(importer)} -> ${rel}`);
        }
      } else if (!covered.has(file)) {
        // Nothing imports it, but the program has it (a `typeRoots` folder in a
        // stripped path): it still fails the deploy, by name.
        offenders.push(`${config}: ${rel}`);
      }
    }
  }
  return { offenders, stats };
}

// Relative string literals (import, new URL, import.meta.glob, an HTML
// attribute) and unquoted CSS url() values.
const RELATIVE_LITERAL = /(['"`])(\.{1,2}\/[^'"`\r\n]*)\1/g;
const CSS_URL = /url\(\s*(\.{1,2}\/[^)'"\s]*)\s*\)/g;
const ASSET_SCAN_EXTENSIONS = /\.(?:[cm]?[jt]sx?|css|html)$/;
const TEST_FILE = /\.(?:test|spec)\./;

/** Files vite build reads from src/ besides tests, plus its root inputs. */
function viteInputs(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(file);
      } else if (
        ASSET_SCAN_EXTENSIONS.test(entry.name) &&
        !TEST_FILE.test(entry.name)
      ) {
        files.push(file);
      }
    }
  };
  walk(path.join(root, 'src'));
  for (const name of ['index.html', 'vite.config.ts']) {
    const file = path.join(root, name);
    if (existsSync(file)) files.push(file);
  }
  return files;
}

/**
 * The part of vite build the TypeScript program can't see: a CSS `@import`,
 * `url()`, `?raw` import, `new URL(…, import.meta.url)`, `import.meta.glob`
 * or HTML attribute that names a file in a stripped path. This is a scan of
 * relative string literals in the files vite reads (src/ without tests,
 * index.html, vite.config.ts), not a resolver, so it can flag a literal that
 * isn't an import and misses a computed or root-absolute (`/docs/x`) path.
 * One line per hit: `src/a.css: '../docs/x.css' -> docs/x.css`.
 *
 * Residuals, not fixed:
 * - a bare directory literal (`'../docs'`, no trailing slash) is not flagged:
 *   the path is asked of a repo with no files in it, where the directory-only
 *   `/docs/` pattern needs the slash. `reportsDirectory: './coverage'` in
 *   vite.config.ts passes only because of this;
 * - a quoted path in a comment, or a literal only vitest reads in
 *   vite.config.ts, is flagged although vite build ignores it.
 *
 * @param {string} root repo root
 * @param {{ strippedAmong: (paths: string[]) => Set<string> }} matcher
 * @returns {string[]}
 */
export function findStrippedAssetRefs(root, matcher) {
  const refs = [];
  for (const file of viteInputs(root)) {
    const rel = relativeTo(root, file);
    const text = readFileSync(file, 'utf8');
    const specs = [
      ...[...text.matchAll(RELATIVE_LITERAL)].map((m) => m[2]),
      ...[...text.matchAll(CSS_URL)].map((m) => m[1]),
    ];
    for (const spec of specs) {
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(rel), spec.split(/[?#]/)[0]),
      );
      // Outside the repo: `..` (from '../..') is the folder above it, and git
      // fails on a path above its repository.
      const outsideRepo = target === '..' || target.startsWith('../');
      if (!outsideRepo) refs.push({ rel, spec, target });
    }
  }
  const stripped = matcher.strippedAmong([
    ...new Set(refs.map((r) => r.target)),
  ]);
  return refs
    .filter((r) => stripped.has(r.target))
    .map((r) => `${r.rel}: '${r.spec}' -> ${r.target}`);
}
