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
  formatHeatMapBlock,
  formatParentChainBlock,
  parseStructuredFields,
  parseStructuredFieldsFromToolInput,
  STRUCTURED_TOOL,
  STRUCTURED_TOOL_NAME,
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
    futures_plan: null,
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
    expect(structured.confidence_basis).toBe('twin-strike +γ floor confirmed');
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

  // ── futures_plan round-trip ────────────────────────────────────
  // Generic LONG/SHORT/WAIT directional-execution string for the
  // user's directional futures trades. Coerced like other string
  // fields: present-and-non-empty → keep, missing/empty/non-string → null.

  it('extracts a well-formed futures_plan string', () => {
    const futuresPlan = [
      'LONG: avoid until SPX reclaims 7,265 — heavy −γ at 7,250 will accelerate any dip.',
      '',
      'SHORT: setup is cleaner. Below 7,250, no +γ floor between spot and ~7,210.',
      '',
      'WAIT: 7,250–7,265.',
    ].join('\n');
    const text = [
      '```json',
      JSON.stringify({
        spot: 7255,
        futures_plan: futuresPlan,
      }),
      '```',
    ].join('\n');
    const { structured, parseOk } = parseStructuredFields(text);
    expect(parseOk).toBe(true);
    expect(structured.futures_plan).toBe(futuresPlan);
  });

  it('returns null futures_plan when the field is missing', () => {
    const text = [
      '```json',
      JSON.stringify({ spot: 7255, regime_tag: 'pin' }),
      '```',
    ].join('\n');
    const { structured, parseOk } = parseStructuredFields(text);
    expect(parseOk).toBe(true);
    expect(structured.futures_plan).toBeNull();
  });

  it('returns null futures_plan when the field is an empty string', () => {
    const text = ['```json', '{"futures_plan": ""}', '```'].join('\n');
    const { structured, parseOk } = parseStructuredFields(text);
    expect(parseOk).toBe(true);
    expect(structured.futures_plan).toBeNull();
  });

  it('returns null futures_plan when the field is a non-string value', () => {
    const text = [
      '```json',
      JSON.stringify({ futures_plan: { not: 'a string' } }),
      '```',
    ].join('\n');
    const { structured, parseOk } = parseStructuredFields(text);
    expect(parseOk).toBe(true);
    expect(structured.futures_plan).toBeNull();
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
// parseStructuredFieldsFromToolInput — tool_use channel (Sentry "Bad
// control character" fix, 2026-05-11)
// ============================================================

describe('parseStructuredFieldsFromToolInput', () => {
  it('coerces a well-formed tool_use input identically to the JSON-block path', () => {
    const toolInput = {
      spot: 5912.34,
      cone_lower: 5880,
      cone_upper: 5945,
      long_trigger: 5920,
      short_trigger: 5900,
      regime_tag: 'pinning',
      bias: 'two-sided',
      trade_types_recommended: ['IC', 'BWB'],
      trade_types_avoided: ['naked-call'],
      key_levels: {
        gamma_floor: 5895,
        gamma_ceiling: 5925,
        magnet: 5910,
        charm_zero: 5905,
      },
      expected_dealer_behavior: 'suppressive',
      confidence: 'medium',
      confidence_basis: 'cone width small',
      futures_plan: 'LONG: SAFE above 5920',
    };
    const { prose, structured, parseOk } = parseStructuredFieldsFromToolInput(
      toolInput,
      'narrative prose',
    );
    expect(parseOk).toBe(true);
    expect(prose).toBe('narrative prose');
    expect(structured.spot).toBe(5912.34);
    expect(structured.bias).toBe('two-sided');
    expect(structured.confidence).toBe('medium');
    expect(structured.key_levels).toEqual({
      gamma_floor: 5895,
      gamma_ceiling: 5925,
      magnet: 5910,
      charm_zero: 5905,
    });
    expect(structured.trade_types_recommended).toEqual(['IC', 'BWB']);
  });

  it('handles multi-line / control-character prose fields — the failure mode the tool channel solves', () => {
    // This input would have caused JSON.parse to throw "Bad control
    // character in string literal in JSON" via the legacy fenced-block
    // path. The tool_use channel hands us an already-parsed object, so
    // newlines / tabs inside string fields are preserved verbatim.
    const toolInput = {
      expected_dealer_behavior:
        'Suppressive bid at +γ floor.\n\nPassive offer at -γ ceiling.\tWatch charm tally for shift.',
      futures_plan: 'LONG: cap at 7390\nSHORT: floor at 7350',
      regime_tag: 'drift-and-cap',
      bias: 'long-only',
      confidence: 'high',
    };
    const { structured, parseOk } = parseStructuredFieldsFromToolInput(
      toolInput,
      'prose',
    );
    expect(parseOk).toBe(true);
    expect(structured.expected_dealer_behavior).toContain('\n\n');
    expect(structured.expected_dealer_behavior).toContain('\t');
    expect(structured.futures_plan).toContain('\n');
  });

  it('returns parseOk=false with empty structured when tool input is null', () => {
    const { structured, parseOk } = parseStructuredFieldsFromToolInput(
      null,
      'prose',
    );
    expect(parseOk).toBe(false);
    expect(structured.spot).toBeNull();
    expect(structured.trade_types_recommended).toEqual([]);
  });

  it('returns parseOk=false when tool input is not an object', () => {
    const { parseOk } = parseStructuredFieldsFromToolInput('garbage', 'prose');
    expect(parseOk).toBe(false);
  });

  it('coerces enum mismatches to null without throwing', () => {
    const { structured, parseOk } = parseStructuredFieldsFromToolInput(
      { bias: 'sideways', confidence: 'extreme' },
      'prose',
    );
    expect(parseOk).toBe(true);
    expect(structured.bias).toBeNull();
    expect(structured.confidence).toBeNull();
  });
});

describe('STRUCTURED_TOOL definition', () => {
  it('has the documented tool name', () => {
    expect(STRUCTURED_TOOL.name).toBe(STRUCTURED_TOOL_NAME);
    expect(STRUCTURED_TOOL_NAME).toBe('emit_playbook_structured');
  });

  it('declares an input_schema with the expected properties', () => {
    const schema = STRUCTURED_TOOL.input_schema as Record<string, unknown>;
    expect(schema.type).toBe('object');
    const props = schema.properties as Record<string, unknown>;
    for (const key of [
      'spot',
      'cone_lower',
      'cone_upper',
      'long_trigger',
      'short_trigger',
      'regime_tag',
      'bias',
      'trade_types_recommended',
      'trade_types_avoided',
      'key_levels',
      'expected_dealer_behavior',
      'confidence',
      'confidence_basis',
      'futures_plan',
    ]) {
      expect(props[key]).toBeDefined();
    }
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
          futures_plan: null,
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
          futures_plan: null,
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

// ============================================================
// formatHeatMapBlock + formatSigned
// formatSigned is NOT exported — it is tested indirectly through
// formatHeatMapBlock, which is its sole call site.
// ============================================================

describe('formatHeatMapBlock', () => {
  it('returns null when both gex and charm arrays are empty', () => {
    expect(formatHeatMapBlock({ gex: [], charm: [] })).toBeNull();
  });

  it('emits only the Net GEX section when charm is empty', () => {
    const out = formatHeatMapBlock({
      gex: [{ strike: 7250, value: 1500 }],
      charm: [],
    });
    expect(out).not.toBeNull();
    expect(out!).toContain(
      '[Heat-map extracted strikes (MM-attributed Net GEX / Net Charm from UW)]',
    );
    expect(out!).toContain('Net GEX (top strikes by absolute value):');
    // The literal phrase "Net Charm" appears in the always-present
    // header line; assert the Net Charm SECTION header is absent.
    expect(out!).not.toContain('Net Charm (top strikes by absolute value):');
  });

  it('emits only the Net Charm section when gex is empty', () => {
    const out = formatHeatMapBlock({
      gex: [],
      charm: [{ strike: 7260, value: -2000 }],
    });
    expect(out).not.toBeNull();
    expect(out!).toContain(
      '[Heat-map extracted strikes (MM-attributed Net GEX / Net Charm from UW)]',
    );
    expect(out!).toContain('Net Charm (top strikes by absolute value):');
    // Likewise — header line mentions "Net GEX"; assert the section
    // header is absent.
    expect(out!).not.toContain('Net GEX (top strikes by absolute value):');
  });

  it('emits both sections with a blank line between when both are populated', () => {
    const out = formatHeatMapBlock({
      gex: [{ strike: 7250, value: 1500 }],
      charm: [{ strike: 7260, value: -2000 }],
    });
    expect(out).not.toBeNull();
    // Both section headers present.
    expect(out!).toContain('Net GEX (top strikes by absolute value):');
    expect(out!).toContain('Net Charm (top strikes by absolute value):');
    // Blank line between sections (the line just before the Net Charm
    // header must be empty).
    const lines = out!.split('\n');
    const charmIdx = lines.findIndex((l) => l.startsWith('Net Charm'));
    expect(charmIdx).toBeGreaterThan(0);
    expect(lines[charmIdx - 1]).toBe('');
  });

  it('uses the exact header line for the heat-map block', () => {
    const out = formatHeatMapBlock({
      gex: [{ strike: 7250, value: 1 }],
      charm: [],
    });
    const firstLine = out!.split('\n')[0];
    expect(firstLine).toBe(
      '[Heat-map extracted strikes (MM-attributed Net GEX / Net Charm from UW)]',
    );
  });

  it('renders strike lines with 2-space indent and "{strike}: {signed-value}" form', () => {
    const out = formatHeatMapBlock({
      gex: [{ strike: 7250, value: 1500 }],
      charm: [],
    });
    expect(out!).toContain('  7250: +1,500');
  });

  it('prefixes positive numbers with + via formatSigned', () => {
    const out = formatHeatMapBlock({
      gex: [{ strike: 7250, value: 1234567 }],
      charm: [],
    });
    expect(out!).toContain('  7250: +1,234,567');
  });

  it('renders negative numbers with a leading minus from toLocaleString', () => {
    const out = formatHeatMapBlock({
      gex: [{ strike: 7260, value: -2500 }],
      charm: [],
    });
    expect(out!).toContain('  7260: -2,500');
    // No `+` prefix on negatives.
    expect(out!).not.toContain('+-');
  });

  it('renders zero as bare "0" (no leading + or -)', () => {
    const out = formatHeatMapBlock({
      gex: [{ strike: 7250, value: 0 }],
      charm: [],
    });
    expect(out!).toContain('  7250: 0');
    // Strike line must not gain a sign prefix on zero.
    const lines = out!.split('\n');
    const strikeLine = lines.find((l) => l.startsWith('  7250:'));
    expect(strikeLine).toBe('  7250: 0');
  });

  it('emits one strike line per entry in input order', () => {
    const out = formatHeatMapBlock({
      gex: [
        { strike: 7250, value: 1500 },
        { strike: 7260, value: 800 },
      ],
      charm: [
        { strike: 7240, value: -300 },
        { strike: 7270, value: 450 },
      ],
    });
    const lines = out!.split('\n');
    const gexLines = lines.filter((l) => /^ {2}\d+:/.test(l));
    expect(gexLines).toEqual([
      '  7250: +1,500',
      '  7260: +800',
      '  7240: -300',
      '  7270: +450',
    ]);
  });
});

// ============================================================
// buildUserContent — uncovered branches:
//  - spotDirective injection (line 133)
//  - heatMapBlock injection (line 149)
//  - flowBlock injection (line 156)
// The default switch arm (line 119/120) is an unreachable
// exhaustive-check; covering it requires a deliberate cast,
// which we exercise below.
// ============================================================

describe('buildUserContent — optional text block injections', () => {
  it('injects the spotDirective text block after the header', () => {
    const blocks = buildUserContent({
      mode: 'intraday',
      parentId: null,
      spotDirective: 'Authoritative spot: 7,250.42 (db_exact).',
      images: [],
    });
    // First block is the header preamble; second should be the spot
    // directive (no chain or heat-map / flow blocks were passed).
    expect(blocks[1]).toMatchObject({
      type: 'text',
      text: 'Authoritative spot: 7,250.42 (db_exact).',
    });
  });

  it('skips the spotDirective block when the string is empty', () => {
    const blocks = buildUserContent({
      mode: 'intraday',
      parentId: null,
      spotDirective: '',
      images: [],
    });
    // Header is block 0; no other text blocks should follow.
    expect(blocks).toHaveLength(1);
  });

  it('injects the heatMapBlock text block when supplied', () => {
    const blocks = buildUserContent({
      mode: 'intraday',
      parentId: null,
      heatMapBlock: '[Heat-map extracted strikes …]\n  7250: +1,500',
      images: [],
    });
    const hasHeatMap = blocks.some(
      (b) =>
        b.type === 'text' &&
        (b as { type: 'text'; text: string }).text.includes(
          '[Heat-map extracted strikes',
        ),
    );
    expect(hasHeatMap).toBe(true);
  });

  it('skips the heatMapBlock block when the string is empty', () => {
    const blocks = buildUserContent({
      mode: 'intraday',
      parentId: null,
      heatMapBlock: '',
      images: [],
    });
    const hasHeatMap = blocks.some(
      (b) =>
        b.type === 'text' &&
        (b as { type: 'text'; text: string }).text.includes(
          'Heat-map extracted',
        ),
    );
    expect(hasHeatMap).toBe(false);
  });

  it('injects the flowBlock text block when supplied', () => {
    const blocks = buildUserContent({
      mode: 'intraday',
      parentId: null,
      flowBlock: '[Informed flow context]\nAAPL 2026-05-30 250C swept...',
      images: [],
    });
    const hasFlow = blocks.some(
      (b) =>
        b.type === 'text' &&
        (b as { type: 'text'; text: string }).text.includes(
          '[Informed flow context]',
        ),
    );
    expect(hasFlow).toBe(true);
  });

  it('skips the flowBlock block when the string is empty', () => {
    const blocks = buildUserContent({
      mode: 'intraday',
      parentId: null,
      flowBlock: '',
      images: [],
    });
    const hasFlow = blocks.some(
      (b) =>
        b.type === 'text' &&
        (b as { type: 'text'; text: string }).text.includes(
          'Informed flow context',
        ),
    );
    expect(hasFlow).toBe(false);
  });

  it('emits spotDirective, heatMapBlock, and flowBlock in that order before images', () => {
    const blocks = buildUserContent({
      mode: 'intraday',
      parentId: null,
      spotDirective: 'SPOT_DIRECTIVE_MARKER',
      heatMapBlock: 'HEAT_MAP_MARKER',
      flowBlock: 'FLOW_MARKER',
      images: [{ kind: 'chart', data: 'AAA', mediaType: 'image/png' }],
    });
    const textBlocks = blocks
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text);
    const spotIdx = textBlocks.findIndex((t) => t === 'SPOT_DIRECTIVE_MARKER');
    const heatIdx = textBlocks.findIndex((t) => t === 'HEAT_MAP_MARKER');
    const flowIdx = textBlocks.findIndex((t) => t === 'FLOW_MARKER');
    const chartIdx = textBlocks.findIndex((t) => t === '[chart screenshot]');
    expect(spotIdx).toBeGreaterThan(-1);
    expect(heatIdx).toBeGreaterThan(spotIdx);
    expect(flowIdx).toBeGreaterThan(heatIdx);
    expect(chartIdx).toBeGreaterThan(flowIdx);
  });

  it('throws on an unknown mode (exhaustive-check default arm)', () => {
    expect(() =>
      buildUserContent({
        // Intentional cast: forces the unreachable default arm
        // (line 119-120) to fire so the throw is covered.
        mode: 'made_up_mode' as unknown as 'pre_trade',
        parentId: null,
        images: [],
      }),
    ).toThrow(/Unknown periscope mode: made_up_mode/);
  });
});
