import { describe, it, expect } from 'vitest';
import {
  formatEsOvernightForClaude,
  type EsOvernightSummaryRow,
} from '../es-overnight.js';

const baseSummary: EsOvernightSummaryRow = {
  trade_date: '2026-03-26',
  globex_open: '6520.50',
  globex_high: '6548.25',
  globex_low: '6520.50',
  globex_close: '6545.00',
  vwap: '6536.80',
  total_volume: '487000',
  bar_count: '1042',
  range_pts: '27.75',
  range_pct: '0.0043',
  cash_open: '6545.00',
  prev_cash_close: '6530.00',
  gap_pts: '15.00',
  gap_pct: '0.2300',
  gap_direction: 'UP',
  gap_size_class: 'MODERATE',
  cash_open_pct_rank: '91.00',
  position_class: 'AT_GLOBEX_HIGH',
  vol_20d_avg: '465000',
  vol_ratio: '1.05',
  vol_class: 'NORMAL',
  gap_vs_vwap_pts: '8.20',
  vwap_signal: 'SUPPORTED',
  fill_score: '35',
  fill_probability: 'MODERATE',
};

describe('formatEsOvernightForClaude', () => {
  it('returns null for null input', () => {
    expect(formatEsOvernightForClaude(null as unknown as EsOvernightSummaryRow)).toBeNull();
  });

  it('includes range line with high and low', () => {
    const result = formatEsOvernightForClaude(baseSummary)!;
    expect(result).toContain('6520.50');
    expect(result).toContain('6548.25');
    expect(result).toContain('27.75 pts');
  });

  it('includes volume with classification', () => {
    const result = formatEsOvernightForClaude(baseSummary)!;
    expect(result).toContain('487K');
    expect(result).toContain('NORMAL');
    expect(result).toContain('1.05x');
  });

  it('includes gap analysis', () => {
    const result = formatEsOvernightForClaude(baseSummary)!;
    expect(result).toContain('+15.0');
    expect(result).toContain('UP');
    expect(result).toContain('MODERATE');
    expect(result).toContain('91');
    expect(result).toContain('AT GLOBEX HIGH');
  });

  it('includes fill probability', () => {
    const result = formatEsOvernightForClaude(baseSummary)!;
    expect(result).toContain('MODERATE');
    expect(result).toContain('35');
  });

  it('adds cone comparison when cone bounds provided', () => {
    const result = formatEsOvernightForClaude(baseSummary, 6600, 6460)!;
    expect(result).toContain('straddle cone');
  });

  it('omits cone line when no cone bounds', () => {
    const result = formatEsOvernightForClaude(baseSummary)!;
    expect(result).not.toContain('straddle cone');
  });
});
