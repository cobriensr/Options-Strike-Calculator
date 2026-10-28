import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { claimReport, summarizeZodIssues } from '../lib/response-guard';

describe('summarizeZodIssues', () => {
  it('flattens each issue to a "path: message" string', () => {
    const parsed = z
      .object({ spx: z.object({ candles: z.array(z.number()) }) })
      .safeParse({ spx: { candles: [1, 'two'] } });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const summary = summarizeZodIssues(parsed.error.issues);

    expect(summary.issueCount).toBe(1);
    expect(summary.issues).toHaveLength(1);
    expect(summary.issues[0]).toMatch(/^spx\.candles\.1: /);
  });

  it('labels an issue on the payload itself as (root)', () => {
    const parsed = z.object({ a: z.string() }).safeParse('not an object');
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    expect(summarizeZodIssues(parsed.error.issues).issues[0]).toMatch(
      /^\(root\): /,
    );
  });

  it('caps the list at 20 entries and still counts every issue', () => {
    const issues = Array.from({ length: 25 }, (_, i) => ({
      path: ['rows', i],
      message: 'Invalid input',
    }));

    const summary = summarizeZodIssues(issues);

    expect(summary.issueCount).toBe(25);
    expect(summary.issues).toHaveLength(20);
    expect(summary.issues[19]).toBe('rows.19: Invalid input');
  });

  it('stringifies symbol path segments instead of throwing', () => {
    const summary = summarizeZodIssues([
      { path: [Symbol('k')], message: 'Invalid input' },
    ]);

    expect(summary.issues).toEqual(['Symbol(k): Invalid input']);
  });
});

describe('claimReport', () => {
  it('claims a key once, then refuses repeats of it', () => {
    const latch = { current: null as string | null };

    expect(claimReport(latch, 'live')).toBe(true);
    expect(claimReport(latch, 'live')).toBe(false);
    expect(latch.current).toBe('live');
  });

  it('claims a different key', () => {
    const latch = { current: 'live' as string | null };

    expect(claimReport(latch, '2026-05-12')).toBe(true);
    expect(latch.current).toBe('2026-05-12');
  });

  it('claims the same key again after a reset to null', () => {
    const latch = { current: 'live' as string | null };
    latch.current = null;

    expect(claimReport(latch, 'live')).toBe(true);
  });
});
