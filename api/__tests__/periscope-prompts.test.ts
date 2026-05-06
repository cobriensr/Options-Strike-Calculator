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
  formatParentChainBlock,
  parseStructuredFields,
  synthesizeStructuralProse,
} from '../_lib/periscope-prompts.js';
import type { PeriscopeStructuredFields } from '../_lib/periscope-db.js';

/** Build a PeriscopeStructuredFields with a few overrides — the rest null/[]. */
function fields(
  overrides: Partial<PeriscopeStructuredFields> = {},
): PeriscopeStructuredFields {
  return {
    spot: null,
    cone_lower: null,
    cone_upper: null,
    long_trigger: null,
    short_trigger: null,
    regime_tag: null,
    bias: null,
    trade_types_recommended: [],
    trade_types_avoided: [],
    key_levels: null,
    expected_dealer_behavior: null,
    confidence: null,
    confidence_basis: null,
    ...overrides,
  };
}

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
    expect(structured.spot).toBe(5800);
    expect(structured.cone_lower).toBe(5780);
    expect(structured.cone_upper).toBe(5820);
    expect(structured.long_trigger).toBe(5805);
    expect(structured.short_trigger).toBe(5795);
    expect(structured.regime_tag).toBe('pin');
    // New playbook fields default to null/[] when the model doesn't emit them.
    expect(structured.bias).toBeNull();
    expect(structured.trade_types_recommended).toEqual([]);
    expect(structured.trade_types_avoided).toEqual([]);
    expect(structured.key_levels).toBeNull();
    expect(structured.confidence).toBeNull();
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
    expect(structured.spot).toBeNull();
    expect(structured.regime_tag).toBeNull();
    expect(structured.bias).toBeNull();
    expect(structured.trade_types_recommended).toEqual([]);
    expect(structured.trade_types_avoided).toEqual([]);
    expect(structured.key_levels).toBeNull();
    expect(structured.confidence).toBeNull();
  });

  it('coerces playbook fields and rejects unknown enum values', () => {
    const text = [
      '```json',
      JSON.stringify({
        spot: 7250,
        cone_lower: 7240,
        cone_upper: 7270,
        long_trigger: 7255,
        short_trigger: 7245,
        regime_tag: 'pin',
        bias: 'fade-only',
        trade_types_recommended: ['iron_condor', 'butterfly'],
        trade_types_avoided: ['naked_directional_long'],
        key_levels: {
          gamma_floor: 7250,
          gamma_ceiling: 7270,
          magnet: 7260,
          charm_zero: 7265,
        },
        expected_dealer_behavior: 'passive bid below 7250',
        confidence: 'medium',
        confidence_basis: 'twin-strike +γ floor confirmed',
      }),
      '```',
    ].join('\n');

    const { structured, parseOk } = parseStructuredFields(text);
    expect(parseOk).toBe(true);
    expect(structured.bias).toBe('fade-only');
    expect(structured.trade_types_recommended).toEqual([
      'iron_condor',
      'butterfly',
    ]);
    expect(structured.trade_types_avoided).toEqual(['naked_directional_long']);
    expect(structured.key_levels).toEqual({
      gamma_floor: 7250,
      gamma_ceiling: 7270,
      magnet: 7260,
      charm_zero: 7265,
    });
    expect(structured.expected_dealer_behavior).toBe('passive bid below 7250');
    expect(structured.confidence).toBe('medium');
    expect(structured.confidence_basis).toBe(
      'twin-strike +γ floor confirmed',
    );
  });

  it('drops out-of-enum values for bias and confidence rather than throwing', () => {
    const text = [
      '```json',
      JSON.stringify({
        bias: 'unknown-bias',
        confidence: 'medium-high',
        trade_types_recommended: 'not-an-array',
        key_levels: { magnet: 'not-a-number' },
      }),
      '```',
    ].join('\n');
    const { structured, parseOk } = parseStructuredFields(text);
    expect(parseOk).toBe(true);
    expect(structured.bias).toBeNull();
    expect(structured.confidence).toBeNull();
    expect(structured.trade_types_recommended).toEqual([]);
    expect(structured.key_levels).toBeNull();
  });

  it('returns parseOk=false on malformed JSON inside the block', () => {
    const text = ['Prose.', '', '```json', '{ not real json', '```'].join('\n');

    const { prose, structured, parseOk } = parseStructuredFields(text);

    // Parse failure leaves prose unchanged so caller can recover.
    expect(parseOk).toBe(false);
    expect(prose).toBe(text);
    expect(structured.spot).toBeNull();
    expect(structured.regime_tag).toBeNull();
    expect(structured.bias).toBeNull();
    expect(structured.trade_types_recommended).toEqual([]);
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
    expect(synthesizeStructuralProse(fields())).toBe('');
  });

  it('emits spot only when only spot is known', () => {
    const out = synthesizeStructuralProse(fields({ spot: 5800 }));
    expect(out).toBe('0DTE SPX Periscope read with spot at 5800.');
  });

  it('emits the bounded cone when both cone bounds are present', () => {
    const out = synthesizeStructuralProse(
      fields({ spot: 5800, cone_lower: 5780, cone_upper: 5820 }),
    );
    expect(out).toBe(
      '0DTE SPX Periscope read with spot at 5800 and the 0DTE straddle cone bounded between 5780 and 5820.',
    );
  });

  it('emits a single-sided cone when only one bound is present', () => {
    const lowerOnly = synthesizeStructuralProse(fields({ cone_lower: 5780 }));
    expect(lowerOnly).toContain('cone lower bound at 5780');

    const upperOnly = synthesizeStructuralProse(fields({ cone_upper: 5820 }));
    expect(upperOnly).toContain('cone upper bound at 5820');
  });
});

// ============================================================
// buildUserContent
// ============================================================

describe('buildUserContent', () => {
  it('emits the intraday-mode preamble + image blocks', () => {
    const blocks = buildUserContent({
      mode: 'intraday',
      parentId: null,
      images: [
        {
          kind: 'chart',
          data: 'AAA',
          mediaType: 'image/png',
        },
      ],
    });

    // First block is a text block with the intraday-mode preamble.
    expect(blocks[0]).toMatchObject({ type: 'text' });
    const preamble = (blocks[0] as { type: 'text'; text: string }).text;
    expect(preamble).toContain('Mode: intraday');
    expect(preamble).toContain('YOU ARE IN INTRADAY MODE');
    // No parent line when parentId is null.
    expect(preamble).not.toContain('Parent read id');

    // Then the chart label + image block.
    expect(blocks[1]).toMatchObject({ type: 'text' });
    expect((blocks[1] as { type: 'text'; text: string }).text).toBe(
      '[chart screenshot]',
    );
    expect(blocks[2]).toMatchObject({ type: 'image' });
  });

  it('emits the pre_trade preamble (no parent context, forward-looking)', () => {
    const blocks = buildUserContent({
      mode: 'pre_trade',
      parentId: null,
      images: [],
    });
    const preamble = (blocks[0] as { type: 'text'; text: string }).text;
    expect(preamble).toContain('Mode: pre_trade');
    expect(preamble).toContain('YOU ARE IN PRE-TRADE MODE');
    // pre_trade ignores parent chain entirely — no chain block.
    const chainBlock = blocks.find(
      (b) =>
        b.type === 'text' &&
        typeof (b as { type: 'text'; text: string }).text === 'string' &&
        (b as { type: 'text'; text: string }).text.includes('Parent chain'),
    );
    expect(chainBlock).toBeUndefined();
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
        mode: 'intraday',
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
          bias: null,
          trade_types_recommended: [],
          trade_types_avoided: [],
          key_levels: null,
          expected_dealer_behavior: null,
          confidence: null,
          confidence_basis: null,
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
        mode: 'intraday',
        tradingDate: '2026-05-01',
        proseText: '',
        structured: {
          spot: null,
          cone_lower: null,
          cone_upper: null,
          long_trigger: null,
          short_trigger: null,
          regime_tag: null,
          bias: null,
          trade_types_recommended: [],
          trade_types_avoided: [],
          key_levels: null,
          expected_dealer_behavior: null,
          confidence: null,
          confidence_basis: null,
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
      mode: 'intraday',
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

  it('injects the parent-chain block for intraday between header and images', () => {
    const blocks = buildUserContent({
      mode: 'intraday',
      parentId: 5,
      parentChain: [
        {
          id: 1,
          mode: 'pre_trade',
          regime_tag: 'pin',
          bias: 'fade-only',
          prose_excerpt: 'Pre-open: pin day at 7150.',
          structured: {
            spot: 7150,
            cone_lower: 7130,
            cone_upper: 7170,
            long_trigger: 7155,
            short_trigger: 7145,
          },
        },
        {
          id: 5,
          mode: 'intraday',
          regime_tag: 'pin',
          bias: 'fade-only',
          prose_excerpt: 'Intraday 1: still pinned.',
          structured: {
            spot: 7152,
            cone_lower: 7130,
            cone_upper: 7170,
            long_trigger: 7155,
            short_trigger: 7145,
          },
        },
      ],
      images: [],
    });
    const chainBlock = blocks.find(
      (b) =>
        b.type === 'text' &&
        typeof (b as { type: 'text'; text: string }).text === 'string' &&
        (b as { type: 'text'; text: string }).text.includes('Parent chain'),
    ) as { type: 'text'; text: string } | undefined;
    expect(chainBlock).toBeDefined();
    expect(chainBlock!.text).toContain('mode=pre_trade');
    expect(chainBlock!.text).toContain('Pre-open: pin day at 7150.');
    expect(chainBlock!.text).toContain('Intraday 1: still pinned.');
  });
});

// ============================================================
// formatParentChainBlock
// ============================================================

describe('formatParentChainBlock', () => {
  it('returns null when chain is empty or null', () => {
    expect(formatParentChainBlock(null)).toBeNull();
    expect(formatParentChainBlock([])).toBeNull();
  });

  it('renders mode + regime + bias + excerpt per ancestor', () => {
    const out = formatParentChainBlock([
      {
        id: 1,
        mode: 'pre_trade',
        regime_tag: 'drift-and-cap',
        bias: 'long-only',
        prose_excerpt: 'Morning playbook.',
        structured: {
          spot: 5800,
          cone_lower: null,
          cone_upper: null,
          long_trigger: null,
          short_trigger: null,
        },
      },
    ]);
    expect(out).not.toBeNull();
    expect(out!).toContain('Parent chain');
    expect(out!).toContain('mode=pre_trade');
    expect(out!).toContain('regime=drift-and-cap');
    expect(out!).toContain('bias=long-only');
    expect(out!).toContain('Morning playbook.');
  });
});
