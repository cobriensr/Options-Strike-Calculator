import { describe, it, expect } from 'vitest';
import { resolveContractSymbol } from '../contract-roller.js';

describe('resolveContractSymbol', () => {
  // ES rolls quarterly: H(Mar), M(Jun), U(Sep), Z(Dec)
  // Roll happens ~7 days before 3rd Friday of expiry month

  it('returns ESM6 in early April 2026 (June is next expiry)', () => {
    expect(resolveContractSymbol(new Date('2026-04-15'))).toBe('ESM6');
  });

  it('returns ESU6 in early July 2026 (September is next expiry)', () => {
    expect(resolveContractSymbol(new Date('2026-07-01'))).toBe('ESU6');
  });

  it('returns ESZ6 in early October 2026 (December is next expiry)', () => {
    expect(resolveContractSymbol(new Date('2026-10-15'))).toBe('ESZ6');
  });

  it('returns ESH7 in early January 2027 (March 2027 is next expiry)', () => {
    expect(resolveContractSymbol(new Date('2027-01-10'))).toBe('ESH7');
  });

  it('rolls to next quarter within 7 days of expiry', () => {
    // June 2026 expiry: 3rd Friday = June 19, 2026
    // 7 days before = June 12
    // On June 13 (within 7 days), should roll to ESU6
    expect(resolveContractSymbol(new Date('2026-06-13'))).toBe('ESU6');
  });

  it('stays on current quarter when > 7 days from expiry', () => {
    // On June 10 (>7 days before June 19), still ESM6
    expect(resolveContractSymbol(new Date('2026-06-10'))).toBe('ESM6');
  });
});
