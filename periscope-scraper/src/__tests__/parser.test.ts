// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseHeader,
  parsePage,
  parseTableRows,
  parseTitleValue,
  parseValueString,
} from '../parser.js';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/sample-page.html');
const FIXTURE_HTML = readFileSync(FIXTURE_PATH, 'utf8');
const CAPTURED_AT = '2026-05-07T19:55:00.000Z';

describe('parseValueString', () => {
  it('parses plain integers and decimals', () => {
    expect(parseValueString('0')).toBe(0);
    expect(parseValueString('23.88')).toBe(23.88);
    expect(parseValueString('366.67')).toBe(366.67);
  });

  it('parses negative values', () => {
    expect(parseValueString('-0.01')).toBe(-0.01);
    expect(parseValueString('-46325.35')).toBe(-46325.35);
  });

  it('strips thousands commas before parsing', () => {
    expect(parseValueString('15,404.71')).toBe(15404.71);
    expect(parseValueString('-46,325.35')).toBe(-46325.35);
    expect(parseValueString('4,055.6')).toBe(4055.6);
  });

  it('expands the K suffix to thousands', () => {
    expect(parseValueString('235K')).toBe(235_000);
    expect(parseValueString('-619K')).toBe(-619_000);
  });

  it('expands the M suffix to millions', () => {
    expect(parseValueString('-2.36M')).toBeCloseTo(-2_360_000, 6);
    expect(parseValueString('444M')).toBe(444_000_000);
    expect(parseValueString('-819M')).toBe(-819_000_000);
  });

  it('expands the B suffix to billions', () => {
    expect(parseValueString('1.5B')).toBe(1_500_000_000);
  });

  it('returns null for unparseable strings', () => {
    expect(parseValueString('')).toBeNull();
    expect(parseValueString('   ')).toBeNull();
    expect(parseValueString('N/A')).toBeNull();
    expect(parseValueString('abc')).toBeNull();
    // Lowercase suffix not supported (UW always uses uppercase)
    expect(parseValueString('1.5m')).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(parseValueString('  444M  ')).toBe(444_000_000);
  });
});

describe('parseTitleValue', () => {
  it('extracts the numeric part from a "Greek: value" title', () => {
    expect(parseTitleValue('Charm: -2.36M')).toBeCloseTo(-2_360_000, 6);
    expect(parseTitleValue('Charm: 0')).toBe(0);
    expect(parseTitleValue('Gamma: 15,404.71')).toBe(15404.71);
    expect(parseTitleValue('Vanna: 444M')).toBe(444_000_000);
  });

  it('returns null when the title has no colon', () => {
    expect(parseTitleValue('Charm 23.88')).toBeNull();
  });

  it('returns null when the value half is unparseable', () => {
    expect(parseTitleValue('Charm: ')).toBeNull();
    expect(parseTitleValue('Charm: foo')).toBeNull();
  });
});

describe('parseHeader', () => {
  it('extracts spot / expiry / panel / timeframe from the fixture', () => {
    const header = parseHeader(FIXTURE_HTML);
    expect(header.spot).toBe(7337.07);
    expect(header.expiry).toBe('2026-05-07');
    expect(header.panel).toBe('charm');
    expect(header.timeframe).toBe('14:50 - 15:00');
  });

  it('throws when Underlying spot is missing', () => {
    const html = FIXTURE_HTML.replace(/Underlying:\s*\(\$[\d.]+\)/g, '');
    expect(() => parseHeader(html)).toThrow(/Underlying spot/);
  });

  it('throws when Expiry value is malformed', () => {
    // Synthetic minimal HTML — easier than mutating the fixture for an
    // edge-case throw test.
    const html = `
      <html><body>
        <span>Underlying: ($7337.07)</span>
        <div data-sentry-component="DropdownFilter">
          <span class="text-xs">Expiry</span>
          <span class="text-base">not-a-date</span>
        </div>
        <div data-sentry-component="DropdownFilter">
          <span class="text-xs">Greek</span>
          <span class="text-base">Charm</span>
        </div>
      </body></html>
    `;
    expect(() => parseHeader(html)).toThrow(/expiry/i);
  });

  it('throws when Greek value is something other than Gamma/Charm/Vanna', () => {
    const html = FIXTURE_HTML.replace(
      '<span class="text-base font-medium capitalize">Charm</span>',
      '<span class="text-base font-medium capitalize">Theta</span>',
    );
    expect(() => parseHeader(html)).toThrow(/Theta/);
  });
});

describe('parseTableRows', () => {
  it('extracts every data row from the fixture', () => {
    const rows = parseTableRows(
      FIXTURE_HTML,
      'charm',
      CAPTURED_AT,
      '2026-05-07',
      '14:50 - 15:00',
    );
    // 14 rows in the fixture
    expect(rows).toHaveLength(14);
  });

  it('parses strike values without commas', () => {
    const rows = parseTableRows(
      FIXTURE_HTML,
      'charm',
      CAPTURED_AT,
      '2026-05-07',
      '14:50 - 15:00',
    );
    const strikes = rows.map((r) => r.strike).sort((a, b) => a - b);
    expect(strikes[0]).toBe(7215);
    expect(strikes[strikes.length - 1]).toBe(7420);
    // 7,400 must be in there as 7400, not 7,400-as-string.
    expect(strikes).toContain(7400);
  });

  it('parses representative numeric formats correctly', () => {
    const rows = parseTableRows(
      FIXTURE_HTML,
      'charm',
      CAPTURED_AT,
      '2026-05-07',
      '14:50 - 15:00',
    );
    const byStrike = new Map(rows.map((r) => [r.strike, r.value]));

    // Plain integer
    expect(byStrike.get(7215)).toBe(0);
    // Negative tiny
    expect(byStrike.get(7420)).toBe(-0.01);
    // Sub-1 positive
    expect(byStrike.get(7410)).toBe(0.25);
    // Mid-range
    expect(byStrike.get(7400)).toBe(23.88);
    // Comma-separated
    expect(byStrike.get(7390)).toBe(15404.71);
    expect(byStrike.get(7385)).toBe(-46325.35);
    expect(byStrike.get(7250)).toBe(4055.6);
    // K suffix
    expect(byStrike.get(7380)).toBe(235_000);
    // M suffix (positive + negative)
    expect(byStrike.get(7350)).toBe(444_000_000);
    expect(byStrike.get(7345)).toBe(551_000_000);
    expect(byStrike.get(7320)).toBe(-819_000_000);
    expect(byStrike.get(7375)).toBeCloseTo(-2_360_000, 6);
  });

  it('stamps panel + capturedAt + expiry on every row', () => {
    const rows = parseTableRows(
      FIXTURE_HTML,
      'charm',
      CAPTURED_AT,
      '2026-05-07',
      '14:50 - 15:00',
    );
    for (const r of rows) {
      expect(r.panel).toBe('charm');
      expect(r.capturedAt).toBe(CAPTURED_AT);
      expect(r.expiry).toBe('2026-05-07');
      expect(r.timeframe).toBe('14:50 - 15:00');
    }
  });
});

describe('parsePage', () => {
  it('returns header + rows in one pass with consistent expiry', () => {
    const result = parsePage(FIXTURE_HTML, CAPTURED_AT);
    expect(result.header.expiry).toBe('2026-05-07');
    expect(result.header.panel).toBe('charm');
    expect(result.rows.length).toBeGreaterThan(0);
    // Every row's expiry/panel should match the header's
    for (const r of result.rows) {
      expect(r.expiry).toBe(result.header.expiry);
      expect(r.panel).toBe(result.header.panel);
    }
  });
});
