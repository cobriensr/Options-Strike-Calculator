import { describe, it, expect, beforeEach } from 'vitest';
import { BarAggregator, type Bar } from '../bar-aggregator.js';

describe('BarAggregator', () => {
  let flushed: Bar[];
  let aggregator: BarAggregator;

  beforeEach(() => {
    flushed = [];
    aggregator = new BarAggregator((bar) => {
      flushed.push(bar);
    });
  });

  it('creates a bar from the first tick', () => {
    aggregator.onTick({
      price: 5825.5,
      cumulativeVolume: 1000,
      timestamp: new Date('2026-03-26T02:15:30Z'),
    });
    const current = aggregator.getCurrentBar();
    expect(current).not.toBeNull();
    expect(current!.open).toBe(5825.5);
    expect(current!.high).toBe(5825.5);
    expect(current!.low).toBe(5825.5);
    expect(current!.close).toBe(5825.5);
    expect(current!.tickCount).toBe(1);
  });

  it('updates OHLC within the same minute', () => {
    const base = new Date('2026-03-26T02:15:00Z');
    aggregator.onTick({
      price: 5825.0,
      cumulativeVolume: 1000,
      timestamp: new Date(base.getTime() + 10_000),
    });
    aggregator.onTick({
      price: 5830.0,
      cumulativeVolume: 1005,
      timestamp: new Date(base.getTime() + 20_000),
    });
    aggregator.onTick({
      price: 5820.0,
      cumulativeVolume: 1010,
      timestamp: new Date(base.getTime() + 30_000),
    });
    aggregator.onTick({
      price: 5827.5,
      cumulativeVolume: 1015,
      timestamp: new Date(base.getTime() + 40_000),
    });

    const current = aggregator.getCurrentBar();
    expect(current!.open).toBe(5825.0);
    expect(current!.high).toBe(5830.0);
    expect(current!.low).toBe(5820.0);
    expect(current!.close).toBe(5827.5);
    expect(current!.tickCount).toBe(4);
  });

  it('flushes when minute boundary is crossed', () => {
    aggregator.onTick({
      price: 5825.0,
      cumulativeVolume: 1000,
      timestamp: new Date('2026-03-26T02:15:10Z'),
    });
    aggregator.onTick({
      price: 5826.0,
      cumulativeVolume: 1005,
      timestamp: new Date('2026-03-26T02:15:30Z'),
    });
    // New minute
    aggregator.onTick({
      price: 5828.0,
      cumulativeVolume: 1010,
      timestamp: new Date('2026-03-26T02:16:05Z'),
    });

    expect(flushed).toHaveLength(1);
    expect(flushed[0].open).toBe(5825.0);
    expect(flushed[0].close).toBe(5826.0);
    expect(flushed[0].ts.toISOString()).toBe('2026-03-26T02:15:00.000Z');
  });

  it('computes volume as delta of cumulative values', () => {
    aggregator.onTick({
      price: 5825.0,
      cumulativeVolume: 1000,
      timestamp: new Date('2026-03-26T02:15:10Z'),
    });
    aggregator.onTick({
      price: 5826.0,
      cumulativeVolume: 1050,
      timestamp: new Date('2026-03-26T02:15:30Z'),
    });
    aggregator.onTick({
      price: 5828.0,
      cumulativeVolume: 1070,
      timestamp: new Date('2026-03-26T02:16:05Z'),
    });

    expect(flushed[0].volume).toBe(50); // 1050 - 1000
  });

  it('handles session reset (cumulative drops to lower value)', () => {
    aggregator.onTick({
      price: 5825.0,
      cumulativeVolume: 500000,
      timestamp: new Date('2026-03-26T02:15:10Z'),
    });
    aggregator.onTick({
      price: 5826.0,
      cumulativeVolume: 500050,
      timestamp: new Date('2026-03-26T02:15:30Z'),
    });
    // New minute — cumulative reset (maintenance break)
    aggregator.onTick({
      price: 5828.0,
      cumulativeVolume: 100,
      timestamp: new Date('2026-03-26T02:16:05Z'),
    });

    expect(flushed[0].volume).toBe(50); // 500050 - 500000
    const current = aggregator.getCurrentBar();
    expect(current!.tickCount).toBe(1);
  });

  it('flush() writes partial bar and resets', () => {
    aggregator.onTick({
      price: 5825.0,
      cumulativeVolume: 1000,
      timestamp: new Date('2026-03-26T02:15:10Z'),
    });
    aggregator.flush();

    expect(flushed).toHaveLength(1);
    expect(flushed[0].close).toBe(5825.0);
    expect(aggregator.getCurrentBar()).toBeNull();
  });

  it('flush() is a no-op when no bar exists', () => {
    aggregator.flush();
    expect(flushed).toHaveLength(0);
  });
});
