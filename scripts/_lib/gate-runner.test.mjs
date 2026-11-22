// @vitest-environment node

/**
 * Tests for the gate runner (gate-runner.mjs): it runs the review chain while
 * holding the machine-wide gate lock, passes the chain's exit code through,
 * kills the chain's whole process tree at the hold cap, and always releases
 * the lock. Spec: docs/superpowers/specs/gate-lock-2026-11-21.md, Design 1, 6
 * and 7.
 *
 * Two kinds of test. The ones with a real chain (a real shell running real
 * node children) show what the runner does on this machine: exit codes, the
 * environment, a spawn failure, the wait for the chain after a signal, and the
 * hold cap that kills a sleeping chain and its grandchild. The ones with a
 * fake chain (a stand-in for the spawned process, and process.platform set by
 * hand) show the platform branches that this machine cannot run for real: the
 * Linux process group and the Windows taskkill.
 *
 * The lock is the `{ release() }` handle the runner is given; here a stub that
 * counts releases.
 */

import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOLD_CAP_MS } from './gate-lock.mjs';
import { deepestCommand, runGate } from './gate-runner.mjs';
import { makeTempDir, setupScratchGit } from './scratch-git.fixtures.mjs';
import { CHILD_TEST_TIMEOUT } from './spawn-timeout.fixtures.mjs';

setupScratchGit();

/** A fake-chain test or a quick real one: a hang fails in seconds. */
const TEST_TIMEOUT = 30_000;

/** Real time one wait may take for something the test expects to happen. */
const WAIT_DEADLINE_MS = 15_000;

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));

/** `promise`, or a failure naming `what` after `ms` of real time. */
function soon(promise, what, ms = WAIT_DEADLINE_MS) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = realSetTimeout(
      () =>
        reject(new Error(`gave up after ${ms / 1000} s waiting for ${what}`)),
      ms,
    );
  });
  return Promise.race([promise, deadline]).finally(() =>
    realClearTimeout(timer),
  );
}

/** Poll `check` in real time until it is true. */
async function waitFor(check, what) {
  const started = performance.now();
  for (;;) {
    if (check()) return;
    if (performance.now() - started > WAIT_DEADLINE_MS) {
      throw new Error(
        `gave up after ${WAIT_DEADLINE_MS / 1000} s waiting for ${what}`,
      );
    }
    await realSleep(25);
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** The shell the real chains run under: Git Bash on Windows, as npm uses. */
function chainShell() {
  const fromNpm = process.env.npm_config_script_shell;
  if (fromNpm) return fromNpm;
  if (process.platform === 'win32') {
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    if (!existsSync(gitBash)) throw new Error(`no Git Bash at ${gitBash}`);
    return gitBash;
  }
  return '/bin/bash';
}

/** A path as a bash command line can take it. */
const forBash = (file) => file.replaceAll('\\', '/');

/** The lock handle the runner is given. */
function fakeLock() {
  return { release: vi.fn(() => Promise.resolve()) };
}

/** Set process.platform for the rest of the test; afterEach puts it back. */
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
function pretendPlatform(platform) {
  Object.defineProperty(process, 'platform', {
    ...realPlatform,
    value: platform,
  });
}

/** A stand-in for the spawned chain: the events and fields the runner uses. */
function fakeChain(pid = 4242) {
  const child = Object.assign(new EventEmitter(), { pid, kill: vi.fn() });
  const spawn = vi.spyOn(childProcess, 'spawn').mockImplementation(() => child);
  return { child, spawn };
}

/** Stand-ins for the OS tools the runner runs: the process list and taskkill. */
function fakeTools({
  list = '',
  listFails = false,
  taskkillExit = 0,
  taskkillStderr = '',
} = {}) {
  const taskkills = [];
  const listings = [];
  vi.spyOn(childProcess, 'execFile').mockImplementation(
    (file, args, _options, callback) => {
      const tool = path.win32.basename(path.posix.basename(file)).toLowerCase();
      if (tool === 'taskkill.exe') {
        taskkills.push({ file, args });
        const failure =
          taskkillExit === 0
            ? null
            : Object.assign(new Error('taskkill failed'), {
                code: taskkillExit,
              });
        callback(failure, '', taskkillStderr);
      } else {
        listings.push({ file, args });
        if (listFails) callback(new Error('process list unavailable'), '', '');
        else callback(null, list, '');
      }
      return new EventEmitter();
    },
  );
  return { taskkills, listings };
}

/** The listener a runGate call added for `signal`, whichever others exist. */
function ownListener(signal, before) {
  return process
    .listeners(signal)
    .find((listener) => !before.includes(listener));
}

const signalListeners = () => ({
  SIGINT: [...process.listeners('SIGINT')],
  SIGTERM: [...process.listeners('SIGTERM')],
});

function expectSignalListenersRestored(before) {
  expect(process.listeners('SIGINT')).toEqual(before.SIGINT);
  expect(process.listeners('SIGTERM')).toEqual(before.SIGTERM);
}

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform);
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const FAKE_TIMERS = {
  toFake: [
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'Date',
  ],
};

describe('runGate, with a fake chain', { timeout: TEST_TIMEOUT }, () => {
  it('maps a chain that died of a signal to 1', async () => {
    const { child } = fakeChain();
    const lock = fakeLock();

    const run = runGate({ stepsCmd: 'x', shell: '/bin/sh', lock });
    child.emit('exit', null, 'SIGKILL');

    expect(await run).toBe(1);
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['win32', false],
    ['linux', true],
  ])(
    'spawns the chain on %s with detached %s, the shell given, and the inherited stdio and environment',
    async (platform, detached) => {
      pretendPlatform(platform);
      const { child, spawn } = fakeChain();

      const run = runGate({
        stepsCmd: 'echo hi',
        shell: '/bin/sh',
        lock: fakeLock(),
      });
      child.emit('exit', 0, null);
      await run;

      // Exactly these options: no env (so process.env is inherited), and the
      // group leader only where the chain is killed as a group.
      expect(spawn).toHaveBeenCalledWith('echo hi', {
        shell: '/bin/sh',
        stdio: 'inherit',
        detached,
      });
    },
  );

  it('forwards SIGINT and SIGTERM to the chain process group on Linux, and releases only after the chain exits', async () => {
    pretendPlatform('linux');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const { child } = fakeChain(4242);
    const lock = fakeLock();
    const before = signalListeners();

    const run = runGate({ stepsCmd: 'x', shell: '/bin/sh', lock });
    for (const signal of ['SIGINT', 'SIGTERM']) {
      ownListener(signal, before[signal])(signal);
      expect(kill).toHaveBeenLastCalledWith(-4242, signal);
    }
    await realSleep(20);
    expect(lock.release).not.toHaveBeenCalled();

    child.emit('exit', 130, null);
    expect(await run).toBe(130);
    expect(lock.release).toHaveBeenCalledTimes(1);
    expectSignalListenersRestored(before);
  });

  it('forwards nothing on Windows, where Ctrl+C already reaches the chain, but still waits for it', async () => {
    pretendPlatform('win32');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const { child } = fakeChain();
    const lock = fakeLock();
    const before = signalListeners();

    const run = runGate({ stepsCmd: 'x', shell: '/bin/sh', lock });
    ownListener('SIGINT', before.SIGINT)('SIGINT');
    ownListener('SIGTERM', before.SIGTERM)('SIGTERM');
    await realSleep(20);

    expect(kill).not.toHaveBeenCalled();
    expect(lock.release).not.toHaveBeenCalled();
    child.emit('exit', 0, null);
    expect(await run).toBe(0);
    expectSignalListenersRestored(before);
  });

  it('is not hurt by a signal that arrives after the chain has gone', async () => {
    pretendPlatform('linux');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    });
    const { child } = fakeChain();
    const before = signalListeners();

    const run = runGate({ stepsCmd: 'x', shell: '/bin/sh', lock: fakeLock() });
    expect(() =>
      ownListener('SIGTERM', before.SIGTERM)('SIGTERM'),
    ).not.toThrow();
    expect(kill).toHaveBeenCalled();
    child.emit('exit', 0, null);
    expect(await run).toBe(0);
  });

  it('leaves no signal listener behind when the spawn fails', async () => {
    const child = new EventEmitter();
    vi.spyOn(childProcess, 'spawn').mockImplementation(() => child);
    const lock = fakeLock();
    const before = signalListeners();

    const run = runGate({ stepsCmd: 'x', shell: '/bin/sh', lock });
    child.emit(
      'error',
      Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
    );

    await expect(run).rejects.toThrow('spawn ENOENT');
    expect(lock.release).toHaveBeenCalledTimes(1);
    expectSignalListenersRestored(before);
  });

  it('kills the process group on Linux at the hold cap, and says what ran', async () => {
    pretendPlatform('linux');
    vi.useFakeTimers(FAKE_TIMERS);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const tools = fakeTools({
      list: [
        '    1     0 /sbin/init',
        ' 4242     1 bash -c node a.js && echo never',
        ' 4243  4242 node a.js',
        ' 4244  4243 node vitest-worker.js --marker-linux',
        ' 9999     1 unrelated',
      ].join('\n'),
    });
    const { child } = fakeChain(4242);
    const lock = fakeLock();

    const run = runGate({ stepsCmd: 'x', shell: '/bin/sh', lock });
    // One millisecond short of the cap, and a real tenth of a second for the
    // cap's own (asynchronous) work to show if it had started: nothing.
    vi.advanceTimersByTime(HOLD_CAP_MS - 1);
    await realSleep(100);
    expect(kill).not.toHaveBeenCalled();
    expect(tools.listings).toHaveLength(0);
    vi.advanceTimersByTime(1);
    await waitFor(() => kill.mock.calls.length > 0, 'the group kill');
    // A chain killed at the cap that still reports a clean exit is a 1.
    child.emit('exit', 0, null);

    expect(await run).toBe(1);
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
    expect(tools.listings).toHaveLength(1);
    expect(tools.listings[0].file).toBe('/bin/ps');
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(
        /75 min hold cap.*node vitest-worker\.js --marker-linux/s,
      ),
    );
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it('runs taskkill on the whole tree on Windows at the hold cap, and says what ran', async () => {
    pretendPlatform('win32');
    vi.useFakeTimers(FAKE_TIMERS);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tools = fakeTools({
      list: [
        '4\t0\tSystem',
        '4242\t1\tbash.exe -c "node a.js && echo never"',
        '4243\t4242\tnode.exe a.js',
        '4244\t4243\tnode.exe vitest-worker.js --marker-windows',
      ].join('\n'),
    });
    const { child, spawn } = fakeChain(4242);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const lock = fakeLock();

    const run = runGate({ stepsCmd: 'x', shell: 'C:\\bash.exe', lock });
    vi.advanceTimersByTime(HOLD_CAP_MS);
    await waitFor(() => tools.taskkills.length > 0, 'taskkill');
    child.emit('exit', 0, null);

    expect(await run).toBe(1);
    expect(spawn.mock.calls[0][1].detached).toBe(false);
    expect(tools.taskkills).toHaveLength(1);
    expect(path.win32.basename(tools.taskkills[0].file)).toBe('taskkill.exe');
    expect(tools.taskkills[0].args).toEqual(['/T', '/F', '/PID', '4242']);
    expect(path.win32.basename(tools.listings[0].file)).toBe('powershell.exe');
    expect(kill).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(
        /75 min hold cap.*vitest-worker\.js --marker-windows/s,
      ),
    );
  });

  it('still kills the chain, and says it does not know what ran, when the process list cannot be read', async () => {
    pretendPlatform('win32');
    vi.useFakeTimers(FAKE_TIMERS);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tools = fakeTools({ listFails: true });
    const { child } = fakeChain(4242);

    const run = runGate({
      stepsCmd: 'x',
      shell: 'C:\\bash.exe',
      lock: fakeLock(),
    });
    vi.advanceTimersByTime(HOLD_CAP_MS);
    await waitFor(() => tools.taskkills.length > 0, 'taskkill');
    child.emit('exit', 1, null);

    expect(await run).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/hold cap.*not known/s),
    );
  });

  it.each([
    [1, 'ERROR: Access is denied.', true],
    [128, 'ERROR: The process "4242" not found.', false],
  ])(
    'taskkill exiting %i is reported only when the chain may still be running',
    async (exitCode, stderr, reported) => {
      pretendPlatform('win32');
      vi.useFakeTimers(FAKE_TIMERS);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const tools = fakeTools({
        taskkillExit: exitCode,
        taskkillStderr: stderr,
      });
      const { child } = fakeChain(4242);

      const run = runGate({
        stepsCmd: 'x',
        shell: 'C:\\bash.exe',
        lock: fakeLock(),
      });
      vi.advanceTimersByTime(HOLD_CAP_MS);
      await waitFor(() => tools.taskkills.length > 0, 'taskkill');
      await realSleep(20);
      child.emit('exit', 1, null);
      await run;

      const said = error.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('taskkill could not stop'));
      if (reported) {
        expect(said).toHaveLength(1);
        expect(said[0]).toContain(`exit ${exitCode}`);
        expect(said[0]).toContain('Access is denied');
      } else {
        expect(said).toEqual([]);
      }
    },
  );

  it('falls back to killing the shell when taskkill itself cannot run', async () => {
    pretendPlatform('win32');
    vi.useFakeTimers(FAKE_TIMERS);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(childProcess, 'execFile').mockImplementation(
      (file, _args, _options, callback) => {
        if (path.win32.basename(file) === 'taskkill.exe') {
          callback(
            Object.assign(new Error('spawn taskkill ENOENT'), {
              code: 'ENOENT',
            }),
            '',
            '',
          );
        } else {
          callback(new Error('no list'), '', '');
        }
        return new EventEmitter();
      },
    );
    const { child } = fakeChain(4242);

    const run = runGate({
      stepsCmd: 'x',
      shell: 'C:\\bash.exe',
      lock: fakeLock(),
    });
    vi.advanceTimersByTime(HOLD_CAP_MS);
    await waitFor(() => child.kill.mock.calls.length > 0, 'the fallback kill');
    child.emit('exit', 1, null);

    expect(await run).toBe(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('gives up on a chain that will not die, releases, and still resolves 1', async () => {
    pretendPlatform('linux');
    vi.useFakeTimers(FAKE_TIMERS);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    fakeTools({ list: '' });
    fakeChain(4242);
    const lock = fakeLock();

    const run = runGate({ stepsCmd: 'x', shell: '/bin/sh', lock });
    vi.advanceTimersByTime(HOLD_CAP_MS);
    await waitFor(() => kill.mock.calls.length > 0, 'the group kill');
    // The chain never reports an exit.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await soon(run, 'the runner to give up waiting')).toBe(1);
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it('does not touch the chain when it ends before the hold cap', async () => {
    pretendPlatform('linux');
    vi.useFakeTimers(FAKE_TIMERS);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const tools = fakeTools();
    const { child } = fakeChain();

    const run = runGate({ stepsCmd: 'x', shell: '/bin/sh', lock: fakeLock() });
    child.emit('exit', 0, null);
    expect(await run).toBe(0);
    vi.advanceTimersByTime(2 * HOLD_CAP_MS);

    expect(kill).not.toHaveBeenCalled();
    expect(tools.listings).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('exits with the chain code, not 1, when the chain ends just as the cap fires', async () => {
    pretendPlatform('linux');
    vi.useFakeTimers(FAKE_TIMERS);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    fakeTools();
    const { child } = fakeChain();

    const run = runGate({ stepsCmd: 'x', shell: '/bin/sh', lock: fakeLock() });
    vi.advanceTimersByTime(HOLD_CAP_MS);
    // The cap has fired and is looking at the process list; the chain finishes.
    child.emit('exit', 0, null);

    expect(await run).toBe(0);
    // The cap then finds the chain gone and does nothing: no kill (the pid may
    // be somebody else's by now) and no line saying the chain was killed.
    await realSleep(100);
    expect(kill).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe('runGate, with a real chain', { timeout: CHILD_TEST_TIMEOUT }, () => {
  it.each([
    [0, 'exit 0'],
    [3, 'exit 3'],
    [127, 'exit 127'],
  ])(
    'passes exit code %i through, and releases the lock',
    async (code, stepsCmd) => {
      const lock = fakeLock();

      const result = await runGate({ stepsCmd, shell: chainShell(), lock });

      expect(result).toBe(code);
      expect(lock.release).toHaveBeenCalledTimes(1);
    },
  );

  it('runs the chain with the environment it was started with', async () => {
    vi.stubEnv('GATE_RUNNER_PROBE', 'yes');
    const lock = fakeLock();

    const result = await runGate({
      stepsCmd: 'test "$GATE_RUNNER_PROBE" = yes',
      shell: chainShell(),
      lock,
    });

    expect(result).toBe(0);
  });

  it('rejects when the shell cannot be started, and still releases the lock', async () => {
    const lock = fakeLock();
    const before = signalListeners();
    const missing = path.join(makeTempDir('gate-runner-'), 'no-such-shell');

    await expect(
      runGate({ stepsCmd: 'exit 0', shell: missing, lock }),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    expect(lock.release).toHaveBeenCalledTimes(1);
    expectSignalListenersRestored(before);
  });

  it('reports a release that fails, and still returns the chain exit code', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lock = {
      release: vi.fn(() => Promise.reject(new Error('pipe gone'))),
    };

    const result = await runGate({
      stepsCmd: 'exit 3',
      shell: chainShell(),
      lock,
    });

    expect(result).toBe(3);
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/could not release the gate lock.*pipe gone/s),
    );
  });

  it('waits for the chain to exit after a SIGINT, and releases only then', async () => {
    const dir = makeTempDir('gate-runner-');
    const started = path.join(dir, 'started');
    const trigger = path.join(dir, 'trigger');
    const waiter = path.join(dir, 'waiter.cjs');
    // Exits 5 when the trigger file appears, or at once on a forwarded SIGINT
    // (Linux forwards it to the group; Windows leaves Ctrl+C to the console).
    writeFileSync(
      waiter,
      [
        "const fs = require('node:fs');",
        'fs.writeFileSync(process.env.GATE_RUNNER_STARTED, String(process.pid));',
        "process.on('SIGINT', () => process.exit(5));",
        'setInterval(() => {',
        '  if (fs.existsSync(process.env.GATE_RUNNER_TRIGGER)) process.exit(5);',
        '}, 50);',
      ].join('\n'),
    );
    vi.stubEnv('GATE_RUNNER_STARTED', started);
    vi.stubEnv('GATE_RUNNER_TRIGGER', trigger);
    let aliveAtRelease;
    let chainPid;
    const lock = {
      release: vi.fn(() => {
        aliveAtRelease = isAlive(chainPid);
        return Promise.resolve();
      }),
    };
    const before = signalListeners();

    let settled = false;
    const run = runGate({
      stepsCmd: `node "${forBash(waiter)}" && echo never`,
      shell: chainShell(),
      lock,
    }).finally(() => {
      settled = true;
    });
    await waitFor(
      () => existsSync(started) && readFileSync(started, 'utf8') !== '',
      'the chain to start',
    );
    chainPid = Number(readFileSync(started, 'utf8'));

    ownListener('SIGINT', before.SIGINT)('SIGINT');
    await realSleep(300);
    if (process.platform === 'win32') {
      // Nothing is forwarded on Windows, so the chain is still running, and
      // the runner is still waiting for it.
      expect(settled).toBe(false);
      expect(lock.release).not.toHaveBeenCalled();
      writeFileSync(trigger, 'go');
    }

    expect(await soon(run, 'the chain to exit')).toBe(5);
    expect(aliveAtRelease).toBe(false);
    expect(lock.release).toHaveBeenCalledTimes(1);
    expectSignalListenersRestored(before);
  });

  it('kills the whole chain at the hold cap, grandchild included, and names what was running', async () => {
    const dir = makeTempDir('gate-runner-');
    const pids = path.join(dir, 'pids.json');
    const outer = path.join(dir, 'outer.cjs');
    // The shell runs this node, and this node starts another node: the tree
    // the hold cap has to reach.
    writeFileSync(
      outer,
      [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        "const inner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000) // gate-runner-inner-marker'], { stdio: 'ignore' });",
        'fs.writeFileSync(process.env.GATE_RUNNER_PIDS, JSON.stringify({ outer: process.pid, inner: inner.pid }));',
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );
    vi.stubEnv('GATE_RUNNER_PIDS', pids);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lock = fakeLock();
    const before = signalListeners();
    vi.useFakeTimers(FAKE_TIMERS);

    const run = runGate({
      stepsCmd: `node "${forBash(outer)}" && echo never`,
      shell: chainShell(),
      lock,
    });
    let tree;
    await waitFor(() => {
      try {
        tree = JSON.parse(readFileSync(pids, 'utf8'));
        return true;
      } catch {
        return false;
      }
    }, 'the chain to start its grandchild');
    expect(isAlive(tree.outer)).toBe(true);
    expect(isAlive(tree.inner)).toBe(true);

    vi.advanceTimersByTime(HOLD_CAP_MS);
    const result = await soon(run, 'the hold cap to end the chain', 30_000);

    expect(result).toBe(1);
    await waitFor(
      () => !isAlive(tree.outer) && !isAlive(tree.inner),
      'the chain and its grandchild to die',
    );
    expect(lock.release).toHaveBeenCalledTimes(1);
    expectSignalListenersRestored(before);
    const lines = error.mock.calls.map((call) => String(call[0]));
    const capLine = lines.find((line) => line.includes('hold cap'));
    expect(capLine).toContain(`${HOLD_CAP_MS / 60_000} min`);
    expect(capLine).toContain('gate-runner-inner-marker');
  });
});

describe('deepestCommand', () => {
  const processes = [
    { pid: 10, ppid: 1, cmd: 'bash -c chain' },
    { pid: 11, ppid: 10, cmd: 'bash (fork stub)' },
    { pid: 12, ppid: 11, cmd: 'node outer.js' },
    { pid: 13, ppid: 12, cmd: 'node   inner.js\t--flag' },
    { pid: 14, ppid: 10, cmd: 'echo shallow' },
    { pid: 99, ppid: 1, cmd: 'unrelated' },
  ];

  it('names the deepest process under the root, with whitespace collapsed', () => {
    expect(deepestCommand(10, processes)).toBe('node inner.js --flag');
  });

  it('prefers the newest process when two are equally deep', () => {
    expect(
      deepestCommand(10, [
        { pid: 11, ppid: 10, cmd: 'first' },
        { pid: 12, ppid: 10, cmd: 'second' },
      ]),
    ).toBe('second');
  });

  it('is null for a root with no children, or with no command line to show', () => {
    expect(deepestCommand(99, processes)).toBeNull();
    expect(deepestCommand(10, [{ pid: 11, ppid: 10, cmd: '  ' }])).toBeNull();
    expect(deepestCommand(10, [])).toBeNull();
  });

  it('cuts a very long command line', () => {
    const [leaf] = [{ pid: 11, ppid: 10, cmd: 'x'.repeat(1000) }];
    expect(deepestCommand(10, [leaf])).toHaveLength(200);
  });

  it('visits each process once, so a process list that points back at itself ends', () => {
    // Windows can reuse a pid, so a list can hold a cycle. Each entry here
    // throws if its command is read twice, so a walk that goes round the cycle
    // fails at once instead of running for ever.
    const readOnce = (pid, ppid, cmd) => {
      let reads = 0;
      return {
        pid,
        ppid,
        get cmd() {
          reads += 1;
          if (reads > 1) throw new Error(`process ${pid} was visited twice`);
          return cmd;
        },
      };
    };

    expect(
      deepestCommand(10, [readOnce(11, 10, 'a'), readOnce(10, 11, 'b')]),
    ).toBe('a');
  });
});
