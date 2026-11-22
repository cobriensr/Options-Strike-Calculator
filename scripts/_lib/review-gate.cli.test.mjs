// @vitest-environment node

/**
 * Commit-gate tests, second half: the hook's partial-commit and rename
 * cases, per-worktree markers, and the review-gate CLI. review-gate.test.mjs
 * has the first half and the overview; the two are split so vitest runs
 * them on separate workers. Shared helpers are in review-gate.fixtures.mjs.
 * Spec: docs/superpowers/specs/commit-gate-2026-10-28.md.
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gatePipeName } from './gate-lock.mjs';
import {
  CLI,
  DRIFTED,
  MARKER,
  NO_MARKER,
  SEAL_REFUSED,
  claudeCommit,
  gate,
  gateEnv,
  git,
  headSubject,
  initRepo,
  markerFile,
  review,
  run,
  write,
} from './review-gate.fixtures.mjs';
import {
  adminDir,
  makeTempDir,
  setupScratchGit,
} from './scratch-git.fixtures.mjs';
import {
  CHILD_TEST_TIMEOUT,
  CHILD_TIMEOUT,
} from './spawn-timeout.fixtures.mjs';

setupScratchGit();

// The same describe name and repo setup as in review-gate.test.mjs, so these
// tests keep their `pre-commit hook > …` path.
describe('pre-commit hook', () => {
  let repo = '';

  beforeEach(() => {
    repo = initRepo(makeTempDir('review-gate-'));
  });

  describe('a partial commit (`git commit -- <path>`)', () => {
    // a.txt is staged and sealed as reviewed, then edited again on disk.
    beforeEach(() => {
      write(repo, 'a.txt', 'a reviewed and staged\n');
      git(repo, 'add', '--', 'a.txt');
      review(repo);
      write(repo, 'a.txt', 'edited after the review, never staged\n');
    });

    it('checks the next-index git builds from the working tree, and blocks', () => {
      const result = claudeCommit(repo, '--', 'a.txt');

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${DRIFTED}\n  a.txt\n`);
      expect(headSubject(repo)).toBe('base');
    });

    it('while a plain commit of the staged, reviewed content is allowed', () => {
      const result = claudeCommit(repo);

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(git(repo, 'show', 'HEAD:a.txt')).toBe('a reviewed and staged');
    });
  });

  // One test per diff: each fails if `--no-renames` is dropped from that
  // diff alone, because rename detection would hide the deleted path there.
  describe('--no-renames', () => {
    it('in stagedPaths: a reviewed copy staged with an unreviewed deletion blocks', () => {
      // With rename detection, staged would be [z.txt] and drifted [a.txt]:
      // no overlap, and the unreviewed deletion of a.txt would commit.
      write(repo, 'z.txt', readFileSync(path.join(repo, 'a.txt'), 'utf8'));
      review(repo);
      git(repo, 'rm', '-q', '--', 'a.txt');
      git(repo, 'add', '--', 'z.txt');

      const result = claudeCommit(repo);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${DRIFTED}\n  a.txt\n`);
      expect(result.stderr).not.toContain('  z.txt');
      expect(headSubject(repo)).toBe('base');
    });

    it('in driftedPaths: an unreviewed deletion that reads as a rename from the sealed tree blocks', () => {
      // HEAD has identical x.txt and y.txt. Review saw y.txt deleted; the
      // commit deletes x.txt instead. Sealed tree [x] vs index [y] is a
      // rename x -> y, so with rename detection drifted would be [y.txt],
      // staged is [x.txt], and the unreviewed deletion would commit.
      write(repo, 'x.txt', 'same content\n');
      write(repo, 'y.txt', 'same content\n');
      git(repo, 'add', '--', 'x.txt', 'y.txt');
      git(repo, 'commit', '-q', '-m', 'twins');
      rmSync(path.join(repo, 'y.txt'));
      review(repo);
      git(repo, 'checkout', '--', 'y.txt');
      git(repo, 'rm', '-q', '--', 'x.txt');

      const result = claudeCommit(repo);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${DRIFTED}\n  x.txt\n`);
      expect(result.stderr).not.toContain('  y.txt');
      expect(headSubject(repo)).toBe('twins');
    });
  });
});

describe('linked worktrees', () => {
  let repo = '';
  let linked = '';

  beforeEach(() => {
    repo = initRepo(makeTempDir('review-gate-wt-'));
    linked = path.join(path.dirname(repo), 'linked');
    git(repo, 'worktree', 'add', '-q', '-b', 'linked', linked, 'HEAD');
  });

  it('keeps a separate marker in each worktree admin dir', () => {
    const mainMarker = path.join(repo, '.git', MARKER);
    const linkedMarker = path.join(repo, '.git', 'worktrees', 'linked', MARKER);
    expect(markerFile(repo)).toBe(mainMarker);
    expect(markerFile(linked)).toBe(linkedMarker);

    review(repo);
    expect(existsSync(mainMarker)).toBe(true);
    expect(existsSync(linkedMarker)).toBe(false);

    write(linked, 'a.txt', 'edited in the linked worktree\n');
    git(linked, 'add', '--', 'a.txt');
    const blocked = claudeCommit(linked);
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain(NO_MARKER);

    const mainBody = readFileSync(mainMarker, 'utf8');
    review(linked);
    expect(existsSync(linkedMarker)).toBe(true);
    expect(readFileSync(mainMarker, 'utf8')).toBe(mainBody);

    const cleared = gate(linked, 'clear');
    expect(cleared.status).toBe(0);
    expect(existsSync(linkedMarker)).toBe(false);
    expect(readFileSync(mainMarker, 'utf8')).toBe(mainBody);
  });

  it('commits in a sealed linked worktree while the unsealed main stays blocked', () => {
    write(linked, 'a.txt', 'reviewed in the linked worktree\n');
    review(linked);
    git(linked, 'add', '--', 'a.txt');

    const result = claudeCommit(linked);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(headSubject(linked)).toBe('claude');

    write(repo, 'b.txt', 'edited in main\n');
    git(repo, 'add', '--', 'b.txt');
    const blocked = claudeCommit(repo);
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain(NO_MARKER);
  });
});

describe('review-gate CLI', () => {
  let repo = '';

  beforeEach(() => {
    repo = initRepo(makeTempDir('review-gate-cli-'));
  });

  function leftoverTempIndexes() {
    return readdirSync(adminDir(repo)).filter((name) =>
      name.startsWith('review-gate-index'),
    );
  }

  it('seal records the whole working tree and HEAD without touching the real index', () => {
    write(repo, 'a.txt', 'modified, unstaged\n');
    write(repo, 'c.txt', 'untracked\n');
    write(repo, 'ignored.txt', 'gitignored\n');
    const before = Date.now();

    const result = gate(repo, 'seal', { npm_lifecycle_event: 'review' });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const marker = JSON.parse(readFileSync(markerFile(repo), 'utf8'));
    expect(Object.keys(marker).sort()).toEqual(['head', 'sealedAt', 'tree']);
    expect(marker.head).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(git(repo, 'cat-file', '-t', marker.tree)).toBe('tree');
    expect(git(repo, 'ls-tree', '-r', '--name-only', marker.tree)).toBe(
      ['.gitignore', 'a.txt', 'b.txt', 'c.txt'].join('\n'),
    );
    expect(git(repo, 'show', `${marker.tree}:a.txt`)).toBe(
      'modified, unstaged',
    );
    const sealedAt = Date.parse(marker.sealedAt);
    expect(sealedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(sealedAt).toBeLessThanOrEqual(Date.now());
    expect(result.stdout).toContain(marker.tree);
    // The real index is untouched: nothing staged, c.txt still untracked.
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(repo, 'status', '--porcelain')).toBe('M a.txt\n?? c.txt');
    expect(leftoverTempIndexes()).toEqual([]);
  });

  it.each([
    ['unset', undefined, 'npm_lifecycle_event is unset'],
    ['"test"', 'test', 'npm_lifecycle_event is "test"'],
    ['"review:fast"', 'review:fast', 'npm_lifecycle_event is "review:fast"'],
    [
      '"review:steps" (that script run directly, not through the runner)',
      'review:steps',
      'npm_lifecycle_event is "review:steps"',
    ],
  ])('seal refuses when npm_lifecycle_event is %s', (_label, event, detail) => {
    const result = gate(repo, 'seal', { npm_lifecycle_event: event });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(SEAL_REFUSED);
    expect(result.stderr).toContain(detail);
    expect(existsSync(markerFile(repo))).toBe(false);
    expect(leftoverTempIndexes()).toEqual([]);
  });

  it('seal removes its temp index and writes no marker when git add fails', () => {
    // An embedded repo with no commit makes `git add -A` exit 128.
    const nested = path.join(repo, 'nested');
    mkdirSync(nested);
    git(nested, 'init', '-q');
    write(nested, 'n.txt', 'n\n');

    const result = gate(repo, 'seal', { npm_lifecycle_event: 'review' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('review-gate seal failed: git add -A');
    expect(result.stderr).toContain("'nested/' does not have a commit");
    expect(existsSync(markerFile(repo))).toBe(false);
    expect(leftoverTempIndexes()).toEqual([]);
  });

  it('clear removes the marker, and succeeds when there is none', () => {
    review(repo);
    expect(existsSync(markerFile(repo))).toBe(true);

    const first = gate(repo, 'clear');
    expect(first.stderr).toBe('');
    expect(first.status).toBe(0);
    expect(existsSync(markerFile(repo))).toBe(false);

    const second = gate(repo, 'clear');
    expect(second.stderr).toBe('');
    expect(second.status).toBe(0);
  });

  it('a cleared marker blocks the next commit', () => {
    write(repo, 'a.txt', 'reviewed\n');
    review(repo);
    gate(repo, 'clear');
    git(repo, 'add', '--', 'a.txt');

    const result = claudeCommit(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(NO_MARKER);
  });

  it.each([
    ['an unknown subcommand', ['bogus']],
    ['no subcommand', []],
    ['an extra argument', ['check', 'extra']],
  ])('prints usage and exits 2 for %s', (_label, args) => {
    const result = run(repo, process.execPath, [CLI, ...args]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'usage: node scripts/review-gate.mjs <clear|seal|check|run>',
    );
  });
});

/** Wait for `promise`, or fail naming `what` after `ms` of real time. */
function soon(promise, what, ms = CHILD_TIMEOUT) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error(`gave up after ${ms / 1000} s waiting for ${what}`)),
      ms,
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** The shell npm runs `review:steps` under: Git Bash on Windows, as npm uses. */
function chainShell() {
  const fromNpm = process.env.npm_config_script_shell;
  if (fromNpm) return fromNpm;
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  if (process.platform !== 'win32') return '/bin/bash';
  if (!existsSync(gitBash)) throw new Error(`no Git Bash at ${gitBash}`);
  return gitBash;
}

/** A path as a bash command line can take it. */
const forBash = (file) => file.replaceAll('\\', '/');

/** What a holder child runs: take the lock, say so, and stay alive holding it. */
const HOLDER_SCRIPT = `
const [, pipeName, worktree, moduleUrl] = process.argv;
const { acquireGateLock } = await import(moduleUrl);
await acquireGateLock({ pipeName, holder: { worktree }, onWait: () => {} });
console.log('held');
`;
const LOCK_MODULE_URL = new URL('./gate-lock.mjs', import.meta.url).href;

/** A scratch package.json whose `review:steps` is `steps`; its path. */
function writePackage(dir, steps) {
  const scripts = steps === undefined ? {} : { 'review:steps': steps };
  write(dir, 'package.json', JSON.stringify({ name: 'scratch', scripts }));
  return path.join(dir, 'package.json');
}

/** A chain script: says where it ran, then exits with $CHAIN_EXIT. */
function writeChain(dir) {
  write(
    dir,
    'chain.cjs',
    "console.log('chain ran in ' + process.cwd());\n" +
      'process.exit(Number(process.env.CHAIN_EXIT ?? 0));\n',
  );
}

/** `node scripts/review-gate.mjs run` in `cwd`, to the end; the usual result. */
function runCli(cwd, extraEnv = {}) {
  return run(cwd, process.execPath, [CLI, 'run'], {
    npm_config_script_shell: chainShell(),
    ...extraEnv,
  });
}

const children = [];

/** What a test registers to undo what it started, run after it, pass or fail. */
const cleanups = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});

/** The first line a holder of the lock sends a client, parsed. */
function readHolderLine(pipeName) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeName);
    let text = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      text += chunk;
      const end = text.indexOf('\n');
      if (end === -1) return;
      socket.destroy();
      resolve(JSON.parse(text.slice(0, end)));
    });
    socket.on('error', reject);
  });
}

/**
 * A node child run asynchronously, with its output collected. `reaches(key,
 * pattern)` resolves with the match when stdout or stderr shows the pattern.
 */
function spawnCollected(args, cwd, extraEnv = {}) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: gateEnv(extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(child);
  const out = { stdout: '', stderr: '' };
  const watching = [];
  const check = () => {
    for (const watcher of [...watching]) {
      const match = watcher.pattern.exec(out[watcher.key]);
      if (match) {
        watching.splice(watching.indexOf(watcher), 1);
        watcher.resolve(match);
      }
    }
  };
  for (const key of ['stdout', 'stderr']) {
    child[key].setEncoding('utf8');
    child[key].on('data', (chunk) => {
      out[key] += chunk;
      check();
    });
  }
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    out,
    exited,
    reaches: (key, pattern) =>
      new Promise((resolve) => {
        watching.push({ key, pattern, resolve });
        check();
      }),
  };
}

/** A child that holds this repository's gate lock, as a gate in another session would. */
async function startHolder(repo, worktree) {
  const holder = spawnCollected(
    [
      '--input-type=module',
      '-e',
      HOLDER_SCRIPT,
      gatePipeName('.git', repo),
      worktree,
      LOCK_MODULE_URL,
    ],
    repo,
  );
  await soon(holder.reaches('stdout', /held/), 'the holder to take the lock');
  return holder;
}

describe('review-gate run', { timeout: CHILD_TEST_TIMEOUT }, () => {
  let repo = '';

  beforeEach(() => {
    repo = initRepo(makeTempDir('review-gate-run-'));
    writeChain(repo);
  });

  it.each([0, 3, 127])(
    'runs review:steps in the working directory and exits with its code (%i)',
    (code) => {
      writePackage(repo, 'node chain.cjs');

      const result = runCli(repo, { CHAIN_EXIT: String(code) });

      expect(result.status).toBe(code);
      expect(result.stdout).toContain(`chain ran in ${repo}`);
      // Nobody held the lock: no waiting line.
      expect(result.stderr).not.toContain('waiting for the gate');
    },
  );

  it('lets the chain seal, because npm_lifecycle_event reaches it as it was', () => {
    writePackage(repo, `node "${forBash(CLI)}" seal`);

    const result = runCli(repo, { npm_lifecycle_event: 'review' });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('review-gate: sealed tree');
    expect(existsSync(markerFile(repo))).toBe(true);
  });

  it('does not let the chain seal when it is not run as `npm run review`', () => {
    writePackage(repo, `node "${forBash(CLI)}" seal`);

    const result = runCli(repo, { npm_lifecycle_event: 'review:steps' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(SEAL_REFUSED);
    expect(existsSync(markerFile(repo))).toBe(false);
  });

  it('reads review:steps from npm_package_json when it is set, else from package.json in the working directory', () => {
    writePackage(
      repo,
      'node -e "console.log(\'steps from the working directory\')"',
    );
    const elsewhere = path.join(repo, 'elsewhere');
    const named = writePackage(
      elsewhere,
      'node -e "console.log(\'steps from the named file\')"',
    );

    const withEnv = runCli(repo, { npm_package_json: named });
    const without = runCli(repo);

    expect(withEnv.status).toBe(0);
    expect(withEnv.stdout).toContain('steps from the named file');
    expect(withEnv.stdout).not.toContain('steps from the working directory');
    expect(without.status).toBe(0);
    expect(without.stdout).toContain('steps from the working directory');
  });

  it('runs under the default shell when npm names none', () => {
    writePackage(repo, 'node chain.cjs');

    const result = runCli(repo, { npm_config_script_shell: undefined });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`chain ran in ${repo}`);
  });

  it('runs under the shell npm names, not the default one', () => {
    // `[[ ]]` is bash: cmd.exe has no such command and dash (the Linux sh)
    // answers "not found", so only the named shell exits 0.
    writePackage(repo, '[[ -n $BASH_VERSION ]]');

    const result = runCli(repo);

    expect(result.status).toBe(0);
  });

  it('holds the lock for the whole chain, as the worktree it runs in', async () => {
    write(
      repo,
      'hold.cjs',
      [
        "const fs = require('node:fs');",
        "console.log('chain started');",
        'setTimeout(() => process.exit(0), 120000);',
        'setInterval(() => {',
        '  if (fs.existsSync(process.env.HOLD_TRIGGER)) process.exit(4);',
        '}, 50);',
      ].join('\n'),
    );
    writePackage(repo, 'node hold.cjs');
    const trigger = path.join(repo, 'trigger');
    // However the test ends, the chain is told to leave.
    cleanups.push(() => write(repo, 'trigger', 'go'));
    const gateRun = spawnCollected([CLI, 'run'], repo, {
      npm_config_script_shell: chainShell(),
      HOLD_TRIGGER: trigger,
    });
    await soon(
      gateRun.reaches('stdout', /chain started/),
      'the chain to start',
    );

    // Who a waiter would be told: this process, in this worktree.
    expect(
      await soon(readHolderLine(gatePipeName('.git', repo)), 'the line'),
    ).toEqual({
      pid: gateRun.child.pid,
      worktree: git(repo, 'rev-parse', '--show-toplevel'),
      startedAt: expect.any(Number),
    });

    write(repo, 'trigger', 'go');
    const { code } = await soon(gateRun.exited, 'the run to end');
    expect(code).toBe(4);
  });

  it.each([
    ['no scripts at all', '{"name":"scratch"}'],
    ['no review:steps', '{"scripts":{"test":"vitest"}}'],
    ['an empty review:steps', '{"scripts":{"review:steps":"  "}}'],
    ['a review:steps that is not a string', '{"scripts":{"review:steps":42}}'],
  ])('exits 2 and runs nothing when package.json has %s', (_what, body) => {
    write(repo, 'package.json', body);

    const result = runCli(repo);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('no "review:steps" script in');
    expect(result.stderr).toContain(path.join(repo, 'package.json'));
    expect(result.stdout).not.toContain('chain ran');
  });

  it.each([
    ['is missing', undefined, 'cannot read'],
    ['is not JSON', '{ not json', 'not valid JSON'],
  ])('exits 1 and runs nothing when package.json %s', (_what, body, detail) => {
    if (body !== undefined) write(repo, 'package.json', body);

    const result = runCli(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(detail);
    expect(result.stdout).not.toContain('chain ran');
  });

  it('fails at once for a repository with no review:steps, even while the gate is busy', async () => {
    write(repo, 'package.json', '{"scripts":{}}');
    await startHolder(repo, 'holder-wt');

    const gateRun = spawnCollected([CLI, 'run'], repo, {
      npm_config_script_shell: chainShell(),
    });
    // Not queued behind the holder: a missing script is found before the lock.
    const { code } = await soon(gateRun.exited, 'the run to fail', 15_000);

    expect(code).toBe(2);
    expect(gateRun.out.stderr).toContain('no "review:steps" script in');
    expect(gateRun.out.stderr).not.toContain('waiting for the gate');
  });

  it('exits 1 and never runs the chain unlocked when the lock cannot be set up', () => {
    // Not a git repository: there is no common dir to name the lock after.
    const outside = makeTempDir('review-gate-nogit-');
    writePackage(
      outside,
      "node -e \"require('fs').writeFileSync('ran.txt', 'x')\"",
    );

    const result = runCli(outside);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('review-gate run failed:');
    expect(result.stderr).toContain('not a git repository');
    expect(existsSync(path.join(outside, 'ran.txt'))).toBe(false);
  });

  it('waits for a holder in another worktree of the same repository, names it, and runs when it is gone', async () => {
    const linked = path.join(path.dirname(repo), 'linked');
    git(repo, 'worktree', 'add', '-q', '-b', 'linked', linked, 'HEAD');
    writeChain(linked);
    writePackage(linked, 'node chain.cjs');
    const holder = await startHolder(repo, 'holder-wt');

    // The waiter has the same lock from the other worktree. The handover when
    // the holder goes is the holder's socket closing, not a timer, so this
    // does not wait out the 15 s fallback.
    const waiter = spawnCollected([CLI, 'run'], linked, {
      npm_config_script_shell: chainShell(),
    });
    const line = await soon(
      waiter.reaches('stderr', /review-gate: waiting for the gate in (.*)\n/),
      'the waiting line',
    );

    expect(line[0]).toBe(
      `review-gate: waiting for the gate in holder-wt (pid ${holder.child.pid}, running 0 min)\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(waiter.child.exitCode).toBeNull();
    expect(waiter.out.stdout).not.toContain('chain ran');

    holder.child.kill();
    const { code } = await soon(waiter.exited, 'the waiter to run and exit');

    expect(code).toBe(0);
    expect(waiter.out.stdout).toContain(`chain ran in ${linked}`);
  });
});
