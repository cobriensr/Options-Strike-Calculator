import { describe, expect, it } from 'vitest';
import {
  UW_TUNED_PAUSE_REASON,
  isUwTunedRulePaused,
  isUwTunedRulePausedForDay,
  uwTunedPauseMessage,
} from '../utils/uw-tuned-pause';

describe('isUwTunedRulePaused', () => {
  it.each([
    ['2026-05-22T15:00:00Z', false],
    ['2026-05-26T17:19:59Z', false],
    ['2026-05-26T17:20:00Z', true],
    ['2026-10-29T15:00:00Z', true],
  ])('%s -> %s', (at, expected) => {
    expect(isUwTunedRulePaused(at)).toBe(expected);
    expect(isUwTunedRulePaused(new Date(at))).toBe(expected);
  });

  it('does not pause on an unparseable timestamp', () => {
    expect(isUwTunedRulePaused('not-a-date')).toBe(false);
  });
});

describe('pause copy', () => {
  it('names the reason and tells the owner why', () => {
    expect(UW_TUNED_PAUSE_REASON).toBe('uw-tuned-rule-on-gexbot-data');
    expect(uwTunedPauseMessage('setups')).toBe(
      'Paused — these setups were tuned on UW Periscope data; live data is GEXBot. GEXBot-specific rules pending.',
    );
    expect(uwTunedPauseMessage('alerts')).toContain('these alerts were tuned');
  });
});

describe('isUwTunedRulePausedForDay', () => {
  it.each([
    ['2026-05-22', false],
    ['2026-05-25', false],
    ['2026-05-26', true],
    ['2026-10-29', true],
  ])('%s -> %s', (day, expected) => {
    expect(isUwTunedRulePausedForDay(day)).toBe(expected);
  });
});
