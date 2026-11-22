/**
 * The machine-wide review-gate lock: one named pipe the OS holds, so only one
 * `npm run review` runs at a time across every worktree and session of this
 * repo on the workstation. Spec: docs/superpowers/specs/gate-lock-2026-11-21.md.
 *
 * Holding the lock means listening on the pipe. The OS frees the name the
 * moment the holding process exits, however it exits, so no stale lock file
 * or heartbeat exists to go wrong. A gate that finds the name taken connects
 * to the holder, reads one JSON line saying who it is, and waits for the
 * holder's socket to close.
 *
 * Node builtins only: .githooks/pre-commit loads scripts/review-gate.mjs in
 * worktrees that have no node_modules.
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/** How often a waiter reports that it is still waiting. */
export const PROGRESS_MS = 60_000;

/**
 * How often a waiter tries the name again whether or not it saw the holder
 * leave. Normally the holder's socket closing hands the lock over at once;
 * this is for a close event that never came.
 */
export const FALLBACK_MS = 15_000;

/**
 * How long a holder gets to send its identifying line, from the waiter's
 * connect. A holder that is slow (a loaded machine) is named when its line
 * does arrive; this only bounds the "waiting for the gate" line that would
 * otherwise never print.
 */
export const HANDSHAKE_MS = 2_000;

/**
 * The pause before a waiter tries again after a connect found nothing there,
 * or a holder hung up before it spoke. Without it a name that is taken but
 * unreachable (a holder mid-exit, something squatting on the name) would be
 * retried as fast as the CPU allows.
 */
export const RETRY_MS = 250;

/**
 * How many refused connects in a row make a waiter say it is waiting. One is
 * the blip a handover makes (the name is listed for a moment after its holder
 * went), two is still a blip; three in a row, about half a second at RETRY_MS,
 * is a name that is taken but answers nobody, and the waiter would otherwise
 * stay silent for the whole wait cap.
 */
export const REFUSALS_BEFORE_ANNOUNCING = 3;

/** A waiter gives up after this long: about four gates of queue. */
export const WAIT_CAP_MS = 120 * 60_000;

/**
 * How long a holder may run its chain before the runner kills it. Owned by
 * the runner (gate-runner.mjs); it lives here because the wait-cap message
 * tells the reader about it.
 */
export const HOLD_CAP_MS = 75 * 60_000;

/** A holder's line longer than this is not one of ours. */
const MAX_LINE_LENGTH = 4_096;

const MINUTE_MS = 60_000;

/**
 * @typedef {{ pid: number, worktree: string, startedAt: number }} GateHolder
 *   Who holds the lock: the runner's pid, the worktree it runs in, and when
 *   it took the lock (epoch ms).
 *
 * @typedef {{
 *   holder: GateHolder | null,
 *   runningMin: number | null,
 *   line: string,
 * }} GateWait
 *   What `onWait` gets. `holder` is null when the holder did not identify
 *   itself (no line, a cut-short one, or one that is not ours); `line` is the
 *   text to print.
 */

/**
 * The lock's name. `rawCommonDir` is what `git rev-parse --git-common-dir`
 * printed in `cwd`: `.git` in the main checkout, `../.git` in a subfolder of
 * it, an absolute path in a linked worktree. All three resolve to one real
 * directory, so every worktree of the repo gets the same name. Throws (ENOENT)
 * when that directory does not exist.
 *
 * A pipe path on Windows, a Linux abstract socket (the leading NUL): neither
 * leaves a file behind to go stale. Any other platform throws, so a gate there
 * fails at once and says why, not after two hours of listens that cannot work.
 *
 * @param {string} rawCommonDir
 * @param {string} cwd
 * @returns {string}
 */
export function gatePipeName(rawCommonDir, cwd) {
  const windows = process.platform === 'win32';
  if (!windows && process.platform !== 'linux') {
    throw new Error(
      `review-gate: the gate lock supports Windows and Linux, not ${process.platform}`,
    );
  }
  const real = realpathSync.native(path.resolve(cwd, rawCommonDir));
  // realpath already returns the on-disk case on Windows, which does not tell
  // `C:` from `c:`; lowercasing too keeps the name from depending on that.
  const key = windows ? real.toLowerCase() : real;
  // A name, not a secret: sha1 is only a short stable spelling of the path.
  // eslint-disable-next-line sonarjs/hashing
  const id = createHash('sha1').update(key).digest('hex').slice(0, 12);
  const name = `strike-calc-review-gate-${id}`;
  return windows ? `\\\\.\\pipe\\${name}` : `\0${name}`;
}

/** The pipe name as a log line can show it (the abstract form starts with NUL). */
function shown(pipeName) {
  return pipeName.replaceAll('\0', '@');
}

function codeOf(err) {
  return String(err?.code ?? err?.name ?? 'unknown error');
}

function warn(message) {
  console.warn(`review-gate: ${message}`);
}

/**
 * The holder's line, or null for anything else: not JSON, not an object, or
 * the wrong fields. The line comes from another process, so nothing in it is
 * trusted until it has the shape.
 *
 * @param {string} text
 * @returns {GateHolder | null}
 */
function parseHolder(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object') return null;
  const { pid, worktree, startedAt } = data;
  if (!Number.isInteger(pid)) return null;
  if (typeof worktree !== 'string') return null;
  if (!Number.isFinite(startedAt)) return null;
  return { pid, worktree, startedAt };
}

/** Whole minutes the holder has been running, never negative. */
function minutesRunning(holder) {
  return Math.max(0, Math.floor((Date.now() - holder.startedAt) / MINUTE_MS));
}

/** `in wt (pid 7, running 3 min)`, or `by an unknown holder`. */
function describeHolder(holder) {
  if (holder === null) return 'held by an unknown holder';
  return `in ${holder.worktree} (pid ${holder.pid}, running ${minutesRunning(holder)} min)`;
}

/** Whether `a` and `b` name the same holder. */
function sameHolder(a, b) {
  if (a === null || b === null) return a === b;
  return (
    a.pid === b.pid && a.worktree === b.worktree && a.startedAt === b.startedAt
  );
}

/**
 * Take the lock, waiting for it if another gate holds it.
 *
 * Resolves to `{ release }` once this process listens on the pipe. Rejects
 * after WAIT_CAP_MS of waiting. A waiter is always in one of three states, and
 * only one attempt runs at a time:
 *
 * - trying: `listen`. Success wins. EADDRINUSE sends it to connecting, or back
 *   to waiting when it already has a connection to the holder. Any other
 *   error is warned about by code and retried at the next fallback tick; it
 *   is never read as "the name is free".
 * - connecting: `connect`, then read the holder's line. A refused or missing
 *   pipe means the holder just left (try again after RETRY_MS). A holder that
 *   hangs up before it speaks is an unknown holder (same pause). Any other
 *   error is warned about and retried at the next fallback tick.
 * - waiting: the connection is open and the holder is named. Its socket
 *   closing sends the waiter straight to trying; the fallback tick sends it
 *   there too, and that never opens a second connection.
 *
 * The lock rules (R6):
 *
 * - No renew and no TTL. The OS ties the lock to this process: it is held for
 *   as long as the process lives and has not released, and a process that dies
 *   in any way frees it at once.
 * - It fails closed. It resolves only after a successful `listen`. Every other
 *   outcome (an error, a name that answers nobody, a holder that hangs up) is
 *   reported or waited out and retried, and the wait cap rejects. Nothing is
 *   ever read as "free" without a `listen` that said so.
 * - The wait cap (120 min) is longer than one hold cap (75 min), so a queue
 *   that is moving is not cut off by it.
 * - The caller must exit non-zero on a rejection and must never run its chain
 *   without the lock.
 *
 * @param {{
 *   pipeName: string,
 *   holder: { worktree: string },
 *   onWait: (wait: GateWait) => void,
 * }} options `onWait` is called when the holder is first known (or found to be
 *   unknown) and every PROGRESS_MS after, and again when a different gate takes
 *   over. `holder.worktree` is what this process tells its own waiters.
 * @returns {Promise<{ release: () => Promise<void> }>}
 */
export function acquireGateLock({ pipeName, holder, onWait }) {
  return new Promise((resolve, reject) => {
    /** 'idle' | 'trying' | 'connecting' */
    let phase = 'idle';
    let done = false;
    /** The open connection to the holder, if any. */
    let client = null;
    /** Whether `client` has delivered its line, or the wait for it ran out. */
    let handshaken = false;
    /** The holder as last read; null while unknown. */
    let known = null;
    /** Whether anything has been shown yet, for `announce`. */
    let announced = false;
    /**
     * The holder whose hang-up was last answered with an immediate retry
     * (undefined: none yet; null: an unknown holder).
     */
    let lastRetried;
    /**
     * Refused connects in a row. A listen or connect that fails some other way
     * starts the count again. (A connection that opens needs no reset: it
     * always announces, after which `announce` does nothing more.)
     */
    let refusals = 0;
    let fallbackTimer;
    let retryTimer;
    let progressTimer;
    let handshakeTimer;
    let capTimer;

    function teardown() {
      clearInterval(fallbackTimer);
      clearTimeout(retryTimer);
      clearInterval(progressTimer);
      clearTimeout(handshakeTimer);
      clearTimeout(capTimer);
      client?.destroy();
      client = null;
    }

    function printWait() {
      onWait({
        holder: known,
        runningMin: known === null ? null : minutesRunning(known),
        line: `review-gate: waiting for the gate ${describeHolder(known)}`,
      });
    }

    /** Show the holder now, and every PROGRESS_MS, when it is a new one. */
    function announce(next) {
      const changed = !announced || !sameHolder(known, next);
      known = next;
      announced = true;
      if (!changed) return;
      printWait();
      clearInterval(progressTimer);
      progressTimer = setInterval(printWait, PROGRESS_MS);
    }

    function retrySoon() {
      phase = 'idle';
      clearTimeout(retryTimer);
      retryTimer = setTimeout(tryListen, RETRY_MS);
    }

    function onCap() {
      done = true;
      const waited = WAIT_CAP_MS / MINUTE_MS;
      teardown();
      reject(
        new Error(
          `review-gate: gave up after waiting ${waited} min for the gate ` +
            `${describeHolder(known)}. The hold cap ends a hung holder at ` +
            `${HOLD_CAP_MS / MINUTE_MS} min, so a long wait is queue, not a hang. ` +
            `Do not stop another session's process; report to the owner.`,
        ),
      );
    }

    function tryListen() {
      if (done || phase !== 'idle') return;
      phase = 'trying';
      clearTimeout(retryTimer);
      const server = net.createServer();
      const onError = (err) => {
        if (done) return;
        if (err?.code === 'EADDRINUSE') {
          if (client !== null && handshaken) {
            phase = 'idle';
          } else {
            connectToHolder();
          }
          return;
        }
        // The warning says it. A "waiting for the gate" line here would name a
        // holder nobody has seen.
        warn(
          `cannot take the gate lock ${shown(pipeName)}: ${codeOf(err)}; ` +
            `trying again in ${FALLBACK_MS / 1000} s`,
        );
        phase = 'idle';
        refusals = 0;
      };
      server.once('error', onError);
      server.listen(pipeName, () => {
        server.removeListener('error', onError);
        if (done) {
          // The cap fired while this listen was in flight. The caller has
          // been told "no", so nobody would ever release this lock.
          server.close();
          return;
        }
        won(server);
      });
    }

    function connectToHolder() {
      phase = 'connecting';
      handshaken = false;
      let connected = false;
      let lineSeen = false;
      let text = '';
      const socket = net.connect(pipeName);
      client = socket;
      socket.setEncoding('utf8');

      const finish = (holderLine) => {
        if (done || socket !== client || handshaken) return;
        handshaken = true;
        phase = 'idle';
        clearTimeout(handshakeTimer);
        announce(holderLine);
      };
      handshakeTimer = setTimeout(() => finish(null), HANDSHAKE_MS);

      socket.once('connect', () => {
        connected = true;
      });
      socket.on('data', (chunk) => {
        if (lineSeen || done || socket !== client) return;
        text += chunk;
        const end = text.indexOf('\n');
        if (end === -1 && text.length <= MAX_LINE_LENGTH) return;
        lineSeen = true;
        const holderLine = end === -1 ? null : parseHolder(text.slice(0, end));
        if (!handshaken) {
          finish(holderLine);
        } else if (holderLine !== null) {
          // Late: the wait for the line ended and it was shown as unknown.
          announce(holderLine);
        }
      });

      const gone = (err) => {
        if (done || socket !== client) return;
        client = null;
        clearTimeout(handshakeTimer);
        if (handshaken) {
          // The holder released, or died: take its place if we can, at once.
          // A holder that is still there to connect to after it hung up (not
          // a real gate, which never comes back) is retried after a pause the
          // second time, or the two would loop with nothing between them.
          if (phase === 'idle') {
            const again =
              lastRetried !== undefined && sameHolder(lastRetried, known);
            lastRetried = known;
            if (again) retrySoon();
            else tryListen();
          }
          return;
        }
        if (!connected && err !== undefined) {
          const code = codeOf(err);
          if (code === 'ENOENT' || code === 'ECONNREFUSED') {
            refusals += 1;
            if (refusals >= REFUSALS_BEFORE_ANNOUNCING) announce(known);
            retrySoon();
            return;
          }
          warn(
            `cannot reach the gate lock ${shown(pipeName)}: ${code}; ` +
              `trying again in ${FALLBACK_MS / 1000} s`,
          );
          phase = 'idle';
          refusals = 0;
          return;
        }
        // Connected, then hung up before it said who it is.
        announce(null);
        retrySoon();
      };
      socket.on('error', gone);
      socket.on('close', () => gone(undefined));
    }

    function won(server) {
      done = true;
      teardown();
      resolve(hold(server, pipeName, holder));
    }

    fallbackTimer = setInterval(tryListen, FALLBACK_MS);
    capTimer = setTimeout(onCap, WAIT_CAP_MS);
    tryListen();
  });
}

/**
 * The holding side: tell every connection who holds the lock, and keep each
 * one open until release. A connection can fail at any moment (a waiter
 * killed between connect and read gives EPIPE or ECONNRESET), and an
 * unhandled 'error' on one would crash this process and free the lock under
 * the chain it is running. So the server and every socket get a handler that
 * logs the error and drops it.
 *
 * @param {import('node:net').Server} server
 * @param {string} pipeName
 * @param {{ worktree: string }} holder
 * @returns {{ release: () => Promise<void> }}
 */
function hold(server, pipeName, holder) {
  const line = `${JSON.stringify({
    pid: process.pid,
    worktree: holder.worktree,
    startedAt: Date.now(),
  })}\n`;
  const sockets = new Set();

  server.on('error', (err) => {
    warn(`gate lock ${shown(pipeName)}: server error ${codeOf(err)} ignored`);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', (err) => {
      warn(
        `gate lock ${shown(pipeName)}: a waiting gate's connection failed ` +
          `(${codeOf(err)}); ignored`,
      );
    });
    socket.write(line);
  });

  let released = null;
  return {
    release() {
      released ??= new Promise((resolve) => {
        // ERR_SERVER_NOT_RUNNING means it is already closed, which is the goal.
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
      return released;
    },
  };
}
