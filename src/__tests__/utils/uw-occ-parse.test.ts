import { describe, it, expect } from 'vitest';
import { tryParseOccChain, tryParseUwTicker } from '../../utils/uw-occ-parse';

describe('tryParseOccChain', () => {
  it('parses an unpadded bare OCC body', () => {
    expect(tryParseOccChain('TSLA261016C00800000')).toEqual({
      ticker: 'TSLA',
      expiry: '2026-10-16',
      side: 'C',
      strike: 800,
    });
  });

  it('parses a padded 21-char bare OCC body', () => {
    expect(tryParseOccChain('NVDA  260522P00225000')).toEqual({
      ticker: 'NVDA',
      expiry: '2026-05-22',
      side: 'P',
      strike: 225,
    });
  });

  it('parses a 6-char-root OCC body (no padding)', () => {
    expect(tryParseOccChain('GOOGL 261016C00200000')).toEqual({
      ticker: 'GOOGL',
      expiry: '2026-10-16',
      side: 'C',
      strike: 200,
    });
  });

  it('parses a fractional strike (last 3 strike digits = thousandths)', () => {
    expect(tryParseOccChain('AMD261016P00397500')).toEqual({
      ticker: 'AMD',
      expiry: '2026-10-16',
      side: 'P',
      strike: 397.5,
    });
  });

  it('parses a full https UW URL', () => {
    expect(
      tryParseOccChain(
        'https://unusualwhales.com/option-chain/TSLA261016C00800000',
      ),
    ).toEqual({
      ticker: 'TSLA',
      expiry: '2026-10-16',
      side: 'C',
      strike: 800,
    });
  });

  it('parses a UW URL with www.', () => {
    expect(
      tryParseOccChain(
        'https://www.unusualwhales.com/option-chain/AMZN260619P00150000',
      ),
    ).toEqual({
      ticker: 'AMZN',
      expiry: '2026-06-19',
      side: 'P',
      strike: 150,
    });
  });

  it('parses a UW URL with no protocol', () => {
    expect(
      tryParseOccChain('unusualwhales.com/option-chain/TSLA261016C00800000'),
    ).toEqual({
      ticker: 'TSLA',
      expiry: '2026-10-16',
      side: 'C',
      strike: 800,
    });
  });

  it('is case-insensitive on the OCC body', () => {
    expect(tryParseOccChain('tsla261016c00800000')).toEqual({
      ticker: 'TSLA',
      expiry: '2026-10-16',
      side: 'C',
      strike: 800,
    });
  });

  it('returns null on empty / whitespace input', () => {
    expect(tryParseOccChain('')).toBeNull();
    expect(tryParseOccChain('   ')).toBeNull();
  });

  it('returns null on natural-language ticker (NOT in OCC shape)', () => {
    expect(tryParseOccChain('NVDA 225P 05/22/26')).toBeNull();
    expect(tryParseOccChain('hello world')).toBeNull();
  });

  it('returns null on a UW URL with malformed OCC body', () => {
    expect(
      tryParseOccChain(
        'https://unusualwhales.com/option-chain/TSLA261016C0080',
      ),
    ).toBeNull();
  });

  it('returns null on a non-UW URL', () => {
    expect(
      tryParseOccChain('https://google.com/option-chain/TSLA261016C00800000'),
    ).toBeNull();
  });

  it('returns null on out-of-range date components', () => {
    // Month 13 should fail
    expect(tryParseOccChain('TSLA261316C00800000')).toBeNull();
    // Day 32 should fail
    expect(tryParseOccChain('TSLA261032C00800000')).toBeNull();
  });

  it('parses a UW flow URL with chain=<OCC>', () => {
    expect(
      tryParseOccChain(
        'https://unusualwhales.com/flow/option_chains?chain=NFLX260522P00091000',
      ),
    ).toEqual({
      ticker: 'NFLX',
      expiry: '2026-05-22',
      side: 'P',
      strike: 91,
    });
  });

  it('parses a UW flow URL with extra query params alongside chain=<OCC>', () => {
    expect(
      tryParseOccChain(
        'https://unusualwhales.com/flow/option_chains?tab=live&chain=AMZN260619C00150000&sort=premium',
      ),
    ).toEqual({
      ticker: 'AMZN',
      expiry: '2026-06-19',
      side: 'C',
      strike: 150,
    });
  });

  it('returns null on a UW flow URL with ticker-only chain', () => {
    // No OCC body in `chain=NFLX` — structured parser declines so the
    // caller can fall through to `tryParseUwTicker`.
    expect(
      tryParseOccChain(
        'https://unusualwhales.com/flow/option_chains?chain=NFLX',
      ),
    ).toBeNull();
  });
});

describe('tryParseUwTicker', () => {
  it('returns the ticker from a flow URL with chain=<TICKER>', () => {
    expect(
      tryParseUwTicker(
        'https://unusualwhales.com/flow/option_chains?chain=NFLX',
      ),
    ).toBe('NFLX');
  });

  it('upper-cases the ticker', () => {
    expect(
      tryParseUwTicker('unusualwhales.com/flow/option_chains?chain=nflx'),
    ).toBe('NFLX');
  });

  it('returns null when chain= carries a full OCC body (defer to structured parser)', () => {
    expect(
      tryParseUwTicker(
        'https://unusualwhales.com/flow/option_chains?chain=NFLX260522P00091000',
      ),
    ).toBeNull();
  });

  it('returns null on an option-chain path URL', () => {
    expect(
      tryParseUwTicker(
        'https://unusualwhales.com/option-chain/TSLA261016C00800000',
      ),
    ).toBeNull();
  });

  it('returns null on a non-UW URL', () => {
    expect(
      tryParseUwTicker('https://example.com/flow/option_chains?chain=NFLX'),
    ).toBeNull();
  });

  it('returns null on bare OCC / free text / empty', () => {
    expect(tryParseUwTicker('TSLA261016C00800000')).toBeNull();
    expect(tryParseUwTicker('hello world')).toBeNull();
    expect(tryParseUwTicker('')).toBeNull();
  });
});
