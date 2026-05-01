/**
 * runCachedAnthropicCall — streaming + cache-blocks + Opus→Sonnet
 * fallback shell consolidated from `analyze.ts`, `trace-live-analyze.ts`,
 * and `periscope-chat.ts`. Each of those files has its own ~50-80 LOC
 * variant of the same pattern:
 *
 *   try { data = await stream(primaryModel).finalMessage(); }
 *   catch (e) { if not BadRequest/Auth/Permission: data = await stream(fallback) }
 *   parse text from data.content; record usage; warn on cache miss.
 *
 * This helper keeps the prompt-text shape (callers pass their own
 * `system` blocks with `cache_control: ephemeral` already attached)
 * and only abstracts the streaming + fallback + usage shell.
 *
 * Adoption is staged — see Phase 5k in
 * docs/superpowers/specs/api-refactor-2026-05-02.md. This module is
 * greenfield; no consumer migrates here.
 *
 * Phase 1f of the refactor.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages.js';
import logger from './logger.js';
import { metrics } from './sentry.js';

/**
 * Anthropic system block with optional ephemeral cache control. Re-export
 * of the SDK's `TextBlockParam` for caller convenience.
 */
export type SystemBlock = Anthropic.Messages.TextBlockParam;

/**
 * Shape of the per-call usage stats Anthropic returns in the streaming
 * `finalMessage()` response. Matches what callers already log today.
 */
export interface AnthropicCallUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface AnthropicCallOptions {
  /** Pre-built Anthropic client. Caller controls the API key. */
  client: Anthropic;
  /**
   * System blocks (text + optional cache_control). Callers pre-attach
   * `cache_control: { type: 'ephemeral', ttl: '1h' }` to whichever
   * blocks should be cached — this helper does NOT add it.
   */
  systemBlocks: SystemBlock[];
  /** User / assistant message history. */
  messages: MessageParam[];
  /** Primary model id (e.g. 'claude-opus-4-7'). */
  primaryModel: string;
  /**
   * Fallback model id used when the primary throws an availability
   * error (rate-limited, overloaded, server error). When unset we let
   * the error bubble up.
   */
  fallbackModel?: string;
  /** max_tokens for the primary call. */
  maxTokens: number;
  /** max_tokens for the fallback call. Defaults to `maxTokens`. */
  fallbackMaxTokens?: number;
  /**
   * `output_config.effort` for the primary call. Forwarded verbatim.
   * Optional — leave undefined for the SDK default.
   */
  effort?: 'low' | 'medium' | 'high';
  /** `output_config.effort` for the fallback. Defaults to `effort`. */
  fallbackEffort?: 'low' | 'medium' | 'high';
  /**
   * Whether to enable adaptive thinking on the primary call. Defaults
   * to `true` — every adoption site uses it today.
   */
  thinking?: boolean;
  /** Optional usage hook — fires once per successful call (any model). */
  onUsage?: (usage: AnthropicCallUsage, modelUsed: string) => void;
}

export interface AnthropicCallResult {
  /** Concatenated text content from the response (text blocks only). */
  text: string;
  /** Token / cache stats for the call that succeeded. */
  usage: AnthropicCallUsage;
  /** The model id that produced the response (primary or fallback). */
  modelUsed: string;
  /** True when at least one cache_read_input_tokens count was non-zero. */
  cacheHit: boolean;
  /** stop_reason returned by the SDK, or null if unset. */
  stopReason: string | null;
}

/**
 * True for Anthropic SDK errors that won't succeed on any model — bad
 * input, missing auth, etc. Falling back is pointless for these.
 */
function isClientErrorThatWontRetry(err: unknown): boolean {
  return (
    err instanceof Anthropic.BadRequestError ||
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError
  );
}

/**
 * Streams an Anthropic message call, transparently falling back to a
 * secondary model on availability errors, accumulating the final text
 * + usage, and reporting cache-hit information for cost monitoring.
 *
 * Mirrors the patterns in `analyze.ts` / `trace-live-analyze.ts` /
 * `periscope-chat.ts` so adoption (Phase 5k) is a near drop-in.
 */
export async function runCachedAnthropicCall(
  opts: AnthropicCallOptions,
): Promise<AnthropicCallResult> {
  const {
    client,
    systemBlocks,
    messages,
    primaryModel,
    fallbackModel,
    maxTokens,
    fallbackMaxTokens,
    effort,
    fallbackEffort,
    thinking = true,
    onUsage,
  } = opts;

  const buildStream = (
    model: string,
    tokens: number,
    eff: 'low' | 'medium' | 'high' | undefined,
  ) => {
    const params: Record<string, unknown> = {
      model,
      max_tokens: tokens,
      system: systemBlocks,
      messages,
    };
    if (thinking) params.thinking = { type: 'adaptive' };
    if (eff) params.output_config = { effort: eff };
    return client.messages.stream(
      params as unknown as Parameters<typeof client.messages.stream>[0],
    );
  };

  let modelUsed = primaryModel;
  let response: Awaited<
    ReturnType<ReturnType<typeof buildStream>['finalMessage']>
  >;
  try {
    response = await buildStream(
      primaryModel,
      maxTokens,
      effort,
    ).finalMessage();
  } catch (err) {
    if (!fallbackModel || isClientErrorThatWontRetry(err)) {
      throw err;
    }
    logger.info(
      { err, primaryModel, fallbackModel },
      'Anthropic primary unavailable, falling back',
    );
    metrics.increment('anthropic.fallback');
    modelUsed = fallbackModel;
    response = await buildStream(
      fallbackModel,
      fallbackMaxTokens ?? maxTokens,
      fallbackEffort ?? effort,
    ).finalMessage();
  }

  const text = response.content
    .filter((c) => c.type === 'text')
    .map((c) => ('text' in c ? c.text : ''))
    .join('');

  const usage: AnthropicCallUsage = {
    input: response.usage?.input_tokens ?? 0,
    output: response.usage?.output_tokens ?? 0,
    cacheRead: response.usage?.cache_read_input_tokens ?? 0,
    cacheWrite: response.usage?.cache_creation_input_tokens ?? 0,
  };

  const cacheHit = usage.cacheRead > 0;

  // Mirror analyze.ts's existing cache-miss alert: if we wrote new
  // cache content but read none, the prompt prefix likely changed and
  // the cache-busting needs investigating.
  if (usage.cacheRead === 0 && usage.cacheWrite > 0) {
    logger.warn(
      { model: modelUsed },
      'Anthropic cache miss on system prompt — prefix may have changed',
    );
  }

  onUsage?.(usage, modelUsed);

  return {
    text,
    usage,
    modelUsed,
    cacheHit,
    stopReason: response.stop_reason ?? null,
  };
}
