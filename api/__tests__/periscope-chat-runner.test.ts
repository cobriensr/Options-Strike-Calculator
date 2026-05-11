// @vitest-environment node

/**
 * Unit tests for api/_lib/periscope-chat-runner.ts.
 *
 * Strategy: mock every collaborator (DB fetchers, prompt builders, the
 * Anthropic-call wrapper, embeddings, fs) so the orchestration logic in
 * `runPeriscopeAutoPlaybook` is exercised in isolation. The Anthropic
 * SDK itself is NOT mocked — the runner only constructs the client and
 * hands it to `runCachedAnthropicCall`, which is mocked.
 *
 * Module-init concerns: the runner reads SKILL.md (mandatory) and the
 * references file (optional) at import time. We hoist `vi.mock('node:fs')`
 * so both reads return canned bytes regardless of the host filesystem.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn((path: string) => {
    if (path.endsWith('SKILL.md')) return '# Periscope skill body';
    if (path.endsWith('vol-signals-mm-heuristics.md'))
      return '# vol signals body';
    throw new Error(`unexpected readFileSync path: ${path}`);
  }),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../_lib/anthropic-call.js', () => ({
  runCachedAnthropicCall: vi.fn(),
}));

vi.mock('../_lib/periscope-synthesize.js', () => ({
  synthesizeFromDb: vi.fn(),
}));

vi.mock('../_lib/periscope-prompts.js', () => ({
  buildUserContent: vi.fn(() => [{ type: 'text', text: 'user content' }]),
  formatHeatMapBlock: vi.fn(() => 'heat-map block'),
  parseStructuredFields: vi.fn(),
}));

vi.mock('../_lib/periscope-calibration.js', () => ({
  buildCalibrationBlock: vi.fn(),
}));

vi.mock('../_lib/periscope-retrieval.js', () => ({
  buildRetrievalBlock: vi.fn(),
}));

vi.mock('../_lib/periscope-lessons.js', () => ({
  fetchActiveLessons: vi.fn(),
  formatLessonsBlock: vi.fn(),
}));

vi.mock('../_lib/periscope-flow-context.js', () => ({
  buildFlowContextBlock: vi.fn(),
}));

vi.mock('../_lib/embeddings.js', () => ({
  generateEmbedding: vi.fn(),
}));

vi.mock('../_lib/periscope-db.js', () => ({
  buildPeriscopeSummary: vi.fn(() => 'summary text'),
  fetchParentChain: vi.fn(),
  fetchPeriscopeAnalysisById: vi.fn(),
}));

import { runPeriscopeAutoPlaybook } from '../_lib/periscope-chat-runner.js';
import { runCachedAnthropicCall } from '../_lib/anthropic-call.js';
import { synthesizeFromDb } from '../_lib/periscope-synthesize.js';
import {
  buildUserContent,
  parseStructuredFields,
} from '../_lib/periscope-prompts.js';
import { buildCalibrationBlock } from '../_lib/periscope-calibration.js';
import { buildRetrievalBlock } from '../_lib/periscope-retrieval.js';
import {
  fetchActiveLessons,
  formatLessonsBlock,
} from '../_lib/periscope-lessons.js';
import { buildFlowContextBlock } from '../_lib/periscope-flow-context.js';
import { generateEmbedding } from '../_lib/embeddings.js';
import {
  fetchParentChain,
  fetchPeriscopeAnalysisById,
  type PeriscopeStructuredFields,
} from '../_lib/periscope-db.js';
import { Sentry } from '../_lib/sentry.js';

const baseInput = {
  mode: 'intraday' as const,
  parentId: 42,
  tradingDate: '2026-05-08',
  readTimeIso: '2026-05-08T18:30:00Z',
  spotAtReadTime: 5912.34,
};

const structuredFixture: PeriscopeStructuredFields = {
  spot: 5912.34,
  cone_lower: 5880,
  cone_upper: 5945,
  long_trigger: 5920,
  short_trigger: 5900,
  regime_tag: 'pinning',
  bias: 'two-sided',
  trade_types_recommended: ['IC'],
  trade_types_avoided: ['naked-call'],
  key_levels: {
    gamma_floor: 5895,
    gamma_ceiling: 5925,
    magnet: 5910,
    charm_zero: 5905,
  },
  expected_dealer_behavior: 'suppressive',
  confidence: 'medium',
  confidence_basis: 'cone width small, OI clustered',
  futures_plan: null,
};

const synthFixture = {
  heatMaps: { rows: [] } as Record<string, unknown>,
  charmZeroStrike: 5905,
  extraction: {
    structured: {
      ...structuredFixture,
      cone_lower: 5880,
      cone_upper: 5945,
    },
  },
};

const okAnthropic = {
  text: 'narrative prose',
  usage: { input: 1000, output: 250, cacheRead: 800, cacheWrite: 200 },
  modelUsed: 'claude-opus-4-7',
  cacheHit: true,
  stopReason: 'end_turn',
};

beforeEach(() => {
  vi.clearAllMocks();

  // Defaults — happy path. Tests override per-case.
  vi.mocked(synthesizeFromDb).mockResolvedValue(
    synthFixture as unknown as Awaited<ReturnType<typeof synthesizeFromDb>>,
  );
  vi.mocked(buildCalibrationBlock).mockResolvedValue('cal block');
  vi.mocked(buildRetrievalBlock).mockResolvedValue('retr block');
  vi.mocked(fetchActiveLessons).mockResolvedValue([]);
  vi.mocked(formatLessonsBlock).mockReturnValue('');
  vi.mocked(buildFlowContextBlock).mockResolvedValue('flow block');
  vi.mocked(fetchPeriscopeAnalysisById).mockResolvedValue(null);
  vi.mocked(fetchParentChain).mockResolvedValue([]);
  vi.mocked(generateEmbedding).mockResolvedValue([0.1, 0.2, 0.3]);
  vi.mocked(parseStructuredFields).mockReturnValue({
    prose: 'narrative prose',
    structured: structuredFixture,
    parseOk: true,
  });
  vi.mocked(runCachedAnthropicCall).mockResolvedValue(okAnthropic);
});

describe('runPeriscopeAutoPlaybook', () => {
  it('happy path: returns complete with prose, structured, embedding, panelPayload', async () => {
    const out = await runPeriscopeAutoPlaybook(baseInput);

    expect(out.status).toBe('complete');
    expect(out.prose).toBe('narrative prose');
    expect(out.structured.spot).toBe(5912.34);
    expect(out.parseOk).toBe(true);
    expect(out.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(out.panelPayload).not.toBeNull();
    expect(out.panelPayload).toMatchObject({
      spot: 5912.34,
      cone: { lower: 5880, upper: 5945 },
      gammaFloor: 5895,
      gammaCeiling: 5925,
      charmZero: 5905,
      narrative: 'narrative prose',
    });
    expect(out.modelUsed).toBe('claude-opus-4-7');
    expect(out.inputTokens).toBe(1000);
    expect(out.cacheReadTokens).toBe(800);
  });

  it('panel_payload.spot uses DB-resolved spotAtReadTime, NOT Claude-echoed structured.spot', async () => {
    // Override structured.spot so it disagrees with spotAtReadTime.
    // The 2026-05-06/07 grading run found that Claude's structured
    // output sometimes drifts 30-50pt from actual SPX cash. The panel
    // payload must reflect the DB truth, not Claude's echo.
    vi.mocked(parseStructuredFields).mockReturnValue({
      prose: 'narrative prose',
      structured: { ...structuredFixture, spot: 9999.99 }, // garbage
      parseOk: true,
    });
    const out = await runPeriscopeAutoPlaybook({
      ...baseInput,
      spotAtReadTime: 5912.34,
    });
    expect(out.panelPayload).not.toBeNull();
    expect(out.panelPayload?.spot).toBe(5912.34);
    expect(out.structured.spot).toBe(9999.99); // raw structured untouched
    expect(out.failureReason).toBeNull();
  });

  it('returns failed with no_periscope_snapshots_for_slot when synth returns null', async () => {
    vi.mocked(synthesizeFromDb).mockResolvedValue(null);

    const out = await runPeriscopeAutoPlaybook(baseInput);

    expect(out.status).toBe('failed');
    expect(out.failureReason).toBe('no_periscope_snapshots_for_slot');
    expect(out.prose).toBe('');
    expect(out.embedding).toBeNull();
    expect(out.panelPayload).toBeNull();
    expect(out.modelUsed).toBeNull();
    // Anthropic must never be called when synth is empty.
    expect(runCachedAnthropicCall).not.toHaveBeenCalled();
  });

  it('synth throw is caught, Sentry captured, returns failed', async () => {
    vi.mocked(synthesizeFromDb).mockRejectedValue(new Error('db down'));

    const out = await runPeriscopeAutoPlaybook(baseInput);

    expect(out.status).toBe('failed');
    expect(out.failureReason).toBe('no_periscope_snapshots_for_slot');
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('Anthropic call throw returns failed with anthropic_call_failed and error message', async () => {
    vi.mocked(runCachedAnthropicCall).mockRejectedValue(
      new Error('Overloaded after fallback'),
    );

    const out = await runPeriscopeAutoPlaybook(baseInput);

    expect(out.status).toBe('failed');
    expect(out.failureReason).toMatch(/anthropic_call_failed/);
    expect(out.failureReason).toMatch(/Overloaded after fallback/);
    expect(out.fullResponse).toEqual({ error: 'Overloaded after fallback' });
    expect(out.embedding).toBeNull();
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('stop_reason refusal returns failed with claude_refusal and captureMessage', async () => {
    vi.mocked(runCachedAnthropicCall).mockResolvedValue({
      ...okAnthropic,
      stopReason: 'refusal',
    });

    const out = await runPeriscopeAutoPlaybook(baseInput);

    expect(out.status).toBe('failed');
    expect(out.failureReason).toBe('claude_refusal');
    expect(out.prose).toBe('');
    expect(out.embedding).toBeNull();
    expect(out.panelPayload).toBeNull();
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'periscope auto-playbook refused by Claude',
      expect.objectContaining({
        tags: expect.objectContaining({ stage: 'refusal' }),
      }),
    );
  });

  it('stop_reason max_tokens returns truncated with best-effort embedding', async () => {
    vi.mocked(runCachedAnthropicCall).mockResolvedValue({
      ...okAnthropic,
      stopReason: 'max_tokens',
      text: 'partial prose...',
    });
    vi.mocked(parseStructuredFields).mockReturnValue({
      prose: 'partial prose...',
      structured: structuredFixture,
      parseOk: true,
    });

    const out = await runPeriscopeAutoPlaybook(baseInput);

    expect(out.status).toBe('truncated');
    expect(out.failureReason).toMatch(/truncated_at_max_tokens/);
    expect(out.embedding).toEqual([0.1, 0.2, 0.3]);
    // panelPayload populated when parseOk on truncated output.
    expect(out.panelPayload).not.toBeNull();
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'periscope auto-playbook truncated at max_tokens',
      expect.any(Object),
    );
  });

  it('truncated with parseOk=false leaves panelPayload null', async () => {
    vi.mocked(runCachedAnthropicCall).mockResolvedValue({
      ...okAnthropic,
      stopReason: 'max_tokens',
    });
    vi.mocked(parseStructuredFields).mockReturnValue({
      prose: 'partial',
      structured: structuredFixture,
      parseOk: false,
    });

    const out = await runPeriscopeAutoPlaybook(baseInput);

    expect(out.status).toBe('truncated');
    expect(out.panelPayload).toBeNull();
  });

  it('embedding failure does NOT fail the read — returns null embedding, status complete', async () => {
    vi.mocked(generateEmbedding).mockRejectedValue(new Error('OpenAI 429'));

    const out = await runPeriscopeAutoPlaybook(baseInput);

    expect(out.status).toBe('complete');
    expect(out.embedding).toBeNull();
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('calibration / parent / retrieval / flow failures degrade gracefully', async () => {
    vi.mocked(buildCalibrationBlock).mockRejectedValue(new Error('cal-fail'));
    vi.mocked(fetchPeriscopeAnalysisById).mockRejectedValue(
      new Error('parent-fail'),
    );
    vi.mocked(fetchParentChain).mockRejectedValue(new Error('chain-fail'));
    vi.mocked(buildFlowContextBlock).mockRejectedValue(new Error('flow-fail'));
    vi.mocked(buildRetrievalBlock).mockRejectedValue(new Error('retr-fail'));

    const out = await runPeriscopeAutoPlaybook(baseInput);

    expect(out.status).toBe('complete');
    expect(Sentry.captureException).toHaveBeenCalledTimes(5);
    // Each failed collaborator captured exactly once.
  });

  it('pre_trade mode skips parent + parent chain fetches', async () => {
    await runPeriscopeAutoPlaybook({
      ...baseInput,
      mode: 'pre_trade',
      parentId: null,
    });

    expect(fetchPeriscopeAnalysisById).not.toHaveBeenCalled();
    expect(fetchParentChain).not.toHaveBeenCalled();
  });

  it('intraday mode with null parentId skips parent fetches', async () => {
    await runPeriscopeAutoPlaybook({
      ...baseInput,
      mode: 'intraday',
      parentId: null,
    });

    expect(fetchPeriscopeAnalysisById).not.toHaveBeenCalled();
    expect(fetchParentChain).not.toHaveBeenCalled();
  });

  it('intraday mode with parentId fetches parent + chain', async () => {
    await runPeriscopeAutoPlaybook({ ...baseInput, parentId: 99 });

    expect(fetchPeriscopeAnalysisById).toHaveBeenCalledWith(99);
    expect(fetchParentChain).toHaveBeenCalledWith(99);
  });

  it('lessons fetch failure logs to Sentry but does not throw', async () => {
    vi.mocked(fetchActiveLessons).mockRejectedValue(
      new Error('lessons db gone'),
    );

    const out = await runPeriscopeAutoPlaybook(baseInput);

    expect(out.status).toBe('complete');
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ stage: 'lessons_fetch' }),
      }),
    );
  });

  it('lessons present are appended to references block', async () => {
    vi.mocked(fetchActiveLessons).mockResolvedValue([
      { id: 1, content: 'lesson body' } as never,
    ]);
    vi.mocked(formatLessonsBlock).mockReturnValue('=== LESSONS ===\nlesson');

    await runPeriscopeAutoPlaybook(baseInput);

    expect(formatLessonsBlock).toHaveBeenCalledTimes(1);
  });

  it('cone null in synth yields panelPayload.cone === null', async () => {
    vi.mocked(synthesizeFromDb).mockResolvedValue({
      ...synthFixture,
      extraction: {
        structured: {
          ...structuredFixture,
          cone_lower: null,
          cone_upper: null,
        },
      },
    } as unknown as Awaited<ReturnType<typeof synthesizeFromDb>>);
    vi.mocked(parseStructuredFields).mockReturnValue({
      prose: 'narrative prose',
      structured: { ...structuredFixture, cone_lower: null, cone_upper: null },
      parseOk: true,
    });

    const out = await runPeriscopeAutoPlaybook(baseInput);

    expect(out.panelPayload).not.toBeNull();
    expect(out.panelPayload?.cone).toBeNull();
  });

  it('user content builder receives heatMapBlock and spotDirective', async () => {
    await runPeriscopeAutoPlaybook(baseInput);

    expect(buildUserContent).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(buildUserContent).mock.calls[0]?.[0];
    expect(arg?.heatMapBlock).toBe('heat-map block');
    expect(arg?.spotDirective).toMatch(/5912\.34/);
    expect(arg?.spotDirective).toMatch(/Charm-zero strike.*5905/);
    expect(arg?.spotDirective).toMatch(/cone.*5880/);
  });

  it('null cone in synth omits cone line from spotDirective', async () => {
    vi.mocked(synthesizeFromDb).mockResolvedValue({
      ...synthFixture,
      extraction: {
        structured: {
          ...structuredFixture,
          cone_lower: null,
          cone_upper: null,
        },
      },
    } as unknown as Awaited<ReturnType<typeof synthesizeFromDb>>);

    await runPeriscopeAutoPlaybook(baseInput);

    const arg = vi.mocked(buildUserContent).mock.calls[0]?.[0];
    expect(arg?.spotDirective).not.toMatch(/Straddle cone bounds/);
  });

  it('null charmZeroStrike omits charm-zero line from spotDirective', async () => {
    vi.mocked(synthesizeFromDb).mockResolvedValue({
      ...synthFixture,
      charmZeroStrike: null,
    } as unknown as Awaited<ReturnType<typeof synthesizeFromDb>>);

    await runPeriscopeAutoPlaybook(baseInput);

    const arg = vi.mocked(buildUserContent).mock.calls[0]?.[0];
    expect(arg?.spotDirective).not.toMatch(/Charm-zero strike/);
  });

  it('fallbackModel override is forwarded to runCachedAnthropicCall', async () => {
    await runPeriscopeAutoPlaybook({
      ...baseInput,
      fallbackModel: 'claude-haiku-4-5',
    });

    expect(runCachedAnthropicCall).toHaveBeenCalledWith(
      expect.objectContaining({
        primaryModel: 'claude-opus-4-7',
        fallbackModel: 'claude-haiku-4-5',
        fallbackEffort: 'high',
        effort: 'xhigh',
        maxTokens: 128_000,
        fallbackMetric: 'periscope_auto_playbook.opus_fallback',
      }),
    );
  });

  it('default fallbackModel is claude-sonnet-4-6 when not provided', async () => {
    await runPeriscopeAutoPlaybook(baseInput);

    expect(runCachedAnthropicCall).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackModel: 'claude-sonnet-4-6' }),
    );
  });

  it('systemBlocks include skill, references+lessons, calibration, retrieval (all 4 cached)', async () => {
    await runPeriscopeAutoPlaybook(baseInput);

    const call = vi.mocked(runCachedAnthropicCall).mock.calls[0]?.[0];
    expect(call?.systemBlocks).toHaveLength(4);
    expect(call?.systemBlocks?.[0]?.text).toMatch(/Periscope skill body/);
    expect(call?.systemBlocks?.[1]?.text).toMatch(/vol signals/);
    // All blocks have ephemeral cache_control with 1h TTL.
    for (const block of call?.systemBlocks ?? []) {
      expect(block.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    }
  });

  it('durationMs is non-negative even on failed-no-snapshot fast-exit', async () => {
    vi.mocked(synthesizeFromDb).mockResolvedValue(null);
    const out = await runPeriscopeAutoPlaybook(baseInput);
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
  });
});
