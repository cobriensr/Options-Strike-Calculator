// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
  metrics: { request: vi.fn(() => vi.fn()), increment: vi.fn() },
}));

import {
  extractChartStructure,
  extractHeatMapStrikes,
} from '../_lib/periscope-extract.js';

const SAMPLE_BASE64 = 'aGVsbG8td29ybGQ='; // "hello-world"

const validImage = {
  kind: 'chart' as const,
  data: SAMPLE_BASE64,
  mediaType: 'image/png' as const,
};

function makeExtractionResponse(jsonBlock: string) {
  // Legacy text-only response shape — exercises the fallback path
  // (parseTrailingJsonBlock + JSON.parse). Retained because the
  // production code still hits it when no tool_use block lands.
  return {
    content: [{ type: 'text', text: jsonBlock }],
  };
}

function makeChartToolResponse(input: Record<string, unknown>) {
  // Primary tool_use response shape — Anthropic schema-validates
  // `input` so no JSON.parse occurs in the production code path.
  return {
    content: [
      {
        type: 'tool_use',
        id: 'toolu_test',
        name: 'emit_chart_extraction',
        input,
      },
    ],
  };
}

function makeHeatmapToolResponse(input: Record<string, unknown>) {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'toolu_test',
        name: 'emit_heatmap_extraction',
        input,
      },
    ],
  };
}

// The module no longer constructs its own Anthropic client; tests build
// a stub with the `messages.create` method we want to control.
const mockCreate = vi.fn();
const stubAnthropic = {
  messages: { create: mockCreate },
} as unknown as Anthropic;

beforeEach(() => {
  mockCreate.mockReset();
});

describe('extractChartStructure', () => {
  it('returns null when no images supplied', async () => {
    const result = await extractChartStructure({ images: [] }, stubAnthropic);
    expect(result).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('parses structured fields + chart_date from a clean JSON block', async () => {
    mockCreate.mockResolvedValueOnce(
      makeExtractionResponse(
        '```json\n{"chart_date": "2026-04-30", "spot": 7120, "cone_lower": 7095, "cone_upper": 7150}\n```',
      ),
    );
    const result = await extractChartStructure(
      { images: [validImage] },
      stubAnthropic,
    );
    expect(result).not.toBeNull();
    expect(result?.chartDate).toBe('2026-04-30');
    expect(result?.structured).toMatchObject({
      spot: 7120,
      cone_lower: 7095,
      cone_upper: 7150,
      long_trigger: null,
      short_trigger: null,
      regime_tag: null,
    });
    // Extract returns the empty playbook defaults — Pass 1 only reads
    // the chart's structural primitives, never the playbook fields.
    expect(result?.structured.trade_types_recommended).toEqual([]);
    expect(result?.structured.bias).toBeNull();
  });

  it('preserves prose then takes the LAST JSON block', async () => {
    mockCreate.mockResolvedValueOnce(
      makeExtractionResponse(
        'Some preamble text.\n\n' +
          '```json\n{"spot": 9999, "cone_lower": 0, "cone_upper": 0}\n```\n\n' +
          'Continuing prose.\n\n' +
          '```json\n{"chart_date": "2026-05-01", "spot": 7100, "cone_lower": 7080, "cone_upper": 7120}\n```',
      ),
    );
    const result = await extractChartStructure(
      { images: [validImage] },
      stubAnthropic,
    );
    expect(result?.structured.spot).toBe(7100);
    expect(result?.structured.cone_lower).toBe(7080);
    expect(result?.structured.cone_upper).toBe(7120);
    expect(result?.chartDate).toBe('2026-05-01');
  });

  it('coerces non-numeric fields to null', async () => {
    mockCreate.mockResolvedValueOnce(
      makeExtractionResponse(
        '```json\n{"spot": "unknown", "cone_lower": 7095, "cone_upper": 7150}\n```',
      ),
    );
    const result = await extractChartStructure(
      { images: [validImage] },
      stubAnthropic,
    );
    expect(result?.structured.spot).toBeNull();
    expect(result?.structured.cone_lower).toBe(7095);
  });

  it('rejects malformed chart_date but keeps the structured fields', async () => {
    mockCreate.mockResolvedValueOnce(
      makeExtractionResponse(
        '```json\n{"chart_date": "April 30 2026", "spot": 7120, "cone_lower": 7095, "cone_upper": 7150}\n```',
      ),
    );
    const result = await extractChartStructure(
      { images: [validImage] },
      stubAnthropic,
    );
    expect(result?.chartDate).toBeNull();
    expect(result?.structured.spot).toBe(7120);
  });

  it('returns null when all three fields are null (full failure)', async () => {
    mockCreate.mockResolvedValueOnce(
      makeExtractionResponse(
        '```json\n{"spot": null, "cone_lower": null, "cone_upper": null}\n```',
      ),
    );
    const result = await extractChartStructure(
      { images: [validImage] },
      stubAnthropic,
    );
    expect(result).toBeNull();
  });

  it('returns null when response has no JSON code block', async () => {
    mockCreate.mockResolvedValueOnce(
      makeExtractionResponse(
        'Just some prose without any structured block at all.',
      ),
    );
    const result = await extractChartStructure(
      { images: [validImage] },
      stubAnthropic,
    );
    expect(result).toBeNull();
  });

  it('returns null on malformed JSON inside the block', async () => {
    mockCreate.mockResolvedValueOnce(
      makeExtractionResponse('```json\n{spot: 7120,, cone_lower: 7095}\n```'),
    );
    const result = await extractChartStructure(
      { images: [validImage] },
      stubAnthropic,
    );
    expect(result).toBeNull();
  });

  it('returns null when Anthropic call throws', async () => {
    mockCreate.mockRejectedValueOnce(new Error('Network down'));
    const result = await extractChartStructure(
      { images: [validImage] },
      stubAnthropic,
    );
    expect(result).toBeNull();
  });

  it('prefers a chart-labeled image over heat maps', async () => {
    mockCreate.mockResolvedValueOnce(
      makeExtractionResponse(
        '```json\n{"spot": 7120, "cone_lower": 7095, "cone_upper": 7150}\n```',
      ),
    );
    const gexImage = { ...validImage, kind: 'gex' as const };
    const charmImage = { ...validImage, kind: 'charm' as const };
    const chartImage = { ...validImage, kind: 'chart' as const };
    await extractChartStructure(
      { images: [gexImage, charmImage, chartImage] },
      stubAnthropic,
    );
    expect(mockCreate).toHaveBeenCalledOnce();
    const callArgs = mockCreate.mock.calls[0]![0];
    const userContent = callArgs.messages[0].content;
    // First content block should be the chart image, not gex/charm
    expect(userContent[0].type).toBe('image');
    // We can't assert the exact image bytes (they're identical fixtures),
    // but we can assert there's exactly one image block in the call.
    const imageBlocks = userContent.filter(
      (b: { type: string }) => b.type === 'image',
    );
    expect(imageBlocks).toHaveLength(1);
  });

  it('uses Opus 4.7 with cached system prompt and no thinking config', async () => {
    mockCreate.mockResolvedValueOnce(
      makeExtractionResponse(
        '```json\n{"spot": 7120, "cone_lower": 7095, "cone_upper": 7150}\n```',
      ),
    );
    await extractChartStructure({ images: [validImage] }, stubAnthropic);
    const callArgs = mockCreate.mock.calls[0]![0];
    expect(callArgs.model).toBe('claude-opus-4-7');
    expect(callArgs.max_tokens).toBe(2048);
    expect(callArgs.system).toHaveLength(1);
    expect(callArgs.system[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
    // Single user message; no thinking / output_config — extraction is
    // mechanical, not reasoning. Tighter contract guards against drift.
    expect(callArgs.messages).toHaveLength(1);
    expect(callArgs.thinking).toBeUndefined();
    expect(callArgs.output_config).toBeUndefined();
  });
});

// ============================================================
// extractHeatMapStrikes (Pass 1B)
// ============================================================

describe('extractHeatMapStrikes', () => {
  const heatImage = {
    data: SAMPLE_BASE64,
    mediaType: 'image/png' as const,
  };

  it('returns null when neither image is provided', async () => {
    const result = await extractHeatMapStrikes({}, stubAnthropic);
    expect(result).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('parses gex + charm strikes from a clean response', async () => {
    mockCreate.mockResolvedValueOnce(
      makeExtractionResponse(
        '```json\n' +
          JSON.stringify({
            gex: [
              { strike: 7275, value: 1450000, color: 'green' },
              { strike: 7295, value: -1370000, color: 'red' },
            ],
            charm: [{ strike: 7240, value: 72521, color: 'green' }],
          }) +
          '\n```',
      ),
    );
    const result = await extractHeatMapStrikes(
      { gex: heatImage, charm: heatImage },
      stubAnthropic,
    );
    expect(result).not.toBeNull();
    expect(result?.gex).toHaveLength(2);
    expect(result?.gex[0]).toEqual({
      strike: 7275,
      value: 1450000,
      color: 'green',
    });
    expect(result?.charm).toHaveLength(1);
  });

  it('drops cells whose color contradicts the value sign', async () => {
    mockCreate.mockResolvedValueOnce(
      makeExtractionResponse(
        '```json\n' +
          JSON.stringify({
            gex: [
              // Contradiction: positive value labeled red.
              { strike: 7275, value: 100, color: 'red' },
              { strike: 7280, value: -200, color: 'red' },
            ],
            charm: [],
          }) +
          '\n```',
      ),
    );
    const result = await extractHeatMapStrikes(
      { gex: heatImage },
      stubAnthropic,
    );
    expect(result?.gex).toHaveLength(1);
    expect(result?.gex[0]?.strike).toBe(7280);
  });

  it('drops malformed cell entries', async () => {
    mockCreate.mockResolvedValueOnce(
      makeExtractionResponse(
        '```json\n' +
          JSON.stringify({
            gex: [
              { strike: 'not a number', value: 100, color: 'green' },
              { strike: 7275, color: 'green' }, // missing value
              { strike: 7280, value: 200 }, // missing color
              { strike: 7290, value: 300, color: 'blue' }, // bad color
              { strike: 7300, value: 400, color: 'green' }, // valid
            ],
            charm: [],
          }) +
          '\n```',
      ),
    );
    const result = await extractHeatMapStrikes(
      { gex: heatImage },
      stubAnthropic,
    );
    expect(result?.gex).toHaveLength(1);
    expect(result?.gex[0]?.strike).toBe(7300);
  });

  it('returns null when both arrays end up empty after coercion', async () => {
    mockCreate.mockResolvedValueOnce(
      makeExtractionResponse('```json\n{"gex": [], "charm": []}\n```'),
    );
    const result = await extractHeatMapStrikes(
      { gex: heatImage, charm: heatImage },
      stubAnthropic,
    );
    expect(result).toBeNull();
  });

  it('returns null when response has no JSON block', async () => {
    mockCreate.mockResolvedValueOnce(
      makeExtractionResponse('No structured block here at all.'),
    );
    const result = await extractHeatMapStrikes(
      { gex: heatImage },
      stubAnthropic,
    );
    expect(result).toBeNull();
  });

  it('returns null when Anthropic call throws', async () => {
    mockCreate.mockRejectedValueOnce(new Error('Network down'));
    const result = await extractHeatMapStrikes(
      { gex: heatImage },
      stubAnthropic,
    );
    expect(result).toBeNull();
  });

  it('only sends the provided heat-map image (gex only)', async () => {
    mockCreate.mockResolvedValueOnce(
      makeExtractionResponse(
        '```json\n{"gex": [{"strike": 7275, "value": 1, "color": "green"}], "charm": []}\n```',
      ),
    );
    await extractHeatMapStrikes({ gex: heatImage }, stubAnthropic);
    const callArgs = mockCreate.mock.calls[0]![0];
    const userContent = callArgs.messages[0].content as Array<{
      type: string;
    }>;
    const imageBlocks = userContent.filter((b) => b.type === 'image');
    expect(imageBlocks).toHaveLength(1);
  });

  it('uses Opus 4.7 with cached system prompt', async () => {
    mockCreate.mockResolvedValueOnce(
      makeExtractionResponse(
        '```json\n{"gex": [{"strike": 1, "value": 1, "color": "green"}], "charm": []}\n```',
      ),
    );
    await extractHeatMapStrikes({ gex: heatImage }, stubAnthropic);
    const callArgs = mockCreate.mock.calls[0]![0];
    expect(callArgs.model).toBe('claude-opus-4-7');
    expect(callArgs.system).toHaveLength(1);
    expect(callArgs.system[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
    expect(callArgs.thinking).toBeUndefined();
    expect(callArgs.output_config).toBeUndefined();
  });
});

// ============================================================
// tool_use channel — the primary path after the 2026-05-11 migration
// (eliminates the JSON.parse failure mode flagged in Sentry)
// ============================================================

describe('extractChartStructure — tool_use channel', () => {
  it('reads structured fields from a tool_use block (no JSON.parse path)', async () => {
    mockCreate.mockResolvedValueOnce(
      makeChartToolResponse({
        spot: 7120,
        cone_lower: 7095,
        cone_upper: 7150,
        chart_date: '2026-04-30',
      }),
    );
    const result = await extractChartStructure(
      { images: [validImage] },
      stubAnthropic,
    );
    expect(result).not.toBeNull();
    expect(result?.chartDate).toBe('2026-04-30');
    expect(result?.structured.spot).toBe(7120);
    expect(result?.structured.cone_lower).toBe(7095);
    expect(result?.structured.cone_upper).toBe(7150);
  });

  it('passes tools + tool_choice=auto on the Anthropic call', async () => {
    // tool_choice='auto' (not forced) — Anthropic disallows adaptive
    // thinking with forced tool_choice, and we want both.
    mockCreate.mockResolvedValueOnce(
      makeChartToolResponse({
        spot: 7120,
        cone_lower: 7095,
        cone_upper: 7150,
      }),
    );
    await extractChartStructure({ images: [validImage] }, stubAnthropic);
    const callArgs = mockCreate.mock.calls[0]![0]!;
    expect(callArgs.tool_choice).toEqual({ type: 'auto' });
    expect(callArgs.tools).toBeDefined();
    expect(callArgs.tools[0].name).toBe('emit_chart_extraction');
  });

  it('falls back to the text/JSON path when no tool_use block is present', async () => {
    // Defense-in-depth: forced tool_choice almost guarantees emission,
    // but if Claude somehow drops the tool the legacy fenced-JSON
    // parser runs as a safety net.
    mockCreate.mockResolvedValueOnce(
      makeExtractionResponse(
        '```json\n{"spot": 7120, "cone_lower": 7095, "cone_upper": 7150}\n```',
      ),
    );
    const result = await extractChartStructure(
      { images: [validImage] },
      stubAnthropic,
    );
    expect(result?.structured.spot).toBe(7120);
  });

  it('returns null when tool_use input has all fields null (model could not read chart)', async () => {
    mockCreate.mockResolvedValueOnce(
      makeChartToolResponse({
        spot: null,
        cone_lower: null,
        cone_upper: null,
        chart_date: null,
      }),
    );
    const result = await extractChartStructure(
      { images: [validImage] },
      stubAnthropic,
    );
    expect(result).toBeNull();
  });
});

describe('extractHeatMapStrikes — tool_use channel', () => {
  it('reads gex + charm arrays from tool_use input (no JSON.parse)', async () => {
    mockCreate.mockResolvedValueOnce(
      makeHeatmapToolResponse({
        gex: [
          { strike: 7100, value: 2_500_000, color: 'green' },
          { strike: 7050, value: -1_800_000, color: 'red' },
        ],
        charm: [{ strike: 7080, value: 900_000, color: 'green' }],
      }),
    );
    const result = await extractHeatMapStrikes(
      {
        gex: { data: SAMPLE_BASE64, mediaType: 'image/png' },
        charm: { data: SAMPLE_BASE64, mediaType: 'image/png' },
      },
      stubAnthropic,
    );
    expect(result).not.toBeNull();
    expect(result?.gex).toHaveLength(2);
    expect(result?.charm).toHaveLength(1);
    expect(result?.gex[0]).toMatchObject({ strike: 7100, color: 'green' });
  });

  it('drops cells whose color contradicts the value sign on the tool path', async () => {
    mockCreate.mockResolvedValueOnce(
      makeHeatmapToolResponse({
        gex: [
          { strike: 7100, value: 2_500_000, color: 'red' }, // mismatch — drop
          { strike: 7050, value: -1_800_000, color: 'red' }, // OK
        ],
        charm: [],
      }),
    );
    const result = await extractHeatMapStrikes(
      { gex: { data: SAMPLE_BASE64, mediaType: 'image/png' } },
      stubAnthropic,
    );
    expect(result?.gex).toHaveLength(1);
    expect(result?.gex[0]!.strike).toBe(7050);
  });

  it('passes tools + tool_choice=auto on the heat-map call', async () => {
    mockCreate.mockResolvedValueOnce(
      makeHeatmapToolResponse({
        gex: [{ strike: 7100, value: 2_500_000, color: 'green' }],
        charm: [],
      }),
    );
    await extractHeatMapStrikes(
      { gex: { data: SAMPLE_BASE64, mediaType: 'image/png' } },
      stubAnthropic,
    );
    const callArgs = mockCreate.mock.calls[0]![0]!;
    expect(callArgs.tool_choice).toEqual({ type: 'auto' });
    expect(callArgs.tools[0].name).toBe('emit_heatmap_extraction');
  });
});
