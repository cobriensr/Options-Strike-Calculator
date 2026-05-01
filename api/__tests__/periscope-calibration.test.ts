// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import {
  fetchCalibrationExamples,
  formatCalibrationBlock,
  buildCalibrationBlock,
} from '../_lib/periscope-calibration.js';

beforeEach(() => {
  mockSql.mockReset();
});

describe('fetchCalibrationExamples', () => {
  it('returns an empty array when no rows match', async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await fetchCalibrationExamples('read');
    expect(result).toEqual([]);
  });

  it('parses rows into the typed shape', async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: '5',
        mode: 'read',
        regime_tag: 'pin',
        calibration_quality: '5',
        prose_text: 'Sample prose.',
      },
    ]);
    const result = await fetchCalibrationExamples('read');
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(5);
    expect(result[0]!.mode).toBe('read');
    expect(result[0]!.regime_tag).toBe('pin');
    expect(result[0]!.calibration_quality).toBe(5);
  });

  it('returns empty array on DB error (best-effort)', async () => {
    mockSql.mockRejectedValueOnce(new Error('DB down'));
    const result = await fetchCalibrationExamples('read');
    expect(result).toEqual([]);
  });
});

describe('formatCalibrationBlock', () => {
  it('returns null when there are no examples', () => {
    const result = formatCalibrationBlock([], 'read');
    expect(result).toBeNull();
  });

  it('formats a single example with header + prose', () => {
    const result = formatCalibrationBlock(
      [
        {
          id: 1,
          mode: 'read',
          regime_tag: 'pin',
          calibration_quality: 5,
          prose_text: 'Pin day at 7120.',
        },
      ],
      'read',
    );
    expect(result).not.toBeNull();
    expect(result).toContain('Calibration examples');
    expect(result).toContain('★★★★★');
    expect(result).toContain('regime: pin');
    expect(result).toContain('Pin day at 7120.');
  });

  it('handles examples with no regime_tag', () => {
    const result = formatCalibrationBlock(
      [
        {
          id: 1,
          mode: 'read',
          regime_tag: null,
          calibration_quality: 4,
          prose_text: 'Some read.',
        },
      ],
      'read',
    );
    expect(result).not.toBeNull();
    expect(result).not.toContain('regime: null');
    expect(result).toContain('★★★★');
  });

  it('truncates long prose with a marker', () => {
    const longProse = 'x'.repeat(5000);
    const result = formatCalibrationBlock(
      [
        {
          id: 1,
          mode: 'read',
          regime_tag: null,
          calibration_quality: 5,
          prose_text: longProse,
        },
      ],
      'read',
    );
    expect(result).toContain('truncated for brevity');
    // The prose section is capped at the truncation threshold; the
    // total formatted block adds ~500 chars of boilerplate (header,
    // separator, intro). Total should still be far below the raw 5KB.
    expect(result!.length).toBeLessThan(longProse.length);
  });

  it('separates multiple examples with a horizontal rule', () => {
    const result = formatCalibrationBlock(
      [
        {
          id: 1,
          mode: 'read',
          regime_tag: 'pin',
          calibration_quality: 5,
          prose_text: 'A',
        },
        {
          id: 2,
          mode: 'read',
          regime_tag: 'trap',
          calibration_quality: 4,
          prose_text: 'B',
        },
      ],
      'read',
    );
    expect(result).toContain('---');
    expect(result).toContain('Example 1');
    expect(result).toContain('Example 2');
  });

  it('mentions the mode in the header so it matches the current request', () => {
    const result = formatCalibrationBlock(
      [
        {
          id: 1,
          mode: 'debrief',
          regime_tag: null,
          calibration_quality: 5,
          prose_text: 'p',
        },
      ],
      'debrief',
    );
    expect(result).toContain('debriefs');
  });
});

describe('buildCalibrationBlock', () => {
  it('returns null when no examples are persisted', async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await buildCalibrationBlock('read');
    expect(result).toBeNull();
  });

  it('returns the formatted string when examples exist', async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: '1',
        mode: 'read',
        regime_tag: 'pin',
        calibration_quality: '5',
        prose_text: 'Sample.',
      },
    ]);
    const result = await buildCalibrationBlock('read');
    expect(result).not.toBeNull();
    expect(result).toContain('★★★★★');
  });

  it('passes the mode filter to the query', async () => {
    mockSql.mockResolvedValueOnce([]);
    await buildCalibrationBlock('debrief');
    expect(mockSql).toHaveBeenCalledOnce();
  });
});
