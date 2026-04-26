import { describe, expect, it } from 'vitest';
import { buildTraceLiveUserContent } from '../_lib/trace-live-context.js';
import type { TraceLiveAnalyzeBody } from '../_lib/trace-live-types.js';

const tinyPng = 'iVBORw0KGgo='; // not a real PNG, just a base64 sentinel

const body: TraceLiveAnalyzeBody = {
  capturedAt: '2026-04-23T19:30:00Z',
  spot: 6005,
  stabilityPct: 67,
  etTimeLabel: '15:30 ET',
  images: [
    {
      chart: 'gamma',
      slot: 'close',
      capturedAt: '2026-04-23T19:30:00Z',
      mediaType: 'image/png',
      data: tinyPng,
    },
    {
      chart: 'charm',
      slot: 'close',
      capturedAt: '2026-04-23T19:30:00Z',
      mediaType: 'image/png',
      data: tinyPng,
    },
    {
      chart: 'delta',
      slot: 'close',
      capturedAt: '2026-04-23T19:30:00Z',
      mediaType: 'image/png',
      data: tinyPng,
    },
  ],
  gex: {
    regime: 'positive_gamma',
    atmStrike: 6005,
    strikes: [
      { strike: 6005, dollarGamma: 5.5e9, charm: -1e8 },
      { strike: 6000, dollarGamma: 0.5e9, charm: 1e7 },
    ],
  },
};

describe('buildTraceLiveUserContent', () => {
  it('emits blocks in the canonical order: session → GEX → label/image trio → closing instruction', () => {
    const blocks = buildTraceLiveUserContent(body);
    // 1 session text + 1 GEX text + (1 label + 1 image) × 3 charts + 1 closing text = 9
    expect(blocks).toHaveLength(9);
    expect(blocks[0]!.type).toBe('text');
    expect((blocks[0] as { text: string }).text).toContain('SESSION CONTEXT');
    expect((blocks[1] as { text: string }).text).toContain('GEX LANDSCAPE');
    // Gamma label (text) → gamma image
    expect((blocks[2] as { text: string }).text).toContain('Gamma Heatmap');
    expect(blocks[3]!.type).toBe('image');
    // Charm label → charm image
    expect((blocks[4] as { text: string }).text).toContain(
      'Charm Pressure Heatmap',
    );
    expect(blocks[5]!.type).toBe('image');
    // Delta label → delta image
    expect((blocks[6] as { text: string }).text).toContain(
      'Delta Pressure Heatmap',
    );
    expect(blocks[7]!.type).toBe('image');
    // Closing instruction
    expect((blocks[8] as { text: string }).text).toContain(
      'override hierarchy',
    );
  });

  it('orders charts gamma → charm → delta regardless of input order', () => {
    const reordered: TraceLiveAnalyzeBody = {
      ...body,
      images: [body.images[2]!, body.images[0]!, body.images[1]!], // delta, gamma, charm
    };
    const blocks = buildTraceLiveUserContent(reordered);
    expect((blocks[2] as { text: string }).text).toContain('Gamma');
    expect((blocks[4] as { text: string }).text).toContain('Charm');
    expect((blocks[6] as { text: string }).text).toContain('Delta');
  });

  it('skips charts that are not present in the payload', () => {
    const onlyGamma: TraceLiveAnalyzeBody = {
      ...body,
      images: [body.images[0]!],
    };
    const blocks = buildTraceLiveUserContent(onlyGamma);
    // session + gex + (label + image) for gamma + closing = 5
    expect(blocks).toHaveLength(5);
    const labelBlock = blocks.find(
      (b) =>
        b.type === 'text' && (b as { text: string }).text.includes('Heatmap'),
    );
    expect((labelBlock as { text: string }).text).toContain('Gamma Heatmap');
  });

  it('passes through media_type and base64 data on image blocks', () => {
    const blocks = buildTraceLiveUserContent(body);
    const imageBlock = blocks[3] as {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
    };
    expect(imageBlock.source.media_type).toBe('image/png');
    expect(imageBlock.source.data).toBe(tinyPng);
  });
});
