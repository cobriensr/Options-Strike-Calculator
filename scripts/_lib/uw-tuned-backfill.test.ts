import { describe, expect, it } from 'vitest';
import {
  GEXBOT_INCLUDE_WARNING,
  clampWindowToScraperEra,
  parseIncludeGexbot,
  resolveBackfillScope,
  scraperEraCutoff,
} from './uw-tuned-backfill';

describe('parseIncludeGexbot', () => {
  it('is off by default', () => {
    expect(parseIncludeGexbot([])).toBe(false);
    expect(parseIncludeGexbot(['--from', '2026-05-01'])).toBe(false);
  });

  it('turns on only with --include-gexbot', () => {
    expect(parseIncludeGexbot(['--include-gexbot'])).toBe(true);
    expect(parseIncludeGexbot(['--dry-run', '--include-gexbot'])).toBe(true);
  });
});

describe('GEXBOT_INCLUDE_WARNING', () => {
  it('says the rules were tuned on UW data and the rows are GEXBot', () => {
    expect(GEXBOT_INCLUDE_WARNING).toMatch(/tuned on UW/);
    expect(GEXBOT_INCLUDE_WARNING).toMatch(/GEXBot/);
  });
});

describe('scraperEraCutoff', () => {
  it('is the cutover instant by default and null when opted in', () => {
    expect(scraperEraCutoff(false)).toBe('2026-05-26T17:20:00Z');
    expect(scraperEraCutoff(true)).toBeNull();
  });
});

describe('clampWindowToScraperEra', () => {
  it('leaves a scraper-era window alone', () => {
    expect(clampWindowToScraperEra('2026-02-26', '2026-05-22', false)).toEqual({
      from: '2026-02-26',
      to: '2026-05-22',
      clamped: false,
    });
  });

  it('pulls a window that reaches into the GEXBot era back to the last scraper day', () => {
    expect(clampWindowToScraperEra('2026-02-26', '2026-10-29', false)).toEqual({
      from: '2026-02-26',
      to: '2026-05-26',
      clamped: true,
    });
  });

  it('does not clamp when opted in', () => {
    expect(clampWindowToScraperEra('2026-02-26', '2026-10-29', true)).toEqual({
      from: '2026-02-26',
      to: '2026-10-29',
      clamped: false,
    });
  });
});

describe('resolveBackfillScope', () => {
  it('defaults to the cutover bound and a capped window', () => {
    expect(resolveBackfillScope([], '2026-02-26', '2026-10-29')).toEqual({
      includeGexbot: false,
      from: '2026-02-26',
      to: '2026-05-26',
      clamped: true,
      cutoff: '2026-05-26T17:20:00Z',
    });
  });

  it('lifts the cutoff and the cap with --include-gexbot', () => {
    expect(
      resolveBackfillScope(['--include-gexbot'], '2026-02-26', '2026-10-29'),
    ).toEqual({
      includeGexbot: true,
      from: '2026-02-26',
      to: '2026-10-29',
      clamped: false,
      cutoff: null,
    });
  });
});
