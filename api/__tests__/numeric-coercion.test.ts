// @vitest-environment node

/**
 * Unit tests for api/_lib/numeric-coercion.ts (Phase 1d).
 *
 * Covers every input branch in numOrNull/parsedOrFallback/requireNumber:
 *   - number (finite + non-finite)
 *   - bigint (Postgres COUNT)
 *   - string (numeric, empty, whitespace, NaN-text)
 *   - null / undefined
 *   - non-coercible (object, boolean) → null
 */

import { describe, it, expect } from 'vitest';
import {
  numOrNull,
  parsedOrFallback,
  requireNumber,
} from '../_lib/numeric-coercion.js';

describe('numOrNull', () => {
  it('returns null for null / undefined', () => {
    expect(numOrNull(null)).toBeNull();
    expect(numOrNull(undefined)).toBeNull();
  });

  it('passes finite numbers through', () => {
    expect(numOrNull(0)).toBe(0);
    expect(numOrNull(42)).toBe(42);
    expect(numOrNull(-3.14)).toBe(-3.14);
    expect(numOrNull(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('returns null for non-finite numbers', () => {
    expect(numOrNull(Number.NaN)).toBeNull();
    expect(numOrNull(Number.POSITIVE_INFINITY)).toBeNull();
    expect(numOrNull(Number.NEGATIVE_INFINITY)).toBeNull();
  });

  it('coerces BigInt via Number() (Postgres COUNT case)', () => {
    expect(numOrNull(0n)).toBe(0);
    expect(numOrNull(1234567n)).toBe(1234567);
    expect(numOrNull(-99n)).toBe(-99);
  });

  it('parses numeric strings (incl. trimmed)', () => {
    expect(numOrNull('0')).toBe(0);
    expect(numOrNull('42')).toBe(42);
    expect(numOrNull('-3.14')).toBe(-3.14);
    expect(numOrNull('  7.5  ')).toBe(7.5);
    expect(numOrNull('1e3')).toBe(1000);
  });

  it('returns null for empty / whitespace-only strings', () => {
    expect(numOrNull('')).toBeNull();
    expect(numOrNull('   ')).toBeNull();
  });

  it('returns null for non-numeric strings', () => {
    expect(numOrNull('abc')).toBeNull();
    expect(numOrNull('NaN')).toBeNull();
    expect(numOrNull('5.5x')).toBeNull();
  });

  it('returns null for non-coercible types', () => {
    expect(numOrNull({})).toBeNull();
    expect(numOrNull([])).toBeNull(); // [] coerces to 0 via Number, but we drop array path
    expect(numOrNull(true)).toBeNull();
    expect(numOrNull(false)).toBeNull();
    expect(numOrNull(Symbol('x'))).toBeNull();
  });
});

describe('parsedOrFallback', () => {
  it('returns parsed value when input is coercible', () => {
    expect(parsedOrFallback('5.5', 0)).toBe(5.5);
    expect(parsedOrFallback(7n, 0)).toBe(7);
    expect(parsedOrFallback(0, -1)).toBe(0);
  });

  it('returns fallback for null / undefined / NaN / Infinity', () => {
    expect(parsedOrFallback(null, 0)).toBe(0);
    expect(parsedOrFallback(undefined, 99)).toBe(99);
    expect(parsedOrFallback(Number.NaN, -1)).toBe(-1);
    expect(parsedOrFallback(Number.POSITIVE_INFINITY, -1)).toBe(-1);
  });

  it('returns fallback for empty / non-numeric strings', () => {
    expect(parsedOrFallback('', 42)).toBe(42);
    expect(parsedOrFallback('abc', 42)).toBe(42);
  });
});

describe('requireNumber', () => {
  it('returns parsed value for coercible inputs', () => {
    expect(requireNumber('3.14', 'pi')).toBe(3.14);
    expect(requireNumber(42n, 'count')).toBe(42);
    expect(requireNumber(0, 'zero')).toBe(0);
  });

  it('throws with the label embedded for null', () => {
    expect(() => requireNumber(null, 'price')).toThrow(/price/);
  });

  it('throws for non-finite / non-numeric strings', () => {
    expect(() => requireNumber(Number.NaN, 'x')).toThrow(/x/);
    expect(() => requireNumber('abc', 'y')).toThrow(/y/);
    expect(() => requireNumber('', 'z')).toThrow(/z/);
  });

  it('error message describes the rejected value', () => {
    expect(() => requireNumber('abc', 'field')).toThrow(/abc/);
    expect(() => requireNumber(null, 'field')).toThrow(/null/);
    expect(() => requireNumber(undefined, 'field')).toThrow(/undefined/);
  });
});
