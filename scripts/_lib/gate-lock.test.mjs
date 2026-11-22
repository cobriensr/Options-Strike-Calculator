// @vitest-environment node

/**
 * Tests for the machine-wide review-gate lock (gate-lock.mjs): one named pipe
 * the OS holds, so only one `npm run review` runs at a time across every
 * worktree of this repo. Spec: docs/superpowers/specs/gate-lock-2026-11-21.md.
 *
 * Every lock test takes its own pipe name (a fresh scratch directory), so the
 * tests never meet and never touch the real gate's pipe. Real pipes and real
 * sockets throughout; only the clock is faked, and only the timers and Date
 * (not setImmediate or nextTick, which the sockets themselves use). A handover
 * that is event-driven needs no fake time to pass, so those tests never
 * advance the clock: if the code leaned on a timer, they would hang and time
 * out.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, realpathSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FALLBACK_MS,
  HANDSHAKE_MS,
  HOLD_CAP_MS,
  PROGRESS_MS,
  REFUSALS_BEFORE_ANNOUNCING,
  RETRY_MS,
  WAIT_CAP_MS,
  acquireGateLock,
  gatePipeName,
} from './gate-lock.mjs';
import {
  FIXTURE_TIMEOUT,
  git,
  makeTempDir,
  setupScratchGit,
} from './scratch-git.fixtures.mjs';
import {
  CHILD_TEST_TIMEOUT,
  CHILD_TIMEOUT,
} from './spawn-timeout.fixtures.mjs';

setupScratchGit();

/**
 * Ceiling for one lock test or hook. setupScratchGit gives the file 600 s, for
 * the git fixtures; a pipe test that hangs should fail in seconds, with the
 * hang named, not sit for ten minutes.
 */
const TEST_TIMEOUT = 30_000;

/**
 * How long a test waits, in real time, for one thing it expects to happen (a
 * line, a connection, a release). Past it the wait fails and names the thing,
 * so a guard that is broken fails its test in seconds and says what never
 * came, instead of hanging until TEST_TIMEOUT and then hanging the clean-up.
 */
const WAIT_DEADLINE_MS = 10_000;

const T0 = Date.UTC(2026, 10, 22, 12, 0, 0);
const MINUTE = 60_000;
const MODULE_URL = new URL('./gate-lock.mjs', import.meta.url).href;

/** What a holder child runs: take the lock, say so, and stay alive holding it. */
const HOLDER_SCRIPT = `
const [, pipeName, worktree, moduleUrl] = process.argv;
const { acquireGateLock } = await import(moduleUrl);
await acquireGateLock({ pipeName, holder: { worktree }, onWait: () => {} });
console.log('held');
`;

/** A fresh, unused pipe name: the real gatePipeName over a scratch repo dir. */
function uniquePipe() {
  const repo = makeTempDir('gate-lock-');
  mkdirSync(path.join(repo, '.git'));
  return gatePipeName('.git', repo);
}

/** One event-loop turn of real I/O. setImmediate is not faked here. */
function turn() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * `promise`, or a failure naming `what` once WAIT_DEADLINE_MS of real time has
 * passed. Real timers: the fake clock is whatever the test left it at.
 */
function soon(promise, what) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = realSetTimeout(
      () =>
        reject(
          new Error(
            `gave up after ${WAIT_DEADLINE_MS / 1000} s waiting for ${what}`,
          ),
        ),
      WAIT_DEADLINE_MS,
    );
  });
  return Promise.race([promise, deadline]).finally(() =>
    realClearTimeout(timer),
  );
}

/** The calls to an `onWait`, and a promise for the nth one. */
function recorder() {
  const calls = [];
  let waiting = [];
  return {
    calls,
    onWait(info) {
      calls.push(info);
      waiting = waiting.filter((entry) => {
        if (calls.length < entry.count) return true;
        entry.resolve();
        return false;
      });
    },
    reach(count) {
      if (calls.length >= count) return Promise.resolve();
      return soon(
        new Promise((resolve) => waiting.push({ count, resolve })),
        `waiting line ${count}`,
      );
    },
  };
}

/** A count of something that happens one at a time, and a promise for the nth. */
function counter(label) {
  let count = 0;
  let waiting = [];
  return {
    get count() {
      return count;
    },
    hit() {
      count += 1;
      waiting = waiting.filter((entry) => {
        if (count < entry.target) return true;
        entry.resolve();
        return false;
      });
    },
    reach(target) {
      if (count >= target) return Promise.resolve();
      return soon(
        new Promise((resolve) => waiting.push({ target, resolve })),
        `${label} number ${target}`,
      );
    },
  };
}

/** A promise for the socket or server closing. (events.once rejects on an 'error'.) */
function closed(emitter) {
  return soon(
    new Promise((resolve) => emitter.once('close', resolve)),
    'a socket to close',
  );
}

/**
 * The holder's line, as a client sees it (net.createConnection: see below).
 * Rejects on an error, a close before the line, or WAIT_DEADLINE_MS, and
 * destroys its socket whichever way it ends.
 */
function readHolderLine(pipeName) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeName);
    let text = '';
    const finish = (error, line) => {
      realClearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(line);
    };
    const timer = realSetTimeout(
      () =>
        finish(new Error(`no holder line within ${WAIT_DEADLINE_MS / 1000} s`)),
      WAIT_DEADLINE_MS,
    );
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      text += chunk;
      const end = text.indexOf('\n');
      if (end === -1) return;
      try {
        finish(undefined, JSON.parse(text.slice(0, end)));
      } catch (error) {
        finish(error);
      }
    });
    socket.on('error', (error) => finish(error));
    socket.on('close', () =>
      finish(new Error('the holder closed before it sent its line')),
    );
  });
}

/** A lock's release, failing with that named if it does not finish. */
function release(lock) {
  return soon(lock.release(), 'a lock to release');
}

const cleanups = [];
const tracked = [];
const settled = new WeakSet();

/** acquireGateLock, remembered so afterEach can release or drain it. */
function acquire(pipeName, worktree, onWait = () => {}) {
  const entry = { lock: null, released: false, settled: false };
  entry.promise = acquireGateLock({ pipeName, holder: { worktree }, onWait });
  entry.promise.then(
    (lock) => {
      entry.lock = lock;
      entry.settled = true;
      settled.add(entry.promise);
    },
    () => {
      entry.settled = true;
      settled.add(entry.promise);
    },
  );
  tracked.push(entry);
  return entry.promise;
}

const isSettled = (promise) => settled.has(promise);

/**
 * setTimeout as it was before the fake clock went in: the child's start-up
 * limit and the clean-up run on real time, whatever the test did to the clock.
 */
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));

/**
 * Await what a handover causes: a waiter winning, or one that lost seeing the
 * winner. The holder's socket closing hands the lock over at once, with no
 * timer. But the OS can still list the name for a few
 * milliseconds after its holder is gone (a probe on 11-21 saw up to 300 ms),
 * and then the waiter's listen fails once, its connect finds nothing, and it
 * takes the lock at its RETRY_MS retry. So the fake clock moves here in
 * retry-sized steps, each after a real tenth of a second for the sockets, and
 * never as far as the fallback tick: a handover that needs that is a missed
 * close event, and fails (after about six seconds of real time).
 */
async function handover(promise) {
  const started = Date.now();
  let done = false;
  const mark = () => {
    done = true;
  };
  promise.then(mark, mark);
  while (!done) {
    await Promise.race([promise.catch(() => {}), realSleep(100)]);
    if (done) break;
    vi.advanceTimersByTime(RETRY_MS);
    expect(Date.now() - started).toBeLessThan(FALLBACK_MS - RETRY_MS);
  }
  return promise;
}

/**
 * Release every lock won and let every waiter that is left win in its turn,
 * so no test leaves a pipe held or a socket open for the next one. A waiter
 * parked on a retry timer needs the fake clock to move, so each round moves
 * it, then gives the sockets a few real milliseconds. It gives up, and says
 * so, after WAIT_DEADLINE_MS of real time, so a test that broke a guard fails
 * in its own words and does not hang its hook.
 */
async function drain() {
  const started = performance.now();
  for (;;) {
    if (performance.now() - started > WAIT_DEADLINE_MS) {
      const open = tracked.filter((entry) => !entry.settled).length;
      throw new Error(
        `clean-up gave up after ${WAIT_DEADLINE_MS / 1000} s with ${open} waiter(s) still waiting`,
      );
    }
    const winner = tracked.find((entry) => entry.lock && !entry.released);
    if (winner) {
      winner.released = true;
      await release(winner.lock);
      continue;
    }
    const open = tracked.filter((entry) => !entry.settled);
    if (open.length === 0) break;
    vi.advanceTimersByTime(FALLBACK_MS);
    await Promise.race([
      realSleep(5),
      ...open.map((entry) =>
        entry.promise.then(
          () => {},
          () => {},
        ),
      ),
    ]);
  }
  tracked.length = 0;
}

/**
 * A server on the pipe that is not the real holder: it says whatever the test
 * wants, so the waiter's handling of a bad or silent holder can be seen.
 * `onConnection` gets each socket.
 */
async function fakeHolder(pipeName, onConnection = () => {}) {
  const sockets = [];
  const connections = counter('a connection to the stand-in holder');
  const server = new net.Server((socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
    onConnection(socket);
    connections.hit();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipeName, resolve);
  });
  const holder = {
    sockets,
    connections,
    async close() {
      for (const socket of sockets) socket.destroy();
      if (server.listening)
        await soon(
          new Promise((resolve) => server.close(resolve)),
          'the stand-in holder to close',
        );
    },
  };
  cleanups.push(() => holder.close());
  return holder;
}

/**
 * Connect to `squatter` `times` times, each a round trip through its server:
 * the next starts when the last has arrived. The server takes connections in
 * order, so a lock that connected in between would show in its count, and a
 * lock that sits on its timer would not.
 */
async function probe(pipeName, squatter, times) {
  for (let i = 0; i < times; i += 1) {
    const target = squatter.connections.count + 1;
    const socket = net.createConnection(pipeName);
    socket.on('error', () => {});
    cleanups.push(() => socket.destroy());
    await squatter.connections.reach(target);
  }
}

/** A holder in a child process, so the test can kill it the hard way. */
async function spawnHolder(pipeName, worktree) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      HOLDER_SCRIPT,
      pipeName,
      worktree,
      MODULE_URL,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  cleanups.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    await once(child, 'exit');
  });
  // A node start-up plus an import, on a machine other sessions are gating
  // on: slow, so the child gets the repo's usual child limit, and a child
  // that misses it fails with that said, not as a bare test timeout.
  await new Promise((resolve, reject) => {
    const limit = realSetTimeout(
      () =>
        reject(
          new Error(
            `holder child did not hold the lock within ${CHILD_TIMEOUT / 1000} s: ${stderr}`,
          ),
        ),
      CHILD_TIMEOUT,
    );
    child.stdout.once('data', () => {
      realClearTimeout(limit);
      resolve();
    });
    child.once('exit', (code) => {
      realClearTimeout(limit);
      reject(
        new Error(`holder child exited (${code}) before it held: ${stderr}`),
      );
    });
  });
  return child;
}

/**
 * Spy on net.connect, passing through, and record each socket it returns. The
 * helpers above use net.createConnection, which is not spied, so only the
 * lock's own connections are counted.
 */
function spyOnConnect() {
  const original = net.connect;
  const sockets = [];
  const made = counter('a connect by the lock');
  vi.spyOn(net, 'connect').mockImplementation((...args) => {
    const socket = original(...args);
    sockets.push(socket);
    made.hit();
    return socket;
  });
  return { sockets, made };
}

/** Spy on net.createServer, passing through: the servers the lock made. */
function spyOnServers() {
  const spy = vi.spyOn(net, 'createServer');
  return () => spy.mock.results.map((result) => result.value);
}

/** An error with a code, as Node's own socket errors carry. */
function codeError(message, code) {
  return Object.assign(new Error(message), { code });
}

/** Set process.platform for the rest of the test; afterEach puts it back. */
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
function pretendPlatform(platform) {
  Object.defineProperty(process, 'platform', {
    ...realPlatform,
    value: platform,
  });
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Date',
    ],
  });
  vi.setSystemTime(T0);
});

afterEach(async () => {
  Object.defineProperty(process, 'platform', realPlatform);
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  await drain();
  vi.useRealTimers();
}, TEST_TIMEOUT);

describe('gatePipeName', { timeout: TEST_TIMEOUT }, () => {
  // Real git, six spawns: on a loaded machine that took 34 s (11-22), so this
  // test gets the git fixtures' ceiling, not the pipe tests'.
  it(
    'is one name for a main checkout, its subfolder and a linked worktree',
    { timeout: FIXTURE_TIMEOUT },
    () => {
      const main = makeTempDir('gate-lock-main-');
      git(main, 'init', '-q', '-b', 'main');
      git(main, 'commit', '-q', '--allow-empty', '-m', 'base');
      const sub = path.join(main, 'sub');
      mkdirSync(sub);
      const linked = path.join(makeTempDir('gate-lock-linked-'), 'wt');
      git(main, 'worktree', 'add', '-q', linked, '-b', 'feature');

      const cwds = [main, sub, linked];
      const raws = cwds.map((cwd) => git(cwd, 'rev-parse', '--git-common-dir'));
      const names = cwds.map((cwd, i) => gatePipeName(raws[i], cwd));

      // git prints three different spellings of one directory.
      expect(new Set(raws).size).toBe(3);
      expect(new Set(names).size).toBe(1);
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'ignores the case of the drive letter',
    () => {
      const repo = makeTempDir('gate-lock-drive-');
      mkdirSync(path.join(repo, '.git'));
      const lower = repo[0].toLowerCase() + repo.slice(1);
      const upper = repo[0].toUpperCase() + repo.slice(1);

      expect(lower).not.toBe(upper);
      expect(gatePipeName('.git', lower)).toBe(gatePipeName('.git', upper));
    },
  );

  it('is a different name for a different repository', () => {
    expect(uniquePipe()).not.toBe(uniquePipe());
  });

  it('lowercases the path on Windows only', () => {
    // realpath.native already returns the on-disk case on Windows, so the
    // lowercasing is a second line of defence; the stub is what lets the
    // test tell it from the first.
    const real = vi.spyOn(realpathSync, 'native');

    pretendPlatform('win32');
    real
      .mockReturnValueOnce('C:\\Repo\\.git')
      .mockReturnValueOnce('c:\\repo\\.git');
    expect(gatePipeName('.git', 'x')).toBe(gatePipeName('.git', 'x'));

    pretendPlatform('linux');
    real.mockReturnValueOnce('/Repo/.git').mockReturnValueOnce('/repo/.git');
    expect(gatePipeName('.git', 'x')).not.toBe(gatePipeName('.git', 'x'));
  });

  it('is a pipe name on Windows and an abstract socket name on Linux', () => {
    const repo = makeTempDir('gate-lock-form-');
    mkdirSync(path.join(repo, '.git'));

    pretendPlatform('win32');
    expect(gatePipeName('.git', repo)).toMatch(
      /^\\\\\.\\pipe\\strike-calc-review-gate-[0-9a-f]{12}$/,
    );
    pretendPlatform('linux');
    expect(gatePipeName('.git', repo)).toMatch(
      /^\0strike-calc-review-gate-[0-9a-f]{12}$/,
    );
  });

  it('throws when the common git dir does not exist', () => {
    const repo = makeTempDir('gate-lock-missing-');
    expect(() => gatePipeName('.git', repo)).toThrow(/ENOENT/);
  });

  it('refuses a platform it has no lock name for, instead of failing to listen for two hours', () => {
    const repo = makeTempDir('gate-lock-platform-');
    mkdirSync(path.join(repo, '.git'));
    pretendPlatform('darwin');
    expect(() => gatePipeName('.git', repo)).toThrow(
      /supports Windows and Linux, not darwin/,
    );
  });
});

describe('the lock', { timeout: TEST_TIMEOUT }, () => {
  it('is taken at once on a free name, and a client reads who holds it', async () => {
    const pipe = uniquePipe();
    const wait = recorder();

    await acquire(pipe, 'wt-A', wait.onWait);

    expect(await readHolderLine(pipe)).toEqual({
      pid: process.pid,
      worktree: 'wt-A',
      startedAt: T0,
    });
    expect(wait.calls).toEqual([]);
  });

  it('tells a queued gate who holds the lock at once, then every minute', async () => {
    const pipe = uniquePipe();
    const wait = recorder();
    await acquire(pipe, 'wt-A');

    acquire(pipe, 'wt-B', wait.onWait);
    await wait.reach(1);

    expect(wait.calls[0].holder).toEqual({
      pid: process.pid,
      worktree: 'wt-A',
      startedAt: T0,
    });
    expect(wait.calls[0].line).toBe(
      `review-gate: waiting for the gate in wt-A (pid ${process.pid}, running 0 min)`,
    );

    vi.advanceTimersByTime(PROGRESS_MS - 1);
    expect(wait.calls).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(wait.calls).toHaveLength(2);
    expect(wait.calls[1].line).toBe(
      `review-gate: waiting for the gate in wt-A (pid ${process.pid}, running 1 min)`,
    );
    expect(wait.calls[1].runningMin).toBe(1);

    vi.advanceTimersByTime(2 * PROGRESS_MS);
    expect(wait.calls).toHaveLength(4);
    expect(wait.calls[3].runningMin).toBe(3);
  });

  it('hands the lock to a waiter the moment the holder releases', async () => {
    const pipe = uniquePipe();
    const wait = recorder();
    const holder = await acquire(pipe, 'wt-A');
    const waiter = acquire(pipe, 'wt-B', wait.onWait);
    await wait.reach(1);

    await release(holder);
    // At most a retry's worth of fake time passes, never a fallback tick: the
    // holder's socket closing hands the lock over.
    await handover(waiter);

    expect(await readHolderLine(pipe)).toMatchObject({ worktree: 'wt-B' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('can be released twice, and the name is free afterwards', async () => {
    const pipe = uniquePipe();
    const holder = await acquire(pipe, 'wt-A');

    await release(holder);
    await release(holder);

    const again = await acquire(pipe, 'wt-B');
    expect(await readHolderLine(pipe)).toMatchObject({ worktree: 'wt-B' });
    await release(again);
  });

  it(
    'hands the lock over when the holder process is killed',
    { timeout: CHILD_TEST_TIMEOUT },
    async () => {
      const pipe = uniquePipe();
      const child = await spawnHolder(pipe, 'child-wt');
      const wait = recorder();
      const waiter = acquire(pipe, 'wt-B', wait.onWait);
      await wait.reach(1);

      expect(wait.calls[0].holder).toMatchObject({
        pid: child.pid,
        worktree: 'child-wt',
      });

      child.kill('SIGKILL');
      await handover(waiter);

      expect(await readHolderLine(pipe)).toMatchObject({ worktree: 'wt-B' });
    },
  );

  it('lets exactly one of three waiters take each release', async () => {
    const pipe = uniquePipe();
    const first = await acquire(pipe, 'wt-0');
    const waits = [recorder(), recorder(), recorder()];
    const waiters = waits.map((wait, i) =>
      acquire(pipe, `wt-${i + 1}`, wait.onWait),
    );
    const winners = [];
    waiters.forEach((promise, i) => promise.then(() => winners.push(i)));
    await Promise.all(waits.map((wait) => wait.reach(1)));

    let holder = first;
    const remaining = new Set([0, 1, 2]);
    while (remaining.size > 0) {
      const before = new Map(
        [...remaining].map((i) => [i, waits[i].calls.length]),
      );
      winners.length = 0;
      await release(holder);
      await handover(Promise.race([...remaining].map((i) => waiters[i])));
      await turn();
      expect(winners).toHaveLength(1);
      const [winner] = winners;
      remaining.delete(winner);
      // Every other waiter saw the winner take over, and is still waiting.
      for (const i of remaining) {
        await handover(waits[i].reach(before.get(i) + 1));
        expect(waits[i].calls.at(-1).holder.worktree).toBe(`wt-${winner + 1}`);
        expect(isSettled(waiters[i])).toBe(false);
      }
      holder = await waiters[winner];
    }
  });

  it('survives a waiter that dies mid-handshake, and serves the next one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const servers = spyOnServers();
    const pipe = uniquePipe();
    await acquire(pipe, 'wt-A');

    // The holder's write to a waiter that has already gone fails with EPIPE
    // (as it does when the waiter is killed between connect and read). Only
    // the holder's own line is failed, and only once: any other write in this
    // process goes through.
    const realWrite = net.Socket.prototype.write;
    let failed = false;
    vi.spyOn(net.Socket.prototype, 'write').mockImplementation(function (
      data,
      ...rest
    ) {
      if (failed || typeof data !== 'string' || !data.startsWith('{"pid"')) {
        return realWrite.call(this, data, ...rest);
      }
      failed = true;
      process.nextTick(() => this.destroy(codeError('write EPIPE', 'EPIPE')));
      return false;
    });
    const gone = net.createConnection(pipe);
    gone.on('error', () => {});
    await closed(gone);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EPIPE'));

    // And the real thing: a client that hangs up as soon as it connects.
    const hangup = net.createConnection(pipe);
    hangup.on('error', () => {});
    hangup.once('connect', () => hangup.destroy());
    await closed(hangup);

    // The server itself can fail too (a failed accept): logged, not fatal.
    servers()[0].emit('error', codeError('accept failed', 'EMFILE'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EMFILE'));

    // The lock is still held, and the next waiter is served.
    const wait = recorder();
    acquire(pipe, 'wt-B', wait.onWait);
    await wait.reach(1);
    expect(wait.calls[0].holder).toMatchObject({ worktree: 'wt-A' });
  });

  describe('a holder that does not identify itself', () => {
    it.each([
      ['says nothing', ''],
      ['is cut short', '{"pid":12,"work'],
    ])(
      'keeps waiting, as an unknown holder, when its line %s',
      async (_what, payload) => {
        const pipe = uniquePipe();
        const squatter = await fakeHolder(pipe, (socket) => {
          if (payload !== '') socket.write(payload);
        });
        const wait = recorder();
        const waiter = acquire(pipe, 'wt-B', wait.onWait);
        await squatter.connections.reach(1);

        vi.advanceTimersByTime(HANDSHAKE_MS);
        await wait.reach(1);

        expect(wait.calls[0].holder).toBeNull();
        expect(wait.calls[0].line).toBe(
          'review-gate: waiting for the gate held by an unknown holder',
        );
        await turn();
        expect(isSettled(waiter)).toBe(false);

        // It is still a holder: the waiter takes the lock when it is gone.
        await squatter.close();
        await handover(waiter);
      },
    );

    it.each([
      ['not JSON', 'hello\n'],
      ['an array', '[1,2]\n'],
      ['a number', '42\n'],
      ['the JSON null', 'null\n'],
      [
        'a pid that is not a number',
        '{"pid":"7","worktree":"w","startedAt":1}\n',
      ],
      ['no worktree', '{"pid":7,"startedAt":1}\n'],
      ['no start time', '{"pid":7,"worktree":"w"}\n'],
      ['longer than any line of ours, with no end', 'x'.repeat(5000)],
    ])(
      'treats a line that is %s as an unknown holder, at once',
      async (_what, line) => {
        const pipe = uniquePipe();
        const squatter = await fakeHolder(pipe, (socket) => socket.write(line));
        const wait = recorder();
        const waiter = acquire(pipe, 'wt-B', wait.onWait);

        await wait.reach(1);

        expect(wait.calls[0].holder).toBeNull();
        expect(wait.calls[0].line).toContain('unknown holder');
        await turn();
        expect(isSettled(waiter)).toBe(false);
        await squatter.close();
        await handover(waiter);
      },
    );

    it('names the holder when its line arrives after the wait for it ended', async () => {
      const pipe = uniquePipe();
      const squatter = await fakeHolder(pipe);
      const wait = recorder();
      acquire(pipe, 'wt-B', wait.onWait);
      await squatter.connections.reach(1);
      vi.advanceTimersByTime(HANDSHAKE_MS);
      await wait.reach(1);
      expect(wait.calls[0].holder).toBeNull();

      squatter.sockets[0].write(
        `${JSON.stringify({ pid: 4321, worktree: 'late-wt', startedAt: T0 })}\n`,
      );
      await wait.reach(2);

      expect(wait.calls[1].holder).toEqual({
        pid: 4321,
        worktree: 'late-wt',
        startedAt: T0,
      });
    });

    it('does not spin on a holder that hangs up before it speaks', async () => {
      const connects = spyOnConnect();
      const pipe = uniquePipe();
      const squatter = await fakeHolder(pipe, (socket) => socket.destroy());
      const wait = recorder();
      acquire(pipe, 'wt-B', wait.onWait);
      await wait.reach(1);
      expect(wait.calls[0].holder).toBeNull();

      // A waiter that retried at once would get in among the probes and the
      // count would run past them; a waiter that waits for its timer does not.
      await probe(pipe, squatter, 5);
      expect(squatter.connections.count).toBe(1 + 5);
      expect(connects.sockets).toHaveLength(1);

      // One millisecond short of the retry delay, still nothing; the
      // millisecond that completes it brings the retry. The delay is pinned to
      // RETRY_MS here, not only to whatever RETRY_MS is.
      vi.advanceTimersByTime(RETRY_MS - 1);
      await probe(pipe, squatter, 1);
      expect(squatter.connections.count).toBe(1 + 5 + 1);
      expect(connects.sockets).toHaveLength(1);

      vi.advanceTimersByTime(1);
      await squatter.connections.reach(1 + 5 + 1 + 1);
      await closed(connects.sockets[1]);
      expect(connects.sockets).toHaveLength(2);
      // The same unknown holder is not announced a second time.
      expect(wait.calls).toHaveLength(1);
    });

    it('does not spin on a holder that names itself and hangs up, again and again', async () => {
      const connects = spyOnConnect();
      const pipe = uniquePipe();
      const line = `${JSON.stringify({ pid: 4321, worktree: 'flaky-wt', startedAt: T0 })}\n`;
      const squatter = await fakeHolder(pipe, (socket) => socket.end(line));
      const wait = recorder();
      acquire(pipe, 'wt-B', wait.onWait);
      await wait.reach(1);
      expect(wait.calls[0].holder).toMatchObject({ worktree: 'flaky-wt' });

      // The first hang-up is how a real handover looks, so it is retried at
      // once: one more connect. The same holder hanging up again is something
      // squatting on the name, and the retry after it waits for its timer.
      await connects.made.reach(2);
      await closed(connects.sockets[1]);
      await probe(pipe, squatter, 5);
      expect(connects.sockets).toHaveLength(2);
      expect(squatter.connections.count).toBe(2 + 5);

      vi.advanceTimersByTime(RETRY_MS - 1);
      await probe(pipe, squatter, 1);
      expect(connects.sockets).toHaveLength(2);

      vi.advanceTimersByTime(1);
      await connects.made.reach(3);
      await closed(connects.sockets[2]);
      await probe(pipe, squatter, 1);
      expect(connects.sockets).toHaveLength(3);
      // The holder is the same one each time: one line, however many rounds.
      expect(wait.calls).toHaveLength(1);
    });
  });

  it('opens one connection to a holder and never a second, however many ticks pass', async () => {
    const connects = spyOnConnect();
    const servers = spyOnServers();
    const pipe = uniquePipe();
    await acquire(pipe, 'wt-A');
    const wait = recorder();
    acquire(pipe, 'wt-B', wait.onWait);
    await wait.reach(1);
    expect(connects.sockets).toHaveLength(1);
    const madeBefore = servers().length;

    // Two ticks in one go start one attempt, not two. (Three ticks would land
    // on the one-minute progress line.)
    vi.advanceTimersByTime(2 * FALLBACK_MS);
    expect(servers()).toHaveLength(madeBefore + 1);
    await soon(once(servers().at(-1), 'error'), 'the listen to fail');
    expect(connects.sockets).toHaveLength(1);

    // Each later tick is one more listen that finds the name taken, and
    // still no second connection.
    vi.advanceTimersByTime(FALLBACK_MS);
    expect(servers()).toHaveLength(madeBefore + 2);
    await soon(once(servers().at(-1), 'error'), 'the listen to fail');
    expect(connects.sockets).toHaveLength(1);
    expect(wait.calls).toHaveLength(1);
  });

  it('stops every timer and connection when it wins, and never connects to itself', async () => {
    const connects = spyOnConnect();
    const servers = spyOnServers();
    const pipe = uniquePipe();
    const holder = await acquire(pipe, 'wt-A');
    const wait = recorder();
    const waiter = acquire(pipe, 'wt-B', wait.onWait);
    await wait.reach(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await release(holder);
    await handover(waiter);

    expect(vi.getTimerCount()).toBe(0);
    expect(connects.sockets).toHaveLength(1);
    expect(connects.sockets[0].destroyed).toBe(true);
    const made = servers().length;
    const lines = wait.calls.length;
    vi.advanceTimersByTime(10 * PROGRESS_MS);
    await turn();
    expect(connects.sockets).toHaveLength(1);
    expect(servers()).toHaveLength(made);
    expect(wait.calls).toHaveLength(lines);
  });

  it('retries soon when the holder left between the failed listen and the connect', async () => {
    const connects = spyOnConnect();
    const pipe = uniquePipe();
    // A listen that reports the name taken, though nobody holds it: the
    // holder that had it has just gone, so the connect finds nothing.
    vi.spyOn(net.Server.prototype, 'listen').mockImplementationOnce(
      function () {
        process.nextTick(() =>
          this.emit('error', codeError('in use', 'EADDRINUSE')),
        );
        return this;
      },
    );

    const waiter = acquire(pipe, 'wt-A');
    await connects.made.reach(1);
    await closed(connects.sockets[0]);

    // One millisecond short of the retry delay the waiter has not retried: a
    // retry that fired early would have taken the free name in the real tenth
    // of a second given here. The millisecond that completes it does.
    vi.advanceTimersByTime(RETRY_MS - 1);
    await realSleep(100);
    expect(isSettled(waiter)).toBe(false);
    vi.advanceTimersByTime(1);
    await soon(waiter, 'the retry to take the lock');
    expect(connects.sockets).toHaveLength(1);
  });

  it('keeps its retry delay long enough that a taken but unreachable name cannot spin', () => {
    expect(RETRY_MS).toBeGreaterThanOrEqual(100);
  });

  it('says so once, as an unknown holder, when the name is taken but nothing answers', async () => {
    const connects = spyOnConnect();
    const pipe = uniquePipe();
    // Every listen finds the name taken, and every connect finds nothing: a
    // broken name, not a handover. The first refusal is the blip a handover
    // makes and prints nothing; the third says something is wrong.
    vi.spyOn(net.Server.prototype, 'listen').mockImplementation(function () {
      process.nextTick(() =>
        this.emit('error', codeError('in use', 'EADDRINUSE')),
      );
      return this;
    });
    const wait = recorder();
    acquire(pipe, 'wt-A', wait.onWait);

    for (let refusal = 1; refusal <= REFUSALS_BEFORE_ANNOUNCING; refusal += 1) {
      await connects.made.reach(refusal);
      await closed(connects.sockets[refusal - 1]);
      if (refusal < REFUSALS_BEFORE_ANNOUNCING) {
        expect(wait.calls).toEqual([]);
        vi.advanceTimersByTime(RETRY_MS);
      }
    }

    await wait.reach(1);
    expect(wait.calls[0].holder).toBeNull();
    expect(wait.calls[0].line).toBe(
      'review-gate: waiting for the gate held by an unknown holder',
    );

    // Said once: the next refusal adds no line.
    vi.advanceTimersByTime(RETRY_MS);
    await connects.made.reach(REFUSALS_BEFORE_ANNOUNCING + 1);
    await closed(connects.sockets[REFUSALS_BEFORE_ANNOUNCING]);
    expect(wait.calls).toHaveLength(1);
  });

  it('reports a listen error that is not EADDRINUSE by code, and retries it', async () => {
    const warned = counter('a warning');
    const warn = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => warned.hit());
    vi.spyOn(net.Server.prototype, 'listen').mockImplementationOnce(
      function () {
        process.nextTick(() =>
          this.emit('error', codeError('listen EACCES', 'EACCES')),
        );
        return this;
      },
    );
    const pipe = uniquePipe();
    const wait = recorder();

    const waiter = acquire(pipe, 'wt-A', wait.onWait);
    await warned.reach(1);
    await turn();

    // Not free: the error is not a verdict on the name, and nothing is held.
    expect(isSettled(waiter)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('EACCES');
    expect(warn.mock.calls[0][0]).toContain(pipe.replaceAll('\0', '@'));
    // The warning says it. A "waiting for the gate" line would name a holder
    // that is not there.
    expect(wait.calls).toEqual([]);

    // The next tick tries again, and this time the name is free.
    vi.advanceTimersByTime(FALLBACK_MS);
    await soon(waiter, 'the retry to take the lock');
    expect(wait.calls).toEqual([]);
  });

  it('reports a connect error that is not a missing holder by code, and retries it', async () => {
    const warned = counter('a warning');
    const warn = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => warned.hit());
    const pipe = uniquePipe();
    const squatter = await fakeHolder(pipe);
    vi.spyOn(net, 'connect').mockImplementationOnce(() => {
      const socket = new net.Socket();
      process.nextTick(() =>
        socket.destroy(codeError('connect EACCES', 'EACCES')),
      );
      return socket;
    });
    const wait = recorder();

    const waiter = acquire(pipe, 'wt-B', wait.onWait);
    await warned.reach(1);
    await turn();

    expect(isSettled(waiter)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('EACCES');
    expect(warn.mock.calls[0][0]).toContain(pipe.replaceAll('\0', '@'));
    expect(squatter.connections.count).toBe(0);
    // The warning says it; no holder has been seen to wait for.
    expect(wait.calls).toEqual([]);

    // The tick after it finds the name taken and connects for real.
    vi.advanceTimersByTime(FALLBACK_MS);
    await squatter.connections.reach(1);
    expect(isSettled(waiter)).toBe(false);
  });

  it('gives up after two hours, naming the holder and telling the reader to report', async () => {
    const pipe = uniquePipe();
    const connects = spyOnConnect();
    await acquire(pipe, 'wt-A');
    const wait = recorder();
    const waiter = acquire(pipe, 'wt-B', wait.onWait);
    await wait.reach(1);

    vi.advanceTimersByTime(WAIT_CAP_MS);
    const error = await soon(
      waiter.catch((caught) => caught),
      'the wait cap to reject',
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('wt-A');
    expect(error.message).toContain(`pid ${process.pid}`);
    expect(error.message).toContain(`running ${WAIT_CAP_MS / MINUTE} min`);
    expect(error.message).toContain(`${HOLD_CAP_MS / MINUTE} min`);
    expect(error.message).toContain('report to the owner');
    expect(error.message).toContain("another session's process");
    // It stopped: no timer left, and the connection to the holder is closed.
    expect(vi.getTimerCount()).toBe(0);
    expect(connects.sockets[0].destroyed).toBe(true);
  });

  it('never says a holder has been running for a negative time', async () => {
    const pipe = uniquePipe();
    const ahead = JSON.stringify({
      pid: 7,
      worktree: 'w',
      startedAt: T0 + 5 * MINUTE,
    });
    await fakeHolder(pipe, (socket) => socket.write(`${ahead}\n`));
    const wait = recorder();
    acquire(pipe, 'wt-B', wait.onWait);

    await wait.reach(1);

    expect(wait.calls[0].runningMin).toBe(0);
    expect(wait.calls[0].line).toBe(
      'review-gate: waiting for the gate in w (pid 7, running 0 min)',
    );
  });

  it('names an unknown holder when it gives up on one', async () => {
    const pipe = uniquePipe();
    await fakeHolder(pipe, (socket) => socket.write('hello\n'));
    const wait = recorder();
    const waiter = acquire(pipe, 'wt-B', wait.onWait);
    await wait.reach(1);

    vi.advanceTimersByTime(WAIT_CAP_MS);
    const error = await soon(
      waiter.catch((caught) => caught),
      'the wait cap to reject',
    );

    expect(error.message).toContain('unknown holder');
    expect(error.message).toContain('report to the owner');
  });

  it('closes a lock it wins after it gave up', async () => {
    const servers = spyOnServers();
    const pipe = uniquePipe();
    // Hold the first listen back, so the cap fires while it is in flight.
    const realListen = net.Server.prototype.listen;
    let startListen = () => {};
    vi.spyOn(net.Server.prototype, 'listen').mockImplementationOnce(function (
      ...args
    ) {
      startListen = () => realListen.apply(this, args);
      return this;
    });
    const waiter = acquire(pipe, 'wt-A');
    vi.advanceTimersByTime(WAIT_CAP_MS);
    await expect(waiter).rejects.toThrow(/report to the owner/);

    const server = servers()[0];
    startListen();
    await soon(once(server, 'listening'), 'the held-back listen to finish');

    // The listen succeeded after the caller was told "no": it must not keep
    // the name, or every later gate would queue behind a lock nobody has.
    expect(server.listening).toBe(false);
  });
});
