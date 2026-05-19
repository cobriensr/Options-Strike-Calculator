import { describe, expect, it } from 'vitest';

import {
  boolPersistOpts,
  convictionFloorPersistOpts,
  floatPersistOpts,
  intPersistOpts,
  isConvictionFloor,
  isMoneynessMode,
  moneynessPersistOpts,
} from '../persist-encoding';

describe('persist-encoding', () => {
  describe('boolPersistOpts', () => {
    it('parses "1" as true and everything else as false', () => {
      expect(boolPersistOpts.parse!('1')).toBe(true);
      expect(boolPersistOpts.parse!('0')).toBe(false);
      expect(boolPersistOpts.parse!('true')).toBe(false);
      expect(boolPersistOpts.parse!('')).toBe(false);
    });

    it('serializes booleans as "1"/"0"', () => {
      expect(boolPersistOpts.serialize!(true)).toBe('1');
      expect(boolPersistOpts.serialize!(false)).toBe('0');
    });
  });

  describe('intPersistOpts', () => {
    it('parses valid non-negative integers', () => {
      expect(intPersistOpts.parse!('0')).toBe(0);
      expect(intPersistOpts.parse!('42')).toBe(42);
      expect(intPersistOpts.parse!('100')).toBe(100);
    });

    it('drops leading decimals via parseInt', () => {
      expect(intPersistOpts.parse!('42.7')).toBe(42);
    });

    it('falls back to defaultValue on negative or NaN', () => {
      expect(intPersistOpts.parse!('-5')).toBeUndefined();
      expect(intPersistOpts.parse!('not-a-number')).toBeUndefined();
      expect(intPersistOpts.parse!('')).toBeUndefined();
    });

    it('serializes numbers via String coercion', () => {
      expect(intPersistOpts.serialize!(0)).toBe('0');
      expect(intPersistOpts.serialize!(42)).toBe('42');
    });
  });

  describe('floatPersistOpts', () => {
    it('parses finite floats including negatives', () => {
      expect(floatPersistOpts.parse!('0.5')).toBe(0.5);
      expect(floatPersistOpts.parse!('1.25')).toBe(1.25);
      expect(floatPersistOpts.parse!('-0.5')).toBe(-0.5);
    });

    it('falls back on NaN / Infinity / empty', () => {
      expect(floatPersistOpts.parse!('Infinity')).toBeUndefined();
      expect(floatPersistOpts.parse!('not-a-number')).toBeUndefined();
      expect(floatPersistOpts.parse!('')).toBeUndefined();
    });

    it('serializes floats via String coercion', () => {
      expect(floatPersistOpts.serialize!(0.5)).toBe('0.5');
      expect(floatPersistOpts.serialize!(1.25)).toBe('1.25');
    });
  });

  describe('moneynessPersistOpts', () => {
    it('parses allowed enum values', () => {
      expect(moneynessPersistOpts.parse!('all')).toBe('all');
      expect(moneynessPersistOpts.parse!('otm')).toBe('otm');
      expect(moneynessPersistOpts.parse!('itm')).toBe('itm');
    });

    it('returns undefined for invalid values', () => {
      expect(moneynessPersistOpts.parse!('other')).toBeUndefined();
      expect(moneynessPersistOpts.parse!('')).toBeUndefined();
    });

    it('serializes enum verbatim', () => {
      expect(moneynessPersistOpts.serialize!('all')).toBe('all');
      expect(moneynessPersistOpts.serialize!('otm')).toBe('otm');
      expect(moneynessPersistOpts.serialize!('itm')).toBe('itm');
    });
  });

  describe('isMoneynessMode', () => {
    it('narrows to the moneyness union', () => {
      expect(isMoneynessMode('all')).toBe(true);
      expect(isMoneynessMode('otm')).toBe(true);
      expect(isMoneynessMode('itm')).toBe(true);
      expect(isMoneynessMode(null)).toBe(false);
      expect(isMoneynessMode(undefined)).toBe(false);
      expect(isMoneynessMode('foo')).toBe(false);
      expect(isMoneynessMode(42)).toBe(false);
    });
  });

  describe('convictionFloorPersistOpts', () => {
    it('parses allowed tier values', () => {
      expect(convictionFloorPersistOpts.parse!('all')).toBe('all');
      expect(convictionFloorPersistOpts.parse!('tier1')).toBe('tier1');
      expect(convictionFloorPersistOpts.parse!('tier2')).toBe('tier2');
    });

    it('returns undefined for invalid values', () => {
      expect(convictionFloorPersistOpts.parse!('tier3')).toBeUndefined();
      expect(convictionFloorPersistOpts.parse!('')).toBeUndefined();
    });

    it('serializes verbatim', () => {
      expect(convictionFloorPersistOpts.serialize!('tier1')).toBe('tier1');
      expect(convictionFloorPersistOpts.serialize!('all')).toBe('all');
    });
  });

  describe('isConvictionFloor', () => {
    it('narrows correctly', () => {
      expect(isConvictionFloor('all')).toBe(true);
      expect(isConvictionFloor('tier1')).toBe(true);
      expect(isConvictionFloor('tier2')).toBe(true);
      expect(isConvictionFloor('tier3')).toBe(false);
      expect(isConvictionFloor(null)).toBe(false);
      expect(isConvictionFloor(42)).toBe(false);
    });
  });
});
