/**
 * The gate runner: runs the review chain (the `review:steps` script) while
 * holding the machine-wide gate lock from gate-lock.mjs, and gives the lock
 * back however the chain ends. Spec: docs/superpowers/specs/gate-lock-2026-11-21.md,
 * Design 1, 6 and 7.
 *
 * Node builtins only (and gate-lock.mjs, which has none either):
 * .githooks/pre-commit loads scripts/review-gate.mjs in worktrees that have no
 * node_modules.
 */
import childProcess from 'node:child_process';
import path from 'node:path';
import { HOLD_CAP_MS } from './gate-lock.mjs';

const MINUTE_MS = 60_000;

/**
 * How long the runner waits, from the moment it decides to kill the chain, for
 * the chain to report that it is gone. The kill itself counts: a taskkill that
 * never returns must not keep the runner, and so the lock, for ever. Past it
 * the runner stops waiting and carries on (the lock frees when the runner
 * exits, however the chain is doing). It is also the limit given to taskkill.
 */
export const KILL_WAIT_MS = 10_000;

/** How long reading the process list may take. It only feeds one log line. */
const LIST_TIMEOUT_MS = 10_000;

/** A process list is a few hundred lines; this is far above any real one. */
const MAX_LIST_BYTES = 16 * 1024 * 1024;

/** The longest command line the hold-cap message quotes. */
const MAX_COMMAND_LENGTH = 200;

/** A path under Windows' System32, from the system root and not from PATH. */
function systemPath(...parts) {
  return path.win32.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    ...parts,
  );
}

/**
 * The command line of the deepest process under `rootPid` in `processes`
 * (`{ pid, ppid, cmd }` each): what the chain was doing when it was stopped.
 * The deepest one, because the chain's own shell and the shells and wrappers
 * between it and the tool (npm, a bash fork) say nothing; among equally deep
 * ones the newest (highest pid). Whitespace is collapsed and the text cut to
 * MAX_COMMAND_LENGTH. Null when the root has no descendant with a command line.
 *
 * @param {number} rootPid
 * @param {Array<{ pid: number, ppid: number, cmd: string }>} processes
 * @returns {string | null}
 */
export function deepestCommand(rootPid, processes) {
  const childrenOf = new Map();
  for (const proc of processes) {
    const siblings = childrenOf.get(proc.ppid) ?? [];
    siblings.push(proc);
    childrenOf.set(proc.ppid, siblings);
  }
  const seen = new Set([rootPid]);
  const queue = [{ pid: rootPid, depth: 0 }];
  let best = null;
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of childrenOf.get(next.pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      const depth = next.depth + 1;
      queue.push({ pid: child.pid, depth });
      const cmd = child.cmd.replaceAll(/\s+/g, ' ').trim();
      if (cmd === '') continue;
      if (
        best === null ||
        depth > best.depth ||
        (depth === best.depth && child.pid > best.pid)
      ) {
        best = { depth, pid: child.pid, cmd };
      }
    }
  }
  return best === null ? null : best.cmd.slice(0, MAX_COMMAND_LENGTH);
}

/** The OS's process list as `{ pid, ppid, cmd }` entries. */
function listProcesses() {
  const windows = process.platform === 'win32';
  // The system's own tools, by absolute path: nothing here comes from PATH.
  const [file, args, line] = windows
    ? [
        systemPath('WindowsPowerShell', 'v1.0', 'powershell.exe'),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | ForEach-Object { ($_.ProcessId, $_.ParentProcessId, $_.CommandLine) -join [char]9 }',
        ],
        /^(\d+)\t(\d+)\t(.*)$/,
      ]
    : [
        '/bin/ps',
        ['-e', '-o', 'pid=,ppid=,args='],
        // ps pads with runs of spaces; the command line starts at a non-space.
        /^\s*(\d+)\s+(\d+)\s+(\S.*)$/,
      ];
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      file,
      args,
      {
        encoding: 'utf8',
        timeout: LIST_TIMEOUT_MS,
        maxBuffer: MAX_LIST_BYTES,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const processes = [];
        for (const text of String(stdout).split('\n')) {
          const match = line.exec(text.replace(/\r$/, ''));
          if (match) {
            processes.push({
              pid: Number(match[1]),
              ppid: Number(match[2]),
              cmd: match[3],
            });
          }
        }
        resolve(processes);
      },
    );
  });
}

/**
 * What the chain was running: `{ listed, command }`. `listed` is false when the
 * process list could not be read at all; `command` is null when it was read but
 * held nothing under the chain.
 */
async function runningStage(pid) {
  try {
    return {
      listed: true,
      command: deepestCommand(pid, await listProcesses()),
    };
  } catch {
    return { listed: false, command: null };
  }
}

/**
 * Kill the chain and everything under it: the whole tree, not just its shell.
 * Windows has no process groups to signal, so `taskkill /T /F` walks the tree
 * by parent pid. Elsewhere the chain was started as a group leader
 * (`detached`) and the whole group gets SIGKILL.
 */
function killTree(child, windows) {
  return new Promise((resolve) => {
    if (!windows) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      resolve();
      return;
    }
    childProcess.execFile(
      systemPath('taskkill.exe'),
      ['/T', '/F', '/PID', String(child.pid)],
      { windowsHide: true, timeout: KILL_WAIT_MS },
      (error, _stdout, stderr) => {
        if (error?.code === 'ENOENT') {
          // No taskkill to run: the shell at least can be stopped.
          child.kill('SIGKILL');
        } else if (error?.killed) {
          console.error(
            `review-gate: taskkill did not finish in ${KILL_WAIT_MS / 1000} s; the chain may still be running`,
          );
        } else if (error && error.code !== 128) {
          // 128 is "no such process": the chain is already gone, which is fine.
          console.error(
            `review-gate: taskkill could not stop the chain (exit ${error.code}): ${String(stderr).trim()}`,
          );
        }
        resolve();
      },
    );
  });
}

/** Give the lock back. A failure is reported, not thrown: the chain's exit code matters more. */
async function releaseLock(lock) {
  try {
    await lock.release();
  } catch (error) {
    console.error(
      `review-gate: could not release the gate lock: ${error?.message ?? error}`,
    );
  }
}

/**
 * Spawn the chain and resolve with its exit code. The hold cap (HOLD_CAP_MS)
 * stops a hung chain: the runner names what was running, kills the whole tree
 * and resolves 1. Rejects when the chain cannot be spawned.
 */
function runChain({ stepsCmd, shell, windows, onSpawn }) {
  return new Promise((resolve, reject) => {
    // The command is this repo's own `review:steps` script, run through the
    // shell npm itself would use, exactly as `npm run` runs it. On Linux the
    // chain leads a process group of its own, so the whole group can be
    // signalled.
    const child = childProcess.spawn(stepsCmd, {
      shell,
      stdio: 'inherit',
      detached: process.platform === 'linux',
    });
    onSpawn(child);
    let exited = false;
    let capped = false;
    let giveUpTimer;
    let capTimer;

    const finish = (code) => {
      clearTimeout(capTimer);
      clearTimeout(giveUpTimer);
      resolve(code);
    };

    const onCap = async () => {
      const stage = await runningStage(child.pid);
      // The chain may have finished while the process list was being read.
      if (exited) return;
      capped = true;
      // Armed before the kill, not after it: a kill that never returns must
      // not keep the runner waiting.
      giveUpTimer = setTimeout(() => finish(1), KILL_WAIT_MS);
      let running = 'not known';
      if (stage.command !== null) running = stage.command;
      else if (!stage.listed) {
        running = 'not known (the process list could not be read)';
      }
      console.error(
        `review-gate: the chain hit the ${HOLD_CAP_MS / MINUTE_MS} min hold cap and is being killed. ` +
          `Running at that moment: ${running}.`,
      );
      await killTree(child, windows);
    };

    capTimer = setTimeout(() => {
      void onCap();
    }, HOLD_CAP_MS);
    child.on('error', (error) => {
      if (child.pid !== undefined) {
        // Raised after the chain started (a kill or a signal that failed): the
        // chain is still running, so the runner keeps waiting for its exit.
        console.error(
          `review-gate: error from the chain process: ${error?.message ?? error}`,
        );
        return;
      }
      // No pid: the chain never started.
      exited = true;
      clearTimeout(capTimer);
      clearTimeout(giveUpTimer);
      reject(error);
    });
    child.once('exit', (code) => {
      exited = true;
      // A death by signal has no code. After the cap the answer is 1 whatever
      // the killed chain reports.
      finish(capped ? 1 : (code ?? 1));
    });
  });
}

/**
 * Run the review chain `stepsCmd` under `shell` while holding the gate lock,
 * and resolve with the chain's exit code (1 when it died of a signal, or was
 * killed at the hold cap). The chain inherits stdio and the environment, so
 * `npm_lifecycle_event` stays `review` and `seal` keeps working.
 *
 * `lock` is the `{ release }` handle `acquireGateLock` (gate-lock.mjs)
 * resolved to. The lock rules from there hold here, restated (R6): there is no
 * renew or TTL, because the OS ties the lock to the process, so a runner that
 * dies in any way frees it. The runner is called only with the lock already
 * held, and releases it in a `finally`: on pass, on fail, on a spawn failure
 * (which rejects) and at the hold cap. The hold cap (75 min) is what keeps a
 * hung chain from holding every other session's gate for ever. The worst case
 * of one hold is the cap plus about 20 s: up to 10 s to read the process list
 * for the cap message, then the kill and the wait for the chain's exit, which
 * share one 10 s limit (KILL_WAIT_MS). That is still well under the wait cap
 * (120 min) a queued gate gives up at. A chain that outlives the runner (a
 * hard kill of the runner) is not stopped: that is the known gap in the spec.
 *
 * While the chain runs, SIGINT and SIGTERM do not end the runner. On Linux the
 * chain is a process group of its own, so the signal is forwarded to the group;
 * on Windows Ctrl+C already reaches the chain through the console. Either way
 * the runner waits for the chain to exit, then releases. The listeners are
 * removed when the run ends.
 *
 * @param {{
 *   stepsCmd: string,
 *   shell: string | true,
 *   lock: { release: () => Promise<void> },
 * }} options
 * @returns {Promise<number>}
 */
export async function runGate({ stepsCmd, shell, lock }) {
  const windows = process.platform === 'win32';
  let chain = null;
  const forwarders = ['SIGINT', 'SIGTERM'].map((signal) => {
    const listener = () => {
      if (windows || chain?.pid === undefined) return;
      try {
        process.kill(-chain.pid, signal);
      } catch {
        // The group is already gone: the chain is exiting, which is the aim.
      }
    };
    process.on(signal, listener);
    return { signal, listener };
  });
  try {
    return await runChain({
      stepsCmd,
      shell,
      windows,
      onSpawn: (child) => {
        chain = child;
      },
    });
  } finally {
    for (const { signal, listener } of forwarders) {
      process.removeListener(signal, listener);
    }
    await releaseLock(lock);
  }
}
