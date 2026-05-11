// @vitest-environment node

/**
 * Unit tests for api/_lib/validation/common.ts.
 *
 * Covers:
 *   - guestKeySchema (POST /api/auth/guest-key body)
 *   - alertAckSchema (POST /api/alerts-ack body)
 *   - num / str / bool nullable-optional zod helpers
 *
 * One valid + one invalid case per schema, plus boundary cases for the
 * bounded fields (string length on key, integer positivity on id).
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  guestKeySchema,
  alertAckSchema,
  num,
  str,
  bool,
} from '../../_lib/validation/common.js';

// ── guestKeySchema ───────────────────────────────────────────

describe('guestKeySchema', () => {
  it('parses valid input', () => {
    const result = guestKeySchema.safeParse({ key: 'abcdefgh' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.key).toBe('abcdefgh');
  });

  it('rejects invalid input — wrong type for key', () => {
    const result = guestKeySchema.safeParse({ key: 12345678 });
    expect(result.success).toBe(false);
  });

  it('rejects key shorter than 8 chars (boundary)', () => {
    const result = guestKeySchema.safeParse({ key: 'abcdefg' });
    expect(result.success).toBe(false);
  });

  it('accepts key exactly at the 128 char upper bound', () => {
    const key = 'x'.repeat(128);
    const result = guestKeySchema.safeParse({ key });
    expect(result.success).toBe(true);
  });

  it('rejects key longer than 128 chars (boundary)', () => {
    const key = 'x'.repeat(129);
    const result = guestKeySchema.safeParse({ key });
    expect(result.success).toBe(false);
  });
});

// ── alertAckSchema ───────────────────────────────────────────

describe('alertAckSchema', () => {
  it('parses valid input', () => {
    const result = alertAckSchema.safeParse({ id: 42 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.id).toBe(42);
  });

  it('rejects invalid input — negative id', () => {
    const result = alertAckSchema.safeParse({ id: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer id (boundary)', () => {
    const result = alertAckSchema.safeParse({ id: 1.5 });
    expect(result.success).toBe(false);
  });

  it('rejects zero id (positive-only boundary)', () => {
    const result = alertAckSchema.safeParse({ id: 0 });
    expect(result.success).toBe(false);
  });
});

// ── num / str / bool helpers ─────────────────────────────────

describe('num helper', () => {
  // Wrap in a small object so we can exercise the .optional() behavior
  // on a real schema, mirroring how snapshotBodySchema uses it.
  const wrap = z.object({ v: num });

  it('parses a real number', () => {
    const result = wrap.safeParse({ v: 1.23 });
    expect(result.success).toBe(true);
  });

  it('parses null (nullable-optional behavior)', () => {
    const result = wrap.safeParse({ v: null });
    expect(result.success).toBe(true);
  });

  it('parses missing key (optional)', () => {
    const result = wrap.safeParse({});
    expect(result.success).toBe(true);
  });

  it('rejects non-numeric value', () => {
    const result = wrap.safeParse({ v: 'not a number' });
    expect(result.success).toBe(false);
  });
});

describe('str helper', () => {
  const wrap = z.object({ v: str });

  it('parses a string', () => {
    const result = wrap.safeParse({ v: 'hello' });
    expect(result.success).toBe(true);
  });

  it('parses null', () => {
    const result = wrap.safeParse({ v: null });
    expect(result.success).toBe(true);
  });

  it('parses missing key', () => {
    const result = wrap.safeParse({});
    expect(result.success).toBe(true);
  });

  it('rejects non-string value', () => {
    const result = wrap.safeParse({ v: 123 });
    expect(result.success).toBe(false);
  });
});

describe('bool helper', () => {
  const wrap = z.object({ v: bool });

  it('parses true', () => {
    const result = wrap.safeParse({ v: true });
    expect(result.success).toBe(true);
  });

  it('parses false', () => {
    const result = wrap.safeParse({ v: false });
    expect(result.success).toBe(true);
  });

  it('parses null', () => {
    const result = wrap.safeParse({ v: null });
    expect(result.success).toBe(true);
  });

  it('rejects truthy non-boolean value', () => {
    const result = wrap.safeParse({ v: 'true' });
    expect(result.success).toBe(false);
  });
});
