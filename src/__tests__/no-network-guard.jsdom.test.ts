/**
 * The network block in the jsdom environment (src/__tests__/net-guard.ts,
 * installed in src/__tests__/setup.ts). jsdom's XMLHttpRequest sends through
 * Node's http module, so it reaches the same `net.Socket#connect` the block
 * wraps, and a component test that lets a request out fails the way an offline
 * one does. The node-environment cases (fetch, http, https, net, tls, the
 * loopback allowance) are in api/__tests__/no-network-guard.test.ts.
 *
 * Each test discards its own entries with `trackDbAttempts`, because the
 * `afterEach` in setup.ts fails any test that leaves one behind. The hosts are
 * `.invalid`, which never resolves, so nothing leaves the machine even when the
 * block is broken.
 */

import { describe, expect, it } from 'vitest';
import { NETWORK_BLOCK_MESSAGE, trackDbAttempts } from './db-guard';

describe('the network block under jsdom', () => {
  it('fails an XMLHttpRequest to a host outside this machine and records host and port only', async () => {
    const attempts = trackDbAttempts();
    const xhr = new XMLHttpRequest();
    const outcome = await new Promise<string>((resolve) => {
      xhr.addEventListener('error', () => resolve('error'));
      xhr.addEventListener('load', () => resolve('load'));
      xhr.open('GET', 'http://xhr.invalid/data?token=hunter2');
      xhr.send();
    });

    expect(outcome).toBe('error');
    expect(attempts.made).toEqual(['net.connect xhr.invalid:80']);
    expect(attempts.made.join()).not.toContain('hunter2');
    attempts.discard();
  });

  it('fails a fetch the same way and records it', async () => {
    const attempts = trackDbAttempts();
    const err = await fetch('https://fetch.invalid/').catch((e: unknown) => e);

    expect((err as Error).message).toBe('fetch failed');
    expect(((err as { cause?: Error }).cause as Error).message).toContain(
      NETWORK_BLOCK_MESSAGE,
    );
    expect(attempts.made).toEqual(['net.connect fetch.invalid:443']);
    attempts.discard();
  });
});
