import { describe, it, expect } from 'vitest';
import { parseFrame, type TradovateFrame } from '../tradovate-parser.js';

describe('parseFrame', () => {
  it('parses open frame', () => {
    const result = parseFrame('o');
    expect(result).toEqual({ type: 'open' });
  });

  it('parses heartbeat frame', () => {
    const result = parseFrame('h');
    expect(result).toEqual({ type: 'heartbeat' });
  });

  it('parses close frame', () => {
    const result = parseFrame('c[1000,"Normal closure"]');
    expect(result).toEqual({ type: 'close', code: 1000, reason: 'Normal closure' });
  });

  it('parses data frame with market data quote', () => {
    const payload = JSON.stringify([JSON.stringify({
      e: 'md',
      d: {
        quotes: [{
          timestamp: '2026-03-26T02:15:00Z',
          contractId: 123456,
          entries: {
            Trade: { price: 5825.5, size: 2 },
            TotalTradeVolume: { size: 41180 },
            HighPrice: { price: 5830.25 },
            LowPrice: { price: 5810.5 },
          },
        }],
      },
    })]);
    const result = parseFrame('a' + payload);
    expect(result.type).toBe('data');
    if (result.type === 'data') {
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].e).toBe('md');
      expect(result.messages[0].d.quotes[0].entries.Trade.price).toBe(5825.5);
    }
  });

  it('parses data frame with response message', () => {
    const payload = JSON.stringify([JSON.stringify({ s: 200, i: 1, d: {} })]);
    const result = parseFrame('a' + payload);
    expect(result.type).toBe('data');
    if (result.type === 'data') {
      expect(result.messages[0].s).toBe(200);
    }
  });

  it('parses shutdown event', () => {
    const payload = JSON.stringify([JSON.stringify({
      e: 'shutdown',
      d: { reasonCode: 'ConnectionQuotaReached' },
    })]);
    const result = parseFrame('a' + payload);
    if (result.type === 'data') {
      expect(result.messages[0].e).toBe('shutdown');
      expect(result.messages[0].d.reasonCode).toBe('ConnectionQuotaReached');
    }
  });

  it('returns unknown for unrecognized frames', () => {
    const result = parseFrame('x[garbage]');
    expect(result).toEqual({ type: 'unknown', raw: 'x[garbage]' });
  });
});
