/**
 * The no-network guard for the Vitest suite (owner request, 2026-11-13; spec
 * docs/superpowers/specs/tests-no-db-2026-11-04.md, "Network").
 *
 * No test may open a connection to a host outside this machine. The one place
 * every client in Node ends is `net.Socket.prototype.connect`: the built-in
 * `fetch` (undici), `http`/`https.request`, `net.connect`, `tls.connect`,
 * `http2.connect`, the global `WebSocket` and jsdom's XMLHttpRequest all reach
 * it. A wrapper on `fetch` would not do: an SDK can capture `fetch` when it is
 * built, before a test replaces it. `setup.ts` installs this block once per
 * test file.
 *
 * Allowed: `localhost`, `127.0.0.0/8`, `::1`, `::ffff:127.*`, and IPC paths
 * (unix sockets, Windows pipes). `*.localhost` is not: Node looks it up through
 * the OS resolver, which on some systems sends a DNS query off the machine and
 * answers ENOTFOUND, and nothing here uses such a name. Everything else
 * is recorded in the no-database guard's attempts log as
 * `net.connect <host>:<port>` (host and port only, never a URL, query or
 * header, so a token cannot reach a CI log through it) and the socket is
 * destroyed with an error on the next tick. That is the shape of an offline
 * failure: `fetch` rejects with `TypeError: fetch failed` and this error as its
 * `cause`, and `http`/`net` clients get an `'error'` event. A synchronous throw
 * would escape `http.request` and `net.connect` as an exception that code
 * listening only for `'error'` does not expect. The attempt is recorded either
 * way, so the `afterEach` in `setup.ts` fails the test that made it even when
 * the code swallowed the error.
 *
 * Not covered: DNS and UDP (they never open a TCP socket through this
 * method), child processes and `worker_threads` (they do not load `setup.ts`),
 * native addons, a custom `lookup` (the check is on the name, before lookup),
 * what loopback reaches (a local Postgres, a dev server, or a proxy on
 * 127.0.0.1 that forwards off the machine), and a socket adopted from a
 * `net.BoundSocket`: Node takes its transport from the handle (`pipe =
 * this[kBoundSource] && this._handle ? this._handle instanceof Pipe : !!path`,
 * lib/net.js), so a truthy `path` on a TCP-bound one reads as IPC here and its
 * host goes unchecked. Nothing in the repo uses `BoundSocket`. See the spec's
 * "Network" section.
 * No env var, flag or per-file opt-out: a test that needs a server starts one
 * on 127.0.0.1, and a test of a client mocks it.
 */

import net from 'node:net';
import {
  NETWORK_ATTEMPT_PREFIX,
  NETWORK_BLOCK_MESSAGE,
  recordBlockedAttempt,
} from './db-guard';

/**
 * Set on the prototype once wrapped, so a second install (a fresh instance of
 * this module after `vi.resetModules()`) leaves the first wrapper alone
 * instead of stacking another on top.
 */
const INSTALLED = Symbol.for('strike-calculator.test-net-guard');

const IPV4_LOOPBACK = /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** True when `host` stays on this machine (see the allowlist above). */
export function isLoopback(host: string): boolean {
  const name = host
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '');
  if (name === 'localhost' || name === '::1') return true;
  if (name.startsWith('::ffff:')) return IPV4_LOOPBACK.test(name.slice(7));
  return IPV4_LOOPBACK.test(name);
}

type Target = { ipc: true } | { ipc: false; host: string; port: string };

/** An empty or missing host is `localhost`, as in Node. */
function hostOf(value: unknown): string {
  return typeof value === 'string' && value !== '' ? value : 'localhost';
}

/** The port as recorded; `?` when the call named none. */
function portOf(value: unknown): string {
  return value == null ? '?' : String(value);
}

/**
 * Node's own test: a string that is not a non-negative number is a pipe or
 * socket path, a numeric one is a port.
 */
function isPath(value: string): boolean {
  const n = Number(value);
  return Number.isNaN(n) || n < 0;
}

/**
 * Where a `Socket#connect` call is headed, from any of its overloads:
 * `connect(options[, cb])`, `connect(port[, host][, cb])`, `connect(path[, cb])`,
 * and the `[options, cb]` array that `net.connect` passes on after normalizing.
 */
function targetOf(args: readonly unknown[]): Target {
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (first !== null && typeof first === 'object') {
    const { path, host, port } = first as {
      path?: unknown;
      host?: unknown;
      port?: unknown;
    };
    // Truthy, as in Node (`const pipe = !!path`, lib/net.js): an empty or zero
    // path with a host and port is a TCP connect.
    if (path) return { ipc: true };
    return { ipc: false, host: hostOf(host), port: portOf(port) };
  }
  if (typeof first === 'string' && isPath(first)) return { ipc: true };
  return { ipc: false, host: hostOf(args[1]), port: portOf(first) };
}

type Connect = (this: net.Socket, ...args: unknown[]) => net.Socket;

/** Wrap `net.Socket.prototype.connect` once per process. */
export function installNetworkBlock(): void {
  const proto = net.Socket.prototype as net.Socket & {
    [INSTALLED]?: true;
  };
  if (proto[INSTALLED]) return;
  const original = proto.connect as unknown as Connect;

  const guarded: Connect = function connect(this: net.Socket, ...args) {
    const target = targetOf(args);
    if (target.ipc || isLoopback(target.host)) {
      return original.apply(this, args);
    }
    const kind = `${NETWORK_ATTEMPT_PREFIX}${target.host}:${target.port}`;
    recordBlockedAttempt(kind);
    const err = new Error(`${kind}: ${NETWORK_BLOCK_MESSAGE}`);
    process.nextTick(() => this.destroy(err));
    return this;
  };

  proto.connect = guarded as unknown as typeof proto.connect;
  Object.defineProperty(proto, INSTALLED, { value: true });
}
