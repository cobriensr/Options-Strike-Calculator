import { describe, expect, it } from 'vitest';

import {
  PERISCOPE_GEXBOT_CUTOVER,
  PERISCOPE_SOURCE,
  periscopeSourceAt,
} from '../../utils/periscope-source';

describe('periscopeSourceAt', () => {
  it.each([
    // Last UW scraper slice and first GEXBot slice measured on 2026-05-26.
    ['2026-05-26T17:13:26.475Z', 'scraper'],
    ['2026-05-26T17:29:32.914Z', 'gexbot'],
    // The cutover instant itself belongs to GEXBot.
    [PERISCOPE_GEXBOT_CUTOVER, 'gexbot'],
    ['2026-05-26T17:19:59.999Z', 'scraper'],
    ['2026-05-08T13:30:00Z', 'scraper'],
    ['2026-10-28T14:30:00Z', 'gexbot'],
  ])('%s → %s', (capturedAt, want) => {
    expect(periscopeSourceAt(capturedAt)).toBe(want);
  });

  it('accepts a Date', () => {
    expect(periscopeSourceAt(new Date('2026-06-01T15:00:00Z'))).toBe('gexbot');
  });

  it('returns null for an unparseable timestamp instead of guessing', () => {
    expect(periscopeSourceAt('not-a-date')).toBeNull();
  });

  it('names the two periscope_snapshots.source values', () => {
    expect(PERISCOPE_SOURCE).toEqual({ scraper: 'scraper', gexbot: 'gexbot' });
  });
});
