// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
  metrics: { request: vi.fn(() => vi.fn()), increment: vi.fn() },
}));

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    get messages() {
      return { create: mockCreate };
    }
  }
  return { default: MockAnthropic };
});

import { extractChartStructure } from '../_lib/periscope-extract.js';

const SAMPLE_BASE64 = 'aGVsbG8td29ybGQ='; // "hello-world"

const validImage = {
  kind: 'chart' as const,
  data: SAMPLE_BASE64,
  mediaType: 'image/png' as const,
};

function makeExtractionResponse(jsonBlock: string) {
  return {
    content: [{ type: 'text', text: jsonBlock }],
  };
}

beforeEach(() => {
  mockCreate.mockReset();
});

describe('extractChartStructure', () => {
  it('returns null when no images supplied', async () => {
    const result = await extractChartStructure({ images: [] });
    expect(result).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('parses spot + cone from a clean JSON block', async () => {
    mockCreate.mockResolvedValueOnce(
      makeExtractionResponse(
        '```json\n{"spot": 7120, "cone_lower": 7095, "cone_upper": 7150}\n```',
      ),
    );
    const result = await extractChartStructure({ images: [validImage] });
    expect(result).not.toBeNull();
    expect(result).toEqual({
      spot: 7120,
      cone_lower: 7095,
      cone_upper: 7150,
      long_trigger: null,
      short_trigger: null,
      regime_tag: null,
    });
  });

  it('preserves prose then takes the LAST JSON block', async () => {
    mockCreate.mockResolvedValueOnce(
      makeExtractionResponse(
        'Some preamble text.\n\n' +
          '```json\n{"spot": 9999, "cone_lower": 0, "cone_upper": 0}\n```\n\n' +
          'Continuing prose.\n\n' +
          '```json\n{"spot": 7100, "cone_lower": 7080, "cone_upper": 7120}\n```',
      ),
    );
    const result = await extractChartStructure({ images: [validImage] });
    expect(result?.spot).toBe(7100);
    expect(result?.cone_lower).toBe(7080);
    expect(result?.cone_upper).toBe(7120);
  });

  it('coerces non-numeric fields to null', async () => {
    mockCreate.mockResolvedValueOnce(
      makeExtractionResponse(
        '```json\n{"spot": "unknown", "cone_lower": 7095, "cone_upper": 7150}\n```',
      ),
    );
    const result = await extractChartStructure({ images: [validImage] });
    expect(result?.spot).toBeNull();
    expect(result?.cone_lower).toBe(7095);
  });

  it('returns null when all three fields are null (full failure)', async () => {
    mockCreate.mockResolvedValueOnce(
      makeExtractionResponse(
        '```json\n{"spot": null, "cone_lower": null, "cone_upper": null}\n```',
      ),
    );
    const result = await extractChartStructure({ images: [validImage] });
    expect(result).toBeNull();
  });

  it('returns null when response has no JSON code block', async () => {
    mockCreate.mockResolvedValueOnce(
      makeExtractionResponse(
        'Just some prose without any structured block at all.',
      ),
    );
    const result = await extractChartStructure({ images: [validImage] });
    expect(result).toBeNull();
  });

  it('returns null on malformed JSON inside the block', async () => {
    mockCreate.mockResolvedValueOnce(
      makeExtractionResponse('```json\n{spot: 7120,, cone_lower: 7095}\n```'),
    );
    const result = await extractChartStructure({ images: [validImage] });
    expect(result).toBeNull();
  });

  it('returns null when Anthropic call throws', async () => {
    mockCreate.mockRejectedValueOnce(new Error('Network down'));
    const result = await extractChartStructure({ images: [validImage] });
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
    await extractChartStructure({ images: [gexImage, charmImage, chartImage] });
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
    await extractChartStructure({ images: [validImage] });
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
