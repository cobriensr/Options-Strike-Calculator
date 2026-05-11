// @vitest-environment node

/**
 * Unit tests for api/_lib/validation/periscope.ts.
 *
 * Covers the 7 periscope* schemas plus boundary cases on the bounded
 * fields (per-image 10MB cap, combined 30MB cap, debrief/intraday
 * parentId guard).
 */

import { describe, it, expect } from 'vitest';
import {
  periscopeImageSchema,
  periscopeChatBodySchema,
  periscopeChatListQuerySchema,
  periscopeChatDetailQuerySchema,
  periscopeChatImageQuerySchema,
  periscopeChatUpdateBodySchema,
  periscopeLessonsUpdateBodySchema,
} from '../../_lib/validation/periscope.js';

const MB = 1024 * 1024;

// ── periscopeImageSchema ─────────────────────────────────────

describe('periscopeImageSchema', () => {
  it('parses valid input', () => {
    const result = periscopeImageSchema.safeParse({
      kind: 'chart',
      data: 'YWJj',
      mediaType: 'image/png',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid input — bad kind enum', () => {
    const result = periscopeImageSchema.safeParse({
      kind: 'levels',
      data: 'YWJj',
      mediaType: 'image/png',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty data', () => {
    const result = periscopeImageSchema.safeParse({
      kind: 'chart',
      data: '',
      mediaType: 'image/png',
    });
    expect(result.success).toBe(false);
  });

  it('rejects image data exceeding 10MB (boundary)', () => {
    const result = periscopeImageSchema.safeParse({
      kind: 'chart',
      data: 'x'.repeat(10 * MB + 1),
      mediaType: 'image/png',
    });
    expect(result.success).toBe(false);
  });

  it('accepts data exactly at the 10MB cap', () => {
    const result = periscopeImageSchema.safeParse({
      kind: 'chart',
      data: 'x'.repeat(10 * MB),
      mediaType: 'image/png',
    });
    expect(result.success).toBe(true);
  });
});

// ── periscopeChatBodySchema ──────────────────────────────────

describe('periscopeChatBodySchema', () => {
  const baseImage = {
    kind: 'chart' as const,
    data: 'YWJj',
    mediaType: 'image/png' as const,
  };

  it('parses valid pre_trade with no images', () => {
    const result = periscopeChatBodySchema.safeParse({
      mode: 'pre_trade',
      images: [],
      read_date: '2026-05-10',
      read_time: '08:35',
    });
    expect(result.success).toBe(true);
  });

  it('parses valid pre_trade with 3 images', () => {
    const result = periscopeChatBodySchema.safeParse({
      mode: 'pre_trade',
      images: [
        baseImage,
        { ...baseImage, kind: 'gex' },
        { ...baseImage, kind: 'charm' },
      ],
      read_date: '2026-05-10',
      read_time: '08:35',
    });
    expect(result.success).toBe(true);
  });

  it('rejects more than 3 images (boundary)', () => {
    const result = periscopeChatBodySchema.safeParse({
      mode: 'pre_trade',
      images: [baseImage, baseImage, baseImage, baseImage],
      read_date: '2026-05-10',
      read_time: '08:35',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid read_date format', () => {
    const result = periscopeChatBodySchema.safeParse({
      mode: 'pre_trade',
      images: [],
      read_date: '05/10/2026',
      read_time: '08:35',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid read_time format', () => {
    const result = periscopeChatBodySchema.safeParse({
      mode: 'pre_trade',
      images: [],
      read_date: '2026-05-10',
      read_time: '8:35',
    });
    expect(result.success).toBe(false);
  });

  it('rejects debrief mode without parentId', () => {
    const result = periscopeChatBodySchema.safeParse({
      mode: 'debrief',
      images: [],
      read_date: '2026-05-10',
      read_time: '15:00',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue?.path).toEqual(['parentId']);
      expect(issue?.message).toBe(
        'Debrief mode requires a parent read id. Run a morning read first, then click "Debrief this" on it.',
      );
    }
  });

  it('rejects intraday mode without parentId', () => {
    const result = periscopeChatBodySchema.safeParse({
      mode: 'intraday',
      images: [],
      read_date: '2026-05-10',
      read_time: '11:00',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue?.path).toEqual(['parentId']);
      expect(issue?.message).toBe(
        "Intraday mode requires a parent read id (today's pre-trade or the last intraday).",
      );
    }
  });

  it('accepts intraday mode with parentId', () => {
    const result = periscopeChatBodySchema.safeParse({
      mode: 'intraday',
      parentId: 12,
      images: [],
      read_date: '2026-05-10',
      read_time: '11:00',
    });
    expect(result.success).toBe(true);
  });

  it('accepts combined image size at exactly 30MB (boundary)', () => {
    // 3 × 10MB = 30MB total — equals the combined cap, so .refine()'s
    // `total <= 30MB` predicate is satisfied. (The combined cap is
    // technically unreachable while honoring the 3-image / 10MB-each
    // limits; this test pins that behavior so any future change to
    // either cap surfaces explicitly.)
    const bigImage = {
      ...baseImage,
      data: 'x'.repeat(10 * MB),
    };
    const result = periscopeChatBodySchema.safeParse({
      mode: 'pre_trade',
      images: [bigImage, bigImage, bigImage],
      read_date: '2026-05-10',
      read_time: '08:35',
    });
    expect(result.success).toBe(true);
  });
});

// ── periscopeChatListQuerySchema ─────────────────────────────

describe('periscopeChatListQuerySchema', () => {
  it('parses valid input with defaults', () => {
    const result = periscopeChatListQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(20);
  });

  it('coerces string limit', () => {
    const result = periscopeChatListQuerySchema.safeParse({ limit: '50' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(50);
  });

  it('rejects limit > 100 (boundary)', () => {
    const result = periscopeChatListQuerySchema.safeParse({ limit: 101 });
    expect(result.success).toBe(false);
  });

  it('rejects malformed date', () => {
    const result = periscopeChatListQuerySchema.safeParse({ date: 'today' });
    expect(result.success).toBe(false);
  });
});

// ── periscopeChatDetailQuerySchema ───────────────────────────

describe('periscopeChatDetailQuerySchema', () => {
  it('parses valid input (string coerced to number)', () => {
    const result = periscopeChatDetailQuerySchema.safeParse({ id: '7' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.id).toBe(7);
  });

  it('rejects non-positive id', () => {
    const result = periscopeChatDetailQuerySchema.safeParse({ id: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects missing id', () => {
    const result = periscopeChatDetailQuerySchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ── periscopeChatImageQuerySchema ────────────────────────────

describe('periscopeChatImageQuerySchema', () => {
  it('parses valid input', () => {
    const result = periscopeChatImageQuerySchema.safeParse({
      id: 1,
      kind: 'gex',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown extra keys (strict)', () => {
    const result = periscopeChatImageQuerySchema.safeParse({
      id: 1,
      kind: 'gex',
      extra: 'oops',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid kind enum', () => {
    const result = periscopeChatImageQuerySchema.safeParse({
      id: 1,
      kind: 'positions',
    });
    expect(result.success).toBe(false);
  });
});

// ── periscopeChatUpdateBodySchema ────────────────────────────

describe('periscopeChatUpdateBodySchema', () => {
  it('parses valid calibration_quality only', () => {
    const result = periscopeChatUpdateBodySchema.safeParse({
      calibration_quality: 5,
    });
    expect(result.success).toBe(true);
  });

  it('parses valid regime_tag only', () => {
    const result = periscopeChatUpdateBodySchema.safeParse({
      regime_tag: 'pin',
    });
    expect(result.success).toBe(true);
  });

  it('parses valid clear array', () => {
    const result = periscopeChatUpdateBodySchema.safeParse({
      clear: ['regime_tag', 'calibration_quality'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects calibration_quality > 5 (boundary)', () => {
    const result = periscopeChatUpdateBodySchema.safeParse({
      calibration_quality: 6,
    });
    expect(result.success).toBe(false);
  });

  it('rejects calibration_quality < 1 (boundary)', () => {
    const result = periscopeChatUpdateBodySchema.safeParse({
      calibration_quality: 0,
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown regime_tag enum value', () => {
    const result = periscopeChatUpdateBodySchema.safeParse({
      regime_tag: 'fubar',
    });
    expect(result.success).toBe(false);
  });
});

// ── periscopeLessonsUpdateBodySchema ─────────────────────────

describe('periscopeLessonsUpdateBodySchema', () => {
  it('parses valid input', () => {
    const result = periscopeLessonsUpdateBodySchema.safeParse({
      id: 3,
      action: 'promote',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown action', () => {
    const result = periscopeLessonsUpdateBodySchema.safeParse({
      id: 3,
      action: 'delete',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-positive id', () => {
    const result = periscopeLessonsUpdateBodySchema.safeParse({
      id: 0,
      action: 'archive',
    });
    expect(result.success).toBe(false);
  });
});
