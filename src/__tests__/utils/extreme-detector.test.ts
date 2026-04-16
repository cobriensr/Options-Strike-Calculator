import { describe, expect, it } from 'vitest';
import type { InternalBar } from '../../types/market-internals';
import { detectExtremes } from '../../utils/extreme-detector';

// ============================================================
// FIXTURE HELPERS
// ============================================================

function makeTickBar(close: number, minuteOffset: number): InternalBar {
  return {
    ts: new Date(2026, 3, 15, 9, 30 + minuteOffset).toISOString(),
    symbol: '$TICK',
    open: close - 10,
    high: close + 20,
    low: close - 20,
    close,
  };
}

function makeBar(
  symbol: '$ADD' | '$VOLD' | '$TRIN',
  close: number,
  minuteOffset: number,
): InternalBar {
  return {
    ts: new Date(2026, 3, 15, 9, 30 + minuteOffset).toISOString(),
    symbol,
    open: close - 5,
    high: close + 10,
    low: close - 10,
    close,
  };
}

// ============================================================
// detectExtremes
// ============================================================

describe('detectExtremes', () => {
  it('labels a single extreme at +650 in range regime as FADE', () => {
    const bars = [makeTickBar(650, 0)];
    const events = detectExtremes(bars, 'range');
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.label).toContain('FADE');
    expect(ev.band).toBe('extreme');
    expect(ev.value).toBe(650);
  });

  it('labels a single extreme at +650 in trend regime as Confirming', () => {
    const bars = [makeTickBar(650, 0)];
    const events = detectExtremes(bars, 'trend');
    expect(events).toHaveLength(1);
    expect(events[0]!.label).toContain('Confirming');
  });

  it('labels blowoff at +1100 with "Blowoff"', () => {
    const bars = [makeTickBar(1100, 0)];
    const events = detectExtremes(bars, 'range');
    expect(events).toHaveLength(1);
    expect(events[0]!.label).toContain('Blowoff');
    expect(events[0]!.band).toBe('blowoff');
  });

  it('marks bars as pinned when 3+ consecutive above extreme threshold', () => {
    // 5 consecutive bars above 600 — the last 3 should be pinned at
    // minimum (PINNED_THRESHOLD_MINUTES = 3).
    const bars = [
      makeTickBar(650, 0),
      makeTickBar(680, 1),
      makeTickBar(700, 2),
      makeTickBar(670, 3),
      makeTickBar(620, 4),
    ];
    const events = detectExtremes(bars);
    expect(events).toHaveLength(5);

    // All 5 are part of a streak of 5 >= extreme, so all should be
    // pinned (5 >= PINNED_THRESHOLD_MINUTES=3).
    const pinnedEvents = events.filter((e) => e.pinned);
    expect(pinnedEvents.length).toBe(5);
  });

  it('does not mark as pinned when streak is shorter than threshold', () => {
    // 2 consecutive extreme bars — below PINNED_THRESHOLD_MINUTES=3.
    const bars = [
      makeTickBar(650, 0),
      makeTickBar(680, 1),
      makeTickBar(100, 2), // breaks the streak
      makeTickBar(650, 3),
    ];
    const events = detectExtremes(bars);

    // First two are extreme but streak is only 2 — not pinned.
    const pinnedEvents = events.filter((e) => e.pinned);
    expect(pinnedEvents.length).toBe(0);
  });

  it('returns elevated band with no directional label for neutral regime at +450', () => {
    const bars = [makeTickBar(450, 0)];
    const events = detectExtremes(bars, 'neutral');
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.band).toBe('elevated');
    // Label should be the band name, not a directional label.
    expect(ev.label).toBe('elevated');
    expect(ev.label).not.toContain('FADE');
    expect(ev.label).not.toContain('Confirming');
  });

  it('returns empty array when no TICK bars are present', () => {
    const bars = [makeBar('$ADD', 500, 0), makeBar('$VOLD', 1000, 1)];
    const events = detectExtremes(bars);
    expect(events).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(detectExtremes([])).toHaveLength(0);
  });

  it('returns empty array when all bars are below 400', () => {
    const bars = [
      makeTickBar(100, 0),
      makeTickBar(-200, 1),
      makeTickBar(350, 2),
      makeTickBar(-50, 3),
    ];
    const events = detectExtremes(bars);
    expect(events).toHaveLength(0);
  });

  it('only produces events from $TICK bars (ignores ADD/VOLD/TRIN)', () => {
    const bars: InternalBar[] = [
      makeTickBar(650, 0),
      makeBar('$ADD', 2000, 1),
      makeBar('$VOLD', 5000, 2),
      makeBar('$TRIN', 3, 3),
    ];
    const events = detectExtremes(bars, 'range');
    expect(events).toHaveLength(1);
    expect(events[0]!.symbol).toBe('$TICK');
  });

  it('returns events sorted by timestamp ascending', () => {
    // Provide bars out of order to verify sorting.
    const bars = [
      makeTickBar(650, 5),
      makeTickBar(700, 0),
      makeTickBar(500, 3),
    ];
    const events = detectExtremes(bars);
    expect(events).toHaveLength(3);
    for (let i = 1; i < events.length; i++) {
      const curr = events[i]!;
      const prev = events[i - 1]!;
      expect(new Date(curr.ts).getTime()).toBeGreaterThanOrEqual(
        new Date(prev.ts).getTime(),
      );
    }
  });

  it('labels elevated bar with no regime provided as band name', () => {
    const bars = [makeTickBar(450, 0)];
    const events = detectExtremes(bars);
    expect(events).toHaveLength(1);
    expect(events[0]!.label).toBe('elevated');
  });
});
