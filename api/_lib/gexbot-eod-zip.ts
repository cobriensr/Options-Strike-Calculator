import zlib from 'node:zlib';

export type EodZipReason =
  | 'not_zip'
  | 'zip64_unsupported'
  | 'bad_crc'
  | 'bad_entry_name'
  | 'empty'
  | 'unsupported_method';

export class EodZipError extends Error {
  readonly reason: EodZipReason;
  constructor(reason: EodZipReason, message: string) {
    super(message);
    this.name = 'EodZipError';
    this.reason = reason;
  }
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_LEN = 22;
const CD_LEN = 46;
const LOCAL_LEN = 30;
const MAX_EOCD_SEARCH = 65_557;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

function escapeRegex(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\/-]/g, String.raw`\$&`);
}

function notZip(detail: string): EodZipError {
  return new EodZipError('not_zip', `Malformed ZIP: ${detail}`);
}

function findEocd(view: DataView): number {
  const lowest = Math.max(0, view.byteLength - MAX_EOCD_SEARCH);
  for (let pos = view.byteLength - EOCD_LEN; pos >= lowest; pos--) {
    if (view.getUint32(pos, true) === EOCD_SIG) return pos;
  }
  throw notZip('no end-of-central-directory record');
}

/**
 * Proves a GEXBot EOD report body is a complete ZIP for `ticker` and `date`.
 * Throws only EodZipError for a bad body. Entry data is read as views, never
 * copied (bodies reach ~170 MB).
 */
export function validateEodZip(
  body: Uint8Array,
  ticker: string,
  date: string,
): { entryCount: number; entryNames: string[] } {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  if (body.length < EOCD_LEN) throw notZip('too short');

  const eocd = findEocd(view);
  const total = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (total === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
    throw new EodZipError('zip64_unsupported', 'ZIP64 report');
  }
  if (total === 0) throw new EodZipError('empty', 'ZIP has no entries');
  if (cdOffset + cdSize > eocd) throw notZip('central directory out of range');

  const nameRe = new RegExp(
    `^${escapeRegex(ticker)}/(classic|state|orderflow)/[a-z_]+/${escapeRegex(date)}_${escapeRegex(ticker)}_\\1_[a-z_]+\\.json\\.gz$`,
  );
  const entryNames: string[] = [];
  let pos = cdOffset;

  for (let i = 0; i < total; i++) {
    if (pos + CD_LEN > body.length || view.getUint32(pos, true) !== CD_SIG) {
      throw notZip(`bad central directory entry ${i}`);
    }
    const method = view.getUint16(pos + 10, true);
    const crc = view.getUint32(pos + 16, true);
    const compSize = view.getUint32(pos + 20, true);
    const rawSize = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    if (
      compSize === U32_MAX ||
      rawSize === U32_MAX ||
      localOffset === U32_MAX
    ) {
      throw new EodZipError('zip64_unsupported', 'ZIP64 entry');
    }
    const nameEnd = pos + CD_LEN + nameLen;
    if (nameEnd > body.length) throw notZip(`entry ${i} name out of range`);
    const name = Buffer.from(body.subarray(pos + CD_LEN, nameEnd)).toString(
      'utf8',
    );
    pos = nameEnd + extraLen + commentLen;

    if (!nameRe.test(name)) {
      throw new EodZipError('bad_entry_name', `Unexpected entry: ${name}`);
    }
    if (method !== 0 && method !== 8) {
      throw new EodZipError('unsupported_method', `Method ${method}: ${name}`);
    }

    if (
      localOffset + LOCAL_LEN > body.length ||
      view.getUint32(localOffset, true) !== LOCAL_SIG
    ) {
      throw notZip(`bad local header for ${name}`);
    }
    const dataStart =
      localOffset +
      LOCAL_LEN +
      view.getUint16(localOffset + 26, true) +
      view.getUint16(localOffset + 28, true);
    if (dataStart + compSize > body.length) {
      throw notZip(`data out of range for ${name}`);
    }
    const stored = body.subarray(dataStart, dataStart + compSize);

    let actual: number;
    if (method === 0) {
      actual = zlib.crc32(stored);
    } else {
      try {
        actual = zlib.crc32(
          zlib.inflateRawSync(stored, {
            maxOutputLength: Math.max(rawSize, 1),
          }),
        );
      } catch {
        throw new EodZipError('bad_crc', `Corrupt deflate data: ${name}`);
      }
    }
    if (actual !== crc) {
      throw new EodZipError('bad_crc', `CRC mismatch: ${name}`);
    }
    entryNames.push(name);
  }

  return { entryCount: entryNames.length, entryNames };
}
