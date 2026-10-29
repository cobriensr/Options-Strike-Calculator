import { describe, expect, it } from 'vitest';
import { EodZipError, validateEodZip } from '../_lib/gexbot-eod-zip.js';
import { buildStoredZip } from './helpers/stored-zip.js';

const DATE = '2026-10-28';
const CATS = ['classic', 'state', 'orderflow'] as const;
const KINDS = ['gex_full', 'gex_zero', 'gex_one', 'extra', 'more'] as const;

function name(ticker: string, cat: string, kind: string, date = DATE) {
  return `${ticker}/${cat}/${kind}/${date}_${ticker}_${cat}_${kind}.json.gz`;
}

function entries(ticker: string, count = 15, date = DATE) {
  return Array.from({ length: count }, (_, i) => ({
    name: name(ticker, CATS[i % 3] as string, KINDS[i % 5] as string, date),
    data: new TextEncoder().encode(`payload-${i}`),
  }));
}

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(EodZipError);
    return (err as EodZipError).reason;
  }
  return undefined;
}

function viewOf(zip: Uint8Array) {
  return new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
}

describe('validateEodZip', () => {
  it('accepts a valid 15-entry report', () => {
    const zip = buildStoredZip(entries('VALE'));
    const res = validateEodZip(zip, 'VALE', DATE);
    expect(res.entryCount).toBe(15);
    expect(res.entryNames).toHaveLength(15);
    expect(res.entryNames[0]).toBe(name('VALE', 'classic', 'gex_full'));
  });

  it('rejects random bytes as not_zip', () => {
    const junk = new Uint8Array(500).map((_, i) => (i * 37) % 251);
    expect(reasonOf(() => validateEodZip(junk, 'VALE', DATE))).toBe('not_zip');
  });

  it('rejects a body cut 100 bytes short as not_zip', () => {
    const zip = buildStoredZip(entries('VALE'));
    const cut = zip.subarray(0, zip.length - 100);
    expect(reasonOf(() => validateEodZip(cut, 'VALE', DATE))).toBe('not_zip');
  });

  it('rejects a corrupted CRC as bad_crc', () => {
    const list = entries('VALE');
    const zip = buildStoredZip(list, { corruptCrcOf: list[3]?.name });
    expect(reasonOf(() => validateEodZip(zip, 'VALE', DATE))).toBe('bad_crc');
  });

  it('rejects an entry for another ticker', () => {
    const list = entries('VALE');
    list[2] = { ...list[2]!, name: name('AAPL', 'state', 'gex_one') };
    const zip = buildStoredZip(list);
    expect(reasonOf(() => validateEodZip(zip, 'VALE', DATE))).toBe(
      'bad_entry_name',
    );
  });

  it('rejects an entry with another date', () => {
    const zip = buildStoredZip(entries('VALE', 15, '2026-10-27'));
    expect(reasonOf(() => validateEodZip(zip, 'VALE', DATE))).toBe(
      'bad_entry_name',
    );
  });

  it('escapes regex metacharacters in the ticker', () => {
    const ok = buildStoredZip(entries('BRK.B', 3));
    expect(validateEodZip(ok, 'BRK.B', DATE).entryCount).toBe(3);
    const bad = buildStoredZip(entries('BRKXB', 3));
    expect(reasonOf(() => validateEodZip(bad, 'BRK.B', DATE))).toBe(
      'bad_entry_name',
    );
  });

  it('rejects a ZIP64 sentinel in the EOCD', () => {
    const zip = buildStoredZip(entries('VALE', 2));
    viewOf(zip).setUint16(zip.length - 22 + 10, 0xffff, true);
    expect(reasonOf(() => validateEodZip(zip, 'VALE', DATE))).toBe(
      'zip64_unsupported',
    );
  });

  it('rejects zero entries as empty', () => {
    const zip = buildStoredZip([]);
    expect(reasonOf(() => validateEodZip(zip, 'VALE', DATE))).toBe('empty');
  });

  it('accepts a deflated (method 8) entry', () => {
    const list = entries('VALE', 2);
    const zip = buildStoredZip(
      list.map((e, i) => ({ ...e, method: i === 0 ? (8 as const) : 0 })),
    );
    expect(validateEodZip(zip, 'VALE', DATE).entryCount).toBe(2);
  });

  it('rejects corrupt deflate data as bad_crc', () => {
    const list = entries('VALE', 1);
    const zip = buildStoredZip([{ ...list[0]!, method: 8 }]);
    const dataStart = 30 + (list[0]?.name.length ?? 0);
    zip.fill(0xff, dataStart, dataStart + 4);
    expect(reasonOf(() => validateEodZip(zip, 'VALE', DATE))).toBe('bad_crc');
  });

  it('rejects an unsupported compression method', () => {
    const zip = buildStoredZip(entries('VALE', 1));
    const cdStart = viewOf(zip).getUint32(zip.length - 22 + 16, true);
    viewOf(zip).setUint16(cdStart + 10, 12, true);
    expect(reasonOf(() => validateEodZip(zip, 'VALE', DATE))).toBe(
      'unsupported_method',
    );
  });

  it('rejects a central-directory offset past the end as not_zip', () => {
    const zip = buildStoredZip(entries('VALE', 2));
    viewOf(zip).setUint32(zip.length - 22 + 16, zip.length + 1000, true);
    expect(reasonOf(() => validateEodZip(zip, 'VALE', DATE))).toBe('not_zip');
  });

  it('rejects a local-header offset past the end as not_zip', () => {
    const zip = buildStoredZip(entries('VALE', 1));
    const cdStart = viewOf(zip).getUint32(zip.length - 22 + 16, true);
    viewOf(zip).setUint32(cdStart + 42, zip.length + 1000, true);
    expect(reasonOf(() => validateEodZip(zip, 'VALE', DATE))).toBe('not_zip');
  });
});
