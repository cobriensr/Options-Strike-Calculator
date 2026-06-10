// @vitest-environment node

/**
 * Unit tests for api/_lib/validation/lottery.ts.
 *
 * Covers the 5 lottery/silent-boom schemas plus boundary cases on the
 * bounded fields (limit/offset caps, score ranges, regex shapes).
 */

import { describe, it, expect } from 'vitest';
import {
  lotteryFinderQuerySchema,
  silentBoomFeedQuerySchema,
  silentBoomExportQuerySchema,
  lotteryExportQuerySchema,
  lotteryContractTapeQuerySchema,
  lotteryFinderTickerCountsQuerySchema,
  silentBoomTickerCountsQuerySchema,
} from '../../_lib/validation/lottery.js';

// ── lotteryFinderQuerySchema ─────────────────────────────────

describe('lotteryFinderQuerySchema', () => {
  it('parses valid input with defaults', () => {
    const result = lotteryFinderQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
      expect(result.data.offset).toBe(0);
      expect(result.data.sort).toBe('chronological');
    }
  });

  it('transforms reload="true" to boolean true', () => {
    const result = lotteryFinderQuerySchema.safeParse({ reload: 'true' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.reload).toBe(true);
  });

  it('transforms reload="false" to boolean false', () => {
    const result = lotteryFinderQuerySchema.safeParse({ reload: 'false' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.reload).toBe(false);
  });

  it('rejects ticker exceeding 8 chars (boundary)', () => {
    const result = lotteryFinderQuerySchema.safeParse({
      ticker: 'TOOLONGSTRING',
    });
    expect(result.success).toBe(false);
  });

  it('rejects limit > 200 (boundary)', () => {
    const result = lotteryFinderQuerySchema.safeParse({ limit: 201 });
    expect(result.success).toBe(false);
  });

  it('rejects negative offset (boundary)', () => {
    const result = lotteryFinderQuerySchema.safeParse({ offset: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects unknown sort value', () => {
    const result = lotteryFinderQuerySchema.safeParse({ sort: 'volume' });
    expect(result.success).toBe(false);
  });

  it('rejects minScore > 50 (boundary)', () => {
    const result = lotteryFinderQuerySchema.safeParse({ minScore: 51 });
    expect(result.success).toBe(false);
  });

  it('parses maxFireCount from a 2-digit string (coerces to int)', () => {
    const result = lotteryFinderQuerySchema.safeParse({ maxFireCount: '12' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.maxFireCount).toBe(12);
  });

  it('parses maxFireCount=1 (boundary, min cap)', () => {
    const result = lotteryFinderQuerySchema.safeParse({ maxFireCount: '1' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.maxFireCount).toBe(1);
  });

  it('omits maxFireCount when absent (optional)', () => {
    const result = lotteryFinderQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.maxFireCount).toBeUndefined();
  });

  it('rejects maxFireCount below 1 (Zod min(1))', () => {
    const result = lotteryFinderQuerySchema.safeParse({ maxFireCount: '0' });
    expect(result.success).toBe(false);
  });

  it('rejects maxFireCount above 1000 (Zod max(1000))', () => {
    const result = lotteryFinderQuerySchema.safeParse({ maxFireCount: '1001' });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer maxFireCount', () => {
    const result = lotteryFinderQuerySchema.safeParse({ maxFireCount: '3.5' });
    expect(result.success).toBe(false);
  });
});

// ── lotteryFinderTickerCountsQuerySchema ─────────────────────

describe('lotteryFinderTickerCountsQuerySchema', () => {
  it('parses maxFireCount from a 2-digit string (coerces to int)', () => {
    const result = lotteryFinderTickerCountsQuerySchema.safeParse({
      maxFireCount: '12',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.maxFireCount).toBe(12);
  });

  it('omits maxFireCount when absent (optional)', () => {
    const result = lotteryFinderTickerCountsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.maxFireCount).toBeUndefined();
  });

  it('rejects maxFireCount below 1 (Zod min(1))', () => {
    const result = lotteryFinderTickerCountsQuerySchema.safeParse({
      maxFireCount: '0',
    });
    expect(result.success).toBe(false);
  });

  it('rejects maxFireCount above 1000 (Zod max(1000))', () => {
    const result = lotteryFinderTickerCountsQuerySchema.safeParse({
      maxFireCount: '1001',
    });
    expect(result.success).toBe(false);
  });
});

// ── silentBoomFeedQuerySchema ────────────────────────────────

describe('silentBoomFeedQuerySchema', () => {
  it('parses valid input with defaults', () => {
    const result = silentBoomFeedQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.minVolOi).toBe(0);
      expect(result.data.minSpikeRatio).toBe(0);
      expect(result.data.sort).toBe('newest');
    }
  });

  it('accepts dte="0" (0DTE bucket)', () => {
    const result = silentBoomFeedQuerySchema.safeParse({ dte: '0' });
    expect(result.success).toBe(true);
  });

  it('rejects unknown dte bucket', () => {
    const result = silentBoomFeedQuerySchema.safeParse({ dte: '7-30' });
    expect(result.success).toBe(false);
  });

  it('rejects unknown burst color', () => {
    const result = silentBoomFeedQuerySchema.safeParse({ burst: 'green' });
    expect(result.success).toBe(false);
  });

  it('rejects minScore outside [-100, 100] (boundary)', () => {
    const result = silentBoomFeedQuerySchema.safeParse({ minScore: 101 });
    expect(result.success).toBe(false);
  });

  it('rejects minVolOi > 100 (boundary)', () => {
    const result = silentBoomFeedQuerySchema.safeParse({ minVolOi: 101 });
    expect(result.success).toBe(false);
  });

  // Regression: `z.coerce.boolean()` made ANY non-empty string truthy, so
  // `?hideLatePm=false` / `?aggressivePremium=false` flipped the filter ON.
  // The enum-transform must honor the literal string.
  describe('hideLatePm boolean parsing (enum-transform, not coerce)', () => {
    it("parses 'false' to boolean false (NOT truthy)", () => {
      const result = silentBoomFeedQuerySchema.safeParse({
        hideLatePm: 'false',
      });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.hideLatePm).toBe(false);
    });

    it("parses 'true' to boolean true", () => {
      const result = silentBoomFeedQuerySchema.safeParse({
        hideLatePm: 'true',
      });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.hideLatePm).toBe(true);
    });

    it('leaves hideLatePm undefined when absent (default off)', () => {
      const result = silentBoomFeedQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.hideLatePm).toBeUndefined();
    });

    it("rejects ambiguous '0' / '1' rather than silently coercing", () => {
      expect(
        silentBoomFeedQuerySchema.safeParse({ hideLatePm: '0' }).success,
      ).toBe(false);
      expect(
        silentBoomFeedQuerySchema.safeParse({ hideLatePm: '1' }).success,
      ).toBe(false);
    });
  });

  describe('aggressivePremium boolean parsing (enum-transform, not coerce)', () => {
    it("parses 'false' to boolean false (NOT truthy)", () => {
      const result = silentBoomFeedQuerySchema.safeParse({
        aggressivePremium: 'false',
      });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.aggressivePremium).toBe(false);
    });

    it("parses 'true' to boolean true", () => {
      const result = silentBoomFeedQuerySchema.safeParse({
        aggressivePremium: 'true',
      });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.aggressivePremium).toBe(true);
    });

    it('leaves aggressivePremium undefined when absent (default off)', () => {
      const result = silentBoomFeedQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.aggressivePremium).toBeUndefined();
    });
  });
});

// ── silentBoomTickerCountsQuerySchema ────────────────────────

describe('silentBoomTickerCountsQuerySchema boolean parsing', () => {
  it("parses hideLatePm='false' to false (NOT truthy)", () => {
    const result = silentBoomTickerCountsQuerySchema.safeParse({
      hideLatePm: 'false',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.hideLatePm).toBe(false);
  });

  it("parses aggressivePremium='false' to false (NOT truthy)", () => {
    const result = silentBoomTickerCountsQuerySchema.safeParse({
      aggressivePremium: 'false',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.aggressivePremium).toBe(false);
  });

  it("parses hideLatePm='true' to true", () => {
    const result = silentBoomTickerCountsQuerySchema.safeParse({
      hideLatePm: 'true',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.hideLatePm).toBe(true);
  });

  it('leaves both undefined when absent', () => {
    const result = silentBoomTickerCountsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hideLatePm).toBeUndefined();
      expect(result.data.aggressivePremium).toBeUndefined();
    }
  });
});

// ── silentBoomExportQuerySchema ──────────────────────────────

describe('silentBoomExportQuerySchema', () => {
  it('parses valid input with default format', () => {
    const result = silentBoomExportQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.format).toBe('csv');
  });

  it('accepts format=json', () => {
    const result = silentBoomExportQuerySchema.safeParse({ format: 'json' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.format).toBe('json');
  });

  it('rejects unknown format', () => {
    const result = silentBoomExportQuerySchema.safeParse({ format: 'xml' });
    expect(result.success).toBe(false);
  });

  it('rejects malformed date', () => {
    const result = silentBoomExportQuerySchema.safeParse({
      date: '2026/05/10',
    });
    expect(result.success).toBe(false);
  });
});

// ── lotteryExportQuerySchema ─────────────────────────────────

describe('lotteryExportQuerySchema', () => {
  it('parses valid input with default format', () => {
    const result = lotteryExportQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.format).toBe('csv');
  });

  it('transforms reload="true" to boolean', () => {
    const result = lotteryExportQuerySchema.safeParse({ reload: 'true' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.reload).toBe(true);
  });

  it('rejects unknown mode', () => {
    const result = lotteryExportQuerySchema.safeParse({ mode: 'C_weekly' });
    expect(result.success).toBe(false);
  });

  it('rejects minScore < 0 (boundary)', () => {
    const result = lotteryExportQuerySchema.safeParse({ minScore: -1 });
    expect(result.success).toBe(false);
  });
});

// ── lotteryContractTapeQuerySchema ───────────────────────────

describe('lotteryContractTapeQuerySchema', () => {
  it('parses valid OCC chain', () => {
    const result = lotteryContractTapeQuerySchema.safeParse({
      chain: 'SPXW260510P05900000',
    });
    expect(result.success).toBe(true);
  });

  it('rejects chain with lowercase letters', () => {
    const result = lotteryContractTapeQuerySchema.safeParse({
      chain: 'spxw260510P05900000',
    });
    expect(result.success).toBe(false);
  });

  it('rejects chain longer than 32 chars (boundary)', () => {
    const result = lotteryContractTapeQuerySchema.safeParse({
      chain: 'A'.repeat(33),
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing chain', () => {
    const result = lotteryContractTapeQuerySchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects malformed HH:MM from/to', () => {
    const result = lotteryContractTapeQuerySchema.safeParse({
      chain: 'SPXW260510P05900000',
      from: '8:30',
    });
    expect(result.success).toBe(false);
  });

  it('accepts proper HH:MM bounds', () => {
    const result = lotteryContractTapeQuerySchema.safeParse({
      chain: 'SPXW260510P05900000',
      from: '08:30',
      to: '15:00',
    });
    expect(result.success).toBe(true);
  });
});
