// @vitest-environment node

/**
 * Unit tests for api/_lib/anthropic-call.ts (Phase 1f).
 *
 * Mocks the Anthropic SDK by handing in a stub `client` whose
 * `messages.stream(...)` returns a Promise-returning `finalMessage()`.
 * Avoids using `vi.mock('@anthropic-ai/sdk')` so the BadRequestError /
 * AuthenticationError instanceof checks still work against the real
 * exported classes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { runCachedAnthropicCall } from '../_lib/anthropic-call.js';
import { metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

vi.mock('../_lib/sentry.js', () => ({
  metrics: { increment: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

interface MockResponseShape {
  content: Array<{ type: 'text'; text: string }>;
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  stop_reason?: string | null;
  model?: string;
}

function makeClient(
  responses: Array<MockResponseShape | (() => never)>,
): Anthropic {
  let call = 0;
  return {
    messages: {
      stream: () => ({
        finalMessage: () => {
          const next = responses[call++];
          if (typeof next === 'function') {
            // throws-on-call sentinel
            return Promise.reject(next());
          }
          return Promise.resolve(next);
        },
      }),
    },
  } as unknown as Anthropic;
}

const SYS_BLOCKS = [{ type: 'text' as const, text: 'system prompt' }];
const USER_MSG = [{ role: 'user' as const, content: 'hi' }];

describe('runCachedAnthropicCall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: returns text + usage + cacheHit', async () => {
    const client = makeClient([
      {
        content: [{ type: 'text', text: 'hello world' }],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 0,
        },
        stop_reason: 'end_turn',
      },
    ]);

    const result = await runCachedAnthropicCall({
      client,
      systemBlocks: SYS_BLOCKS,
      messages: USER_MSG,
      primaryModel: 'claude-opus-4-7',
      maxTokens: 1024,
    });

    expect(result.text).toBe('hello world');
    expect(result.usage).toEqual({
      input: 100,
      output: 20,
      cacheRead: 50,
      cacheWrite: 0,
    });
    expect(result.modelUsed).toBe('claude-opus-4-7');
    expect(result.cacheHit).toBe(true);
    expect(result.stopReason).toBe('end_turn');
  });

  it('cacheHit is false when cacheRead is 0', async () => {
    const client = makeClient([
      {
        content: [{ type: 'text', text: 'x' }],
        usage: { cache_read_input_tokens: 0 },
      },
    ]);

    const result = await runCachedAnthropicCall({
      client,
      systemBlocks: SYS_BLOCKS,
      messages: USER_MSG,
      primaryModel: 'claude-opus-4-7',
      maxTokens: 1024,
    });

    expect(result.cacheHit).toBe(false);
  });

  it('falls back to fallbackModel on availability error', async () => {
    const client = makeClient([
      () => {
        throw new Error('Overloaded');
      },
      {
        content: [{ type: 'text', text: 'sonnet response' }],
        usage: {
          input_tokens: 80,
          output_tokens: 15,
        },
      },
    ]);

    const result = await runCachedAnthropicCall({
      client,
      systemBlocks: SYS_BLOCKS,
      messages: USER_MSG,
      primaryModel: 'claude-opus-4-7',
      fallbackModel: 'claude-sonnet-4-6',
      maxTokens: 1024,
    });

    expect(result.modelUsed).toBe('claude-sonnet-4-6');
    expect(result.text).toBe('sonnet response');
  });

  it('does NOT fall back on BadRequestError (rethrows)', async () => {
    const client = makeClient([
      () => {
        throw new Anthropic.BadRequestError(
          400,
          { error: { type: 'invalid_request_error', message: 'bad' } },
          'bad input',
          new Headers(),
        );
      },
    ]);

    await expect(
      runCachedAnthropicCall({
        client,
        systemBlocks: SYS_BLOCKS,
        messages: USER_MSG,
        primaryModel: 'claude-opus-4-7',
        fallbackModel: 'claude-sonnet-4-6',
        maxTokens: 1024,
      }),
    ).rejects.toThrow();
  });

  it('does NOT fall back on AuthenticationError', async () => {
    const client = makeClient([
      () => {
        throw new Anthropic.AuthenticationError(
          401,
          { error: { type: 'authentication_error', message: 'no key' } },
          'no key',
          new Headers(),
        );
      },
    ]);

    await expect(
      runCachedAnthropicCall({
        client,
        systemBlocks: SYS_BLOCKS,
        messages: USER_MSG,
        primaryModel: 'claude-opus-4-7',
        fallbackModel: 'claude-sonnet-4-6',
        maxTokens: 1024,
      }),
    ).rejects.toThrow();
  });

  it('rethrows the primary error when no fallbackModel is provided', async () => {
    const client = makeClient([
      () => {
        throw new Error('Overloaded');
      },
    ]);

    await expect(
      runCachedAnthropicCall({
        client,
        systemBlocks: SYS_BLOCKS,
        messages: USER_MSG,
        primaryModel: 'claude-opus-4-7',
        maxTokens: 1024,
      }),
    ).rejects.toThrow(/Overloaded/);
  });

  it('invokes onUsage with usage stats and modelUsed', async () => {
    const client = makeClient([
      {
        content: [{ type: 'text', text: 'x' }],
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 4,
        },
      },
    ]);

    const onUsage = vi.fn();

    await runCachedAnthropicCall({
      client,
      systemBlocks: SYS_BLOCKS,
      messages: USER_MSG,
      primaryModel: 'claude-opus-4-7',
      maxTokens: 1024,
      onUsage,
    });

    expect(onUsage).toHaveBeenCalledWith(
      { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      'claude-opus-4-7',
    );
  });

  it('warns when cache_creation_input_tokens > 0 and cache_read_input_tokens === 0', async () => {
    // Cache-miss alarm: we wrote new cache content but read none. The
    // prompt prefix likely changed and cache-busting needs investigating.
    const client = makeClient([
      {
        content: [{ type: 'text', text: 'fresh' }],
        usage: {
          input_tokens: 200,
          output_tokens: 10,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 1000,
        },
      },
    ]);

    const result = await runCachedAnthropicCall({
      client,
      systemBlocks: SYS_BLOCKS,
      messages: USER_MSG,
      primaryModel: 'claude-opus-4-7',
      maxTokens: 1024,
    });

    expect(result.cacheHit).toBe(false);
    expect(result.usage.cacheWrite).toBe(1000);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { model: 'claude-opus-4-7' },
      expect.stringContaining('cache miss'),
    );
  });

  it('does NOT warn when cache_creation_input_tokens is 0 (no write attempted)', async () => {
    // Sanity check: a call that didn't try to populate the cache should
    // not log a "miss" — there was no write to mismatch against.
    const client = makeClient([
      {
        content: [{ type: 'text', text: 'x' }],
        usage: {
          input_tokens: 50,
          output_tokens: 10,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    ]);

    await runCachedAnthropicCall({
      client,
      systemBlocks: SYS_BLOCKS,
      messages: USER_MSG,
      primaryModel: 'claude-opus-4-7',
      maxTokens: 1024,
    });

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('uses default fallbackMetric "anthropic.fallback" when not provided', async () => {
    const client = makeClient([
      () => {
        throw new Error('Overloaded');
      },
      {
        content: [{ type: 'text', text: 'fb' }],
        usage: {},
      },
    ]);

    await runCachedAnthropicCall({
      client,
      systemBlocks: SYS_BLOCKS,
      messages: USER_MSG,
      primaryModel: 'claude-opus-4-7',
      fallbackModel: 'claude-sonnet-4-6',
      maxTokens: 1024,
    });

    expect(metrics.increment).toHaveBeenCalledTimes(1);
    expect(metrics.increment).toHaveBeenCalledWith('anthropic.fallback');
  });

  it('honors a custom fallbackMetric for adopters with existing dashboards', async () => {
    // Phase 5k adopters need to keep their pre-existing Sentry labels —
    // analyze.ts uses 'analyze.opus_fallback', etc.
    const client = makeClient([
      () => {
        throw new Error('Overloaded');
      },
      {
        content: [{ type: 'text', text: 'fb' }],
        usage: {},
      },
    ]);

    await runCachedAnthropicCall({
      client,
      systemBlocks: SYS_BLOCKS,
      messages: USER_MSG,
      primaryModel: 'claude-opus-4-7',
      fallbackModel: 'claude-sonnet-4-6',
      maxTokens: 1024,
      fallbackMetric: 'analyze.opus_fallback',
    });

    expect(metrics.increment).toHaveBeenCalledTimes(1);
    expect(metrics.increment).toHaveBeenCalledWith('analyze.opus_fallback');
  });

  it('concatenates only text-type content blocks', async () => {
    const client = makeClient([
      {
        content: [
          { type: 'text', text: 'part-1 ' },
          // tool_use blocks etc. should be filtered out.
          { type: 'thinking' as const, text: 'ignored' } as unknown as {
            type: 'text';
            text: string;
          },
          { type: 'text', text: 'part-2' },
        ],
        usage: {},
      },
    ]);

    const result = await runCachedAnthropicCall({
      client,
      systemBlocks: SYS_BLOCKS,
      messages: USER_MSG,
      primaryModel: 'claude-opus-4-7',
      maxTokens: 1024,
    });

    expect(result.text).toBe('part-1 part-2');
  });
});
