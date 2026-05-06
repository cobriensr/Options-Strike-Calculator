// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
  metrics: {
    request: vi.fn(() => vi.fn()),
    counter: vi.fn(),
    gauge: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  buildUserContent,
  parseStructuredFields,
  synthesizeStructuralProse,
} from '../_lib/periscope-prompts.js';

// ============================================================
// parseStructuredFields — block-finding is delegated to
// parseTrailingJsonBlock (covered exhaustively in
// json-fence.test.ts). These tests focus on field-coercion +
// parseOk wiring.
// ============================================================

describe('parseStructuredFields', () => {
  it('coerces fields and reports parseOk=true on a valid block', () => {
    const text = [
      'Setup at slice end: spot 5800.',
      '',
      'Some thesis text.',
      '',
      '```json',
      JSON.stringify(
        {
          spot: 5800,
          cone_lower: 5780,
          cone_upper: 5820,
          long_trigger: 5805,
          short_trigger: 5795,
          regime_tag: 'pin',
        },
        null,
        2,
      ),
      '```',
    ].join('\n');

    const { prose, structured, parseOk } = parseStructuredFields(text);

    expect(parseOk).toBe(true);
    expect(structured).toEqual({
      spot: 5800,
      cone_lower: 5780,
      cone_upper: 5820,
      long_trigger: 5805,
      short_trigger: 5795,
      regime_tag: 'pin',
    });
    // Block stripped, but prose body preserved.
    expect(prose).toContain('Setup at slice end: spot 5800.');
    expect(prose).toContain('Some thesis text.');
    expect(prose).not.toContain('```json');
    expect(prose).not.toMatch(/^```$/m);
  });

  it('returns null fields with parseOk=false and full prose when no JSON block is present', () => {
    const text = 'Just prose. No JSON.';
    const { prose, structured, parseOk } = parseStructuredFields(text);

    expect(parseOk).toBe(false);
    expect(prose).toBe(text);
    expect(structured).toEqual({
      spot: null,
      cone_lower: null,
      cone_upper: null,
      long_trigger: null,
      short_trigger: null,
      regime_tag: null,
    });
  });

  it('returns parseOk=false on malformed JSON inside the block', () => {
    const text = ['Prose.', '', '```json', '{ not real json', '```'].join('\n');

    const { prose, structured, parseOk } = parseStructuredFields(text);

    // Parse failure leaves prose unchanged so caller can recover.
    expect(parseOk).toBe(false);
    expect(prose).toBe(text);
    expect(structured.spot).toBeNull();
    expect(structured.regime_tag).toBeNull();
  });

  it('coerces non-numeric and empty-string fields to null', () => {
    const text = [
      '```json',
      '{"spot": "not a number", "cone_lower": null, "cone_upper": null, "long_trigger": null, "short_trigger": null, "regime_tag": ""}',
      '```',
    ].join('\n');

    const { structured, parseOk } = parseStructuredFields(text);

    expect(parseOk).toBe(true);
    // String "not a number" → not a number → null.
    expect(structured.spot).toBeNull();
    // Empty regime_tag becomes null (length === 0 guard).
    expect(structured.regime_tag).toBeNull();
  });
});

// ============================================================
// synthesizeStructuralProse
// ============================================================

describe('synthesizeStructuralProse', () => {
  it('emits an empty string when nothing is set', () => {
    expect(
      synthesizeStructuralProse({
        spot: null,
        cone_lower: null,
        cone_upper: null,
        long_trigger: null,
        short_trigger: null,
        regime_tag: null,
      }),
    ).toBe('');
  });

  it('emits spot only when only spot is known', () => {
    const out = synthesizeStructuralProse({
      spot: 5800,
      cone_lower: null,
      cone_upper: null,
      long_trigger: null,
      short_trigger: null,
      regime_tag: null,
    });
    expect(out).toBe('0DTE SPX Periscope read with spot at 5800.');
  });

  it('emits the bounded cone when both cone bounds are present', () => {
    const out = synthesizeStructuralProse({
      spot: 5800,
      cone_lower: 5780,
      cone_upper: 5820,
      long_trigger: null,
      short_trigger: null,
      regime_tag: null,
    });
    expect(out).toBe(
      '0DTE SPX Periscope read with spot at 5800 and the 0DTE straddle cone bounded between 5780 and 5820.',
    );
  });

  it('emits a single-sided cone when only one bound is present', () => {
    const lowerOnly = synthesizeStructuralProse({
      spot: null,
      cone_lower: 5780,
      cone_upper: null,
      long_trigger: null,
      short_trigger: null,
      regime_tag: null,
    });
    expect(lowerOnly).toContain('cone lower bound at 5780');

    const upperOnly = synthesizeStructuralProse({
      spot: null,
      cone_lower: null,
      cone_upper: 5820,
      long_trigger: null,
      short_trigger: null,
      regime_tag: null,
    });
    expect(upperOnly).toContain('cone upper bound at 5820');
  });
});

// ============================================================
// buildUserContent
// ============================================================

describe('buildUserContent', () => {
  it('emits the read-mode preamble + image blocks', () => {
    const blocks = buildUserContent({
      mode: 'read',
      parentId: null,
      images: [
        {
          kind: 'chart',
          data: 'AAA',
          mediaType: 'image/png',
        },
      ],
    });

    // First block is a text block with the read-mode preamble.
    expect(blocks[0]).toMatchObject({ type: 'text' });
    const preamble = (blocks[0] as { type: 'text'; text: string }).text;
    expect(preamble).toContain('Mode: read');
    expect(preamble).toContain('YOU ARE IN READ MODE');
    // No parent line when parentId is null.
    expect(preamble).not.toContain('Parent read id');

    // Then the chart label + image block.
    expect(blocks[1]).toMatchObject({ type: 'text' });
    expect((blocks[1] as { type: 'text'; text: string }).text).toBe(
      '[chart screenshot]',
    );
    expect(blocks[2]).toMatchObject({ type: 'image' });
  });

  it('includes the parent id when set', () => {
    const blocks = buildUserContent({
      mode: 'debrief',
      parentId: 42,
      images: [],
    });
    const preamble = (blocks[0] as { type: 'text'; text: string }).text;
    expect(preamble).toContain('Parent read id: 42');
    expect(preamble).toContain('YOU ARE IN DEBRIEF MODE');
  });

  it('inlines parent prose + structured fields into the debrief preamble when parentRead is supplied', () => {
    const blocks = buildUserContent({
      mode: 'debrief',
      parentId: 42,
      parentRead: {
        id: 42,
        mode: 'read',
        tradingDate: '2026-05-01',
        proseText:
          'Open read at 8:30 CT — pin day. Long trigger 7150, short trigger 7115.',
        structured: {
          spot: 7140,
          cone_lower: 7092,
          cone_upper: 7163,
          long_trigger: 7150,
          short_trigger: 7115,
          regime_tag: 'trap',
        },
      },
      images: [],
    });

    const preamble = (blocks[0] as { type: 'text'; text: string }).text;
    expect(preamble).toContain('Mode: debrief');
    expect(preamble).toContain('Parent read id: 42');
    expect(preamble).toContain('Open read to score (id 42, 2026-05-01)');
    expect(preamble).toContain('- spot: 7140');
    expect(preamble).toContain('- cone: 7092 – 7163');
    expect(preamble).toContain('- long trigger: 7150');
    expect(preamble).toContain('- short trigger: 7115');
    expect(preamble).toContain('- regime: trap');
    expect(preamble).toContain(
      'Open read at 8:30 CT — pin day. Long trigger 7150, short trigger 7115.',
    );
  });

  it('omits the parent block in debrief mode when parentRead is null', () => {
    const blocks = buildUserContent({
      mode: 'debrief',
      parentId: 42,
      parentRead: null,
      images: [],
    });
    const preamble = (blocks[0] as { type: 'text'; text: string }).text;
    expect(preamble).toContain('YOU ARE IN DEBRIEF MODE');
    expect(preamble).not.toContain('Open read to score');
  });

  it('renders n/a for null structured fields in the parent block', () => {
    const blocks = buildUserContent({
      mode: 'debrief',
      parentId: 1,
      parentRead: {
        id: 1,
        mode: 'read',
        tradingDate: '2026-05-01',
        proseText: '',
        structured: {
          spot: null,
          cone_lower: null,
          cone_upper: null,
          long_trigger: null,
          short_trigger: null,
          regime_tag: null,
        },
      },
      images: [],
    });
    const preamble = (blocks[0] as { type: 'text'; text: string }).text;
    expect(preamble).toContain('- spot: n/a');
    expect(preamble).toContain('- cone: n/a – n/a');
    expect(preamble).toContain('- regime: n/a');
    expect(preamble).toContain('(no prose recorded)');
  });

  it('emits one [kind screenshot] label per image', () => {
    const blocks = buildUserContent({
      mode: 'read',
      parentId: null,
      images: [
        { kind: 'chart', data: 'A', mediaType: 'image/png' },
        { kind: 'gex', data: 'B', mediaType: 'image/jpeg' },
        { kind: 'charm', data: 'C', mediaType: 'image/webp' },
      ],
    });

    const labels = blocks
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text);

    expect(labels).toContain('[chart screenshot]');
    expect(labels).toContain('[gex screenshot]');
    expect(labels).toContain('[charm screenshot]');
  });
});
