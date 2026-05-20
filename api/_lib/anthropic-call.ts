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
import { Sentry, metrics } from './sentry.js';

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
   *
   * Levels (Opus 4.7+): low | medium | high | xhigh | max.
   * Anthropic's recommended default for agentic / coding work on
   * Opus 4.7 is xhigh. max is Opus-only and the most expensive.
   */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * `output_config.effort` for the fallback. Defaults to `effort`.
   *
   * Set explicitly to `'high'` when the primary is `'xhigh'` or `'max'`
   * — those levels are Opus 4.7+ only and the typical Sonnet 4.6
   * fallback would 400 on them.
   */
  fallbackEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * Whether to enable adaptive thinking on the primary call. Defaults
   * to `true` — every adoption site uses it today.
   */
  thinking?: boolean;
  /**
   * Sentry metric name incremented when the primary model errors and
   * the fallback runs. Defaults to `'anthropic.fallback'` for greenfield
   * callers.
   *
   * Phase 5k adopters: existing handlers track distinct dashboards keyed
   * on bespoke labels — pass them through here to preserve continuity:
   *   - `analyze.ts`            → `'analyze.opus_fallback'`
   *   - `trace-live-analyze.ts` → `'trace_live.opus_fallback'`
   *   - `periscope-chat.ts`     → `'periscope_chat.opus_fallback'`
   *
   * Without this option, every adoption silently re-buckets the metric
   * to the default name and existing Sentry dashboards stop ticking.
   */
  fallbackMetric?: string;
  /** Optional usage hook — fires once per successful call (any model). */
  onUsage?: (usage: AnthropicCallUsage, modelUsed: string) => void;
  /**
   * Optional tool definitions for structured-output extraction. Pair
   * with `toolChoice: { type: 'tool', name: '...' }` to force Claude
   * to emit a `tool_use` block whose `input` is schema-validated JSON.
   *
   * Use this instead of asking Claude for a fenced ```json block — the
   * tool_use channel guarantees valid JSON (Anthropic constrains
   * generation against the input_schema), eliminating the JSON.parse
   * failure mode that periodically occurs when free-text prose fields
   * contain unescaped control characters.
   */
  tools?: Anthropic.Messages.Tool[];
  /**
   * Optional tool-choice constraint. When set to
   * `{ type: 'tool', name: '...' }`, Claude MUST call the named tool
   * exactly once, returning structured data in a tool_use block.
   * Claude may still emit text content blocks alongside the tool_use.
   */
  toolChoice?: Anthropic.Messages.ToolChoice;
}

export interface AnthropicCallResult {
  /** Concatenated text content from the response (text blocks only). */
  text: string;
  /**
   * Inputs from every `tool_use` content block in the response, in the
   * order Claude emitted them. Empty when no tools were passed or
   * Claude chose not to call any tool (only possible when toolChoice
   * was unset or `'auto'`). When forced via
   * `toolChoice: { type: 'tool', ... }` there will be exactly one
   * entry per matching block.
   */
  toolUseBlocks: Array<{ name: string; input: unknown }>;
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
    fallbackMetric = 'anthropic.fallback',
    onUsage,
    tools,
    toolChoice,
  } = opts;

  // Anthropic constraint: when tool_choice forces a specific tool
  // (type='tool' or type='any'), `thinking` cannot be enabled.
  // The combination 400s with:
  //   "Thinking may not be enabled when tool_choice forces tool use."
  // Auto-disable thinking in that case so callers don't have to
  // remember the rule per call site.
  const forcedToolChoice =
    toolChoice != null &&
    (toolChoice.type === 'tool' || toolChoice.type === 'any');
  const effectiveThinking = thinking && !forcedToolChoice;

  const buildStream = (
    model: string,
    tokens: number,
    eff: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined,
  ) => {
    const params: Record<string, unknown> = {
      model,
      max_tokens: tokens,
      system: systemBlocks,
      messages,
    };
    if (effectiveThinking) params.thinking = { type: 'adaptive' };
    if (eff) params.output_config = { effort: eff };
    if (tools != null && tools.length > 0) params.tools = tools;
    if (toolChoice != null) params.tool_choice = toolChoice;
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
    // Surface the primary-model failure to Sentry — prior to the
    // 2026-05-19 audit only `metrics.increment` was emitted, so
    // sustained Opus 503s during market hours showed only as a counter
    // tick in Axiom while the analyze endpoint quietly degraded to
    // Sonnet. The fallback is the correct response; the alert lets us
    // see systematic degradation before it affects analysis quality.
    Sentry.captureException(err, {
      level: 'warning',
      tags: {
        module: 'anthropic-call',
        stage: 'primary_fallback',
        primaryModel,
        fallbackModel,
      },
    });
    metrics.increment(fallbackMetric);
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

  // Tool-use blocks live alongside text blocks when `tools` were
  // passed. With `toolChoice: { type: 'tool', name: '...' }` Claude
  // emits exactly one. The `input` field is schema-validated JSON
  // (Anthropic constrains generation against `input_schema`), so
  // callers can skip JSON.parse and use the object directly.
  const toolUseBlocks = response.content
    .filter((c) => c.type === 'tool_use')
    .map((c) => ({
      name: 'name' in c ? c.name : '',
      input: 'input' in c ? c.input : null,
    }));

  const usage: AnthropicCallUsage = {
    input: response.usage?.input_tokens ?? 0,
    output: response.usage?.output_tokens ?? 0,
    cacheRead: response.usage?.cache_read_input_tokens ?? 0,
    cacheWrite: response.usage?.cache_creation_input_tokens ?? 0,
  };

  const cacheHit = usage.cacheRead > 0;

  metrics.anthropicCache(modelUsed, cacheHit);

  // Mirror analyze.ts's existing cache-miss alert: if we wrote new
  // cache content but read none, the prompt prefix likely changed and
  // the cache-busting needs investigating. Distinguish this from a
  // cold-start (no cache_write either) so dashboards can alert on
  // unexpected invalidations instead of natural TTL expiry.
  if (usage.cacheRead === 0 && usage.cacheWrite > 0) {
    metrics.increment('anthropic.cache_miss_on_write');
    logger.warn(
      { model: modelUsed },
      'Anthropic cache miss on system prompt — prefix may have changed',
    );
  }

  onUsage?.(usage, modelUsed);

  return {
    text,
    toolUseBlocks,
    usage,
    modelUsed,
    cacheHit,
    stopReason: response.stop_reason ?? null,
  };
}
