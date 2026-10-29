import { describe, it, expect } from 'vitest';
import {
  MULTI_LEG_TRADE_CODES,
  STOCK_TIED_TRADE_CODES,
  legKindForTradeCode,
} from '../_lib/multileg-codes.js';

const MULTI = [
  'mlat',
  'mlet',
  'mlft',
  'masl',
  'mesl',
  'mfsl',
  'mlct',
  'cbmo',
  'mctp',
];
const STOCK_TIED = ['tlet', 'tlat', 'tlft', 'tlct', 'tesl', 'tasl', 'tfsl'];

describe('multileg-codes', () => {
  it('lists exactly the OPRA multi-leg codes', () => {
    expect([...MULTI_LEG_TRADE_CODES].sort()).toEqual([...MULTI].sort());
  });

  it('lists exactly the stock-tied codes', () => {
    expect([...STOCK_TIED_TRADE_CODES].sort()).toEqual([...STOCK_TIED].sort());
  });

  it('never includes the nonexistent mfto code', () => {
    expect(MULTI_LEG_TRADE_CODES).not.toContain('mfto');
    expect(STOCK_TIED_TRADE_CODES).not.toContain('mfto');
  });

  it.each(MULTI)('classifies %s as multi_leg', (code) => {
    expect(legKindForTradeCode(code)).toBe('multi_leg');
  });

  it.each(STOCK_TIED)('classifies %s as stock_tied', (code) => {
    expect(legKindForTradeCode(code)).toBe('stock_tied');
  });

  it('is case-insensitive', () => {
    expect(legKindForTradeCode('MLET')).toBe('multi_leg');
    expect(legKindForTradeCode('TLAT')).toBe('stock_tied');
  });

  it('treats unlisted codes (including mfto) as single', () => {
    expect(legKindForTradeCode('auto')).toBe('single');
    expect(legKindForTradeCode('mfto')).toBe('single');
  });

  it('returns null for null, undefined and empty', () => {
    expect(legKindForTradeCode(null)).toBeNull();
    expect(legKindForTradeCode(undefined)).toBeNull();
    expect(legKindForTradeCode('')).toBeNull();
  });
});
