// @vitest-environment node

/**
 * Self-tests for the network block (src/__tests__/net-guard.ts, installed in
 * src/__tests__/setup.ts): a test may open no connection to a host outside
 * this machine. It records into the no-database guard's attempts log, so the
 * `afterEach` and `afterAll` checks in setup.ts also catch an attempt that
 * the caller swallowed. Each test that provokes one discards its own entries
 * with `trackDbAttempts`, because that `afterEach` fails any test that leaves
 * one behind.
 *
 * Every target is a `.invalid` host (RFC 6761: it never resolves), so nothing
 * leaves the machine even when the block is broken. That is what keeps the
 * mutation check safe: with the install removed these tests fail on their
 * assertions, with a DNS error in place of the block's message.
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as guard from '../../src/__tests__/db-guard.js';
import {
  installNetworkBlock,
  isLoopback,
} from '../../src/__tests__/net-guard.js';

const { BLOCK_MESSAGE, NETWORK_BLOCK_MESSAGE, trackDbAttempts } = guard;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Resolves with the 'error' a client request or socket emits. */
function errorOf(emitter: http.ClientRequest | net.Socket): Promise<Error> {
  return new Promise((resolve) => emitter.once('error', resolve));
}

/** The error message, and the message of its cause when it has one. */
function messagesOf(err: unknown): string {
  const cause = (err as { cause?: unknown }).cause;
  return [err, cause]
    .filter((e): e is Error => e instanceof Error)
    .map((e) => e.message)
    .join(' | ');
}

/** A server on 127.0.0.1 that answers every request with 'ok'. */
async function listenOnLoopback(): Promise<{
  port: number;
  server: http.Server;
}> {
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as net.AddressInfo).port, server };
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('isLoopback', () => {
  it.each([
    'localhost',
    'LOCALHOST',
    'localhost.',
    'api.localhost',
    '127.0.0.1',
    '127.1.2.3',
    '127.255.255.255',
    '::1',
    '[::1]',
    '::ffff:127.0.0.1',
  ])('allows %s', (host) => {
    expect(isLoopback(host)).toBe(true);
  });

  it.each([
    '',
    'example.com',
    'api.unusualwhales.com',
    'localhost.example.com',
    'notlocalhost',
    '127.0.0.1.example.com',
    '127.0.0.256',
    '1127.0.0.1',
    '128.0.0.1',
    '10.0.0.1',
    '0.0.0.0',
    '::',
    '::2',
    '::ffff:10.0.0.1',
  ])('blocks %s', (host) => {
    expect(isLoopback(host)).toBe(false);
  });
});

describe('a connection to a host outside this machine', () => {
  it('fails a fetch the way an offline one fails, and records host and port only', async () => {
    const attempts = trackDbAttempts();
    const err = await fetch('https://fetch.invalid/path?token=hunter2').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TypeError);
    expect((err as TypeError).message).toBe('fetch failed');
    expect(messagesOf(err)).toContain(NETWORK_BLOCK_MESSAGE);
    expect(attempts.made).toEqual(['net.connect fetch.invalid:443']);
    // A URL, a query or a token must never reach a CI log through this.
    expect(messagesOf(err)).not.toContain('hunter2');
    expect(attempts.made.join()).not.toContain('hunter2');
    attempts.discard();
  });

  it.each([
    ['http.request', http.request, 'http://http.invalid/', 'http.invalid:80'],
    [
      'https.request',
      https.request,
      'https://https.invalid/',
      'https.invalid:443',
    ],
    [
      'http.request on a custom port',
      http.request,
      'http://port.invalid:8081/',
      'port.invalid:8081',
    ],
  ] as const)(
    'fails %s with an error event, not a throw, and records it',
    async (_name, request, url, target) => {
      const attempts = trackDbAttempts();
      const req = request(url, () => {
        throw new Error('the request got a response');
      });
      const failed = errorOf(req);
      req.end();
      expect((await failed).message).toContain(NETWORK_BLOCK_MESSAGE);
      expect(attempts.made).toEqual([`net.connect ${target}`]);
      attempts.discard();
    },
  );

  it.each([
    ['net.connect(port, host)', () => net.connect(81, 'socket.invalid')],
    [
      'net.connect(options)',
      () => net.connect({ host: 'socket.invalid', port: 81 }),
    ],
    [
      'Socket#connect(port, host, callback)',
      () => new net.Socket().connect(81, 'socket.invalid', () => {}),
    ],
    [
      'Socket#connect(options, callback)',
      () =>
        new net.Socket().connect(
          { host: 'socket.invalid', port: 81 },
          () => {},
        ),
    ],
  ])('fails %s, whatever its overload', async (_name, open) => {
    const attempts = trackDbAttempts();
    const socket = open();
    expect((await errorOf(socket)).message).toContain(NETWORK_BLOCK_MESSAGE);
    expect(attempts.made).toEqual(['net.connect socket.invalid:81']);
    attempts.discard();
  });

  it('fails tls.connect', async () => {
    const attempts = trackDbAttempts();
    const socket = tls.connect(443, 'tls.invalid');
    expect((await errorOf(socket)).message).toContain(NETWORK_BLOCK_MESSAGE);
    expect(attempts.made).toEqual(['net.connect tls.invalid:443']);
    attempts.discard();
  });

  it('is still recorded when the caller swallows the error, and the check names it', async () => {
    const attempts = trackDbAttempts();
    const result = await fetch('https://swallowed.invalid/').catch(
      () => 'fell back',
    );
    expect(result).toBe('fell back');
    expect(attempts.made).toEqual(['net.connect swallowed.invalid:443']);

    expect(() => guard.assertNoDbAttempts()).toThrow(
      new RegExp(
        `^${NETWORK_BLOCK_MESSAGE}; this test tried: net\\.connect swallowed\\.invalid:443\\.`,
      ),
    );
    // The check clears the log, so one attempt fails one test only.
    expect(guard.dbAttempts).toEqual([]);
  });

  it('is named once with a count when a test repeats it', async () => {
    const attempts = trackDbAttempts();
    await fetch('https://repeat.invalid/').catch(() => undefined);
    await fetch('https://repeat.invalid/').catch(() => undefined);
    await fetch('https://repeat.invalid/').catch(() => undefined);
    await fetch('https://other.invalid/').catch(() => undefined);
    expect(attempts.made).toHaveLength(4);

    expect(() => guard.assertNoDbAttempts()).toThrow(
      /this test tried: net\.connect repeat\.invalid:443 \(x3\), net\.connect other\.invalid:443\./,
    );
    expect(guard.dbAttempts).toEqual([]);
  });

  it('names the network rule next to the database rule when a test made both', async () => {
    guard.dbAttempts.push('neon');
    await fetch('https://both.invalid/').catch(() => undefined);

    expect(() => guard.assertNoDbAttempts()).toThrow(
      new RegExp(
        `^${BLOCK_MESSAGE}; ${NETWORK_BLOCK_MESSAGE}; this test tried: neon, net\\.connect both\\.invalid:443\\.`,
      ),
    );
    expect(guard.dbAttempts).toEqual([]);
  });
});

describe('a connection that stays on this machine', () => {
  it('passes for fetch and a raw socket against a server on 127.0.0.1', async () => {
    const attempts = trackDbAttempts();
    const { port, server } = await listenOnLoopback();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(await res.text()).toBe('ok');

      const socket = net.connect(port, '127.0.0.1');
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      socket.destroy();
    } finally {
      await close(server);
    }
    expect(attempts.made).toEqual([]);
  });

  it('passes for an IPC path, whichever overload names it', async () => {
    const attempts = trackDbAttempts();
    const ipcPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\strike-calculator-net-guard-${process.pid}`
        : path.join(os.tmpdir(), `strike-calculator-net-guard-${process.pid}`);
    const server = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(ipcPath, resolve));
    try {
      for (const open of [
        () => net.connect(ipcPath),
        () => net.connect({ path: ipcPath }),
        () => new net.Socket().connect(ipcPath),
      ]) {
        const socket = open();
        await new Promise<void>((resolve, reject) => {
          socket.once('connect', resolve);
          socket.once('error', reject);
        });
        socket.destroy();
      }
    } finally {
      await close(server);
    }
    expect(attempts.made).toEqual([]);
  });
});

describe('the mocks the suite already uses', () => {
  it('never reach the socket: a stubbed or spied fetch answers in process', async () => {
    const attempts = trackDbAttempts();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('stub', { status: 200 })),
    );
    expect(await (await fetch('https://stub.invalid/')).text()).toBe('stub');
    vi.unstubAllGlobals();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('spy', { status: 200 }),
    );
    expect(await (await fetch('https://spy.invalid/')).text()).toBe('spy');

    expect(attempts.made).toEqual([]);
  });
});

describe('installNetworkBlock', () => {
  it('wraps Socket#connect once: a second call, even from a fresh module instance, leaves it alone', async () => {
    const wrapped = net.Socket.prototype.connect;
    installNetworkBlock();
    expect(net.Socket.prototype.connect).toBe(wrapped);

    vi.resetModules();
    const fresh = await import('../../src/__tests__/net-guard.js');
    expect(fresh.installNetworkBlock).not.toBe(installNetworkBlock);
    fresh.installNetworkBlock();
    expect(net.Socket.prototype.connect).toBe(wrapped);
  });
});
