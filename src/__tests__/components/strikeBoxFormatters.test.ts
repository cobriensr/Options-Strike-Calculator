/**
 * Unit tests for StrikeBox formatters. Pure functions — no React, no DOM.
 *
 * The shared StrikeBox.test.tsx already exercises these via render fixtures,
 * but it doesn't reach the small-value (< 1000) branches because the test
 * leaderboards always use realistic large dollar values. These tests pin
 * the branch and edge-case behavior directly.
 */

import { describe, expect, it } from 'vitest';
import {
  formatDeltaPct,
  formatDist,
  formatGex,
  formatNet,
} from '../../components/GexTarget/StrikeBox/formatters';

describe('formatGex', () => {
  it('formats values in the billions with one decimal and B suffix', () => {
    expect(formatGex(2_500_000_000)).toBe('+2.5B');
    expect(formatGex(-1_200_000_000)).toBe('-1.2B');
  });

  it('formats values in the millions with one decimal and M suffix', () => {
    expect(formatGex(7_400_000)).toBe('+7.4M');
    expect(formatGex(-3_100_000)).toBe('-3.1M');
  });

  it('formats values in the thousands with no decimals and K suffix', () => {
    expect(formatGex(15_678)).toBe('+16K');
    expect(formatGex(-2_499)).toBe('-2K');
  });

  it('formats sub-thousand values without a unit suffix', () => {
    expect(formatGex(950)).toBe('+950');
    expect(formatGex(-12)).toBe('-12');
    expect(formatGex(0)).toBe('+0');
  });

  it('treats exactly 1B / 1M / 1K as boundaries entering the next unit', () => {
    expect(formatGex(1_000_000_000)).toBe('+1.0B');
    expect(formatGex(1_000_000)).toBe('+1.0M');
    expect(formatGex(1_000)).toBe('+1K');
  });
});

describe('formatDeltaPct', () => {
  it('returns an em-dash for null', () => {
    expect(formatDeltaPct(null)).toBe('\u2014');
  });

  it('formats positive fractions with a leading + and one decimal', () => {
    expect(formatDeltaPct(0.123)).toBe('+12.3%');
  });

  it('formats negative fractions with a native minus sign and one decimal', () => {
    expect(formatDeltaPct(-0.075)).toBe('-7.5%');
  });

  it('formats zero with a leading +', () => {
    expect(formatDeltaPct(0)).toBe('+0.0%');
  });
});

describe('formatDist', () => {
  it('appends a p suffix and signs the value', () => {
    expect(formatDist(15)).toBe('+15p');
    expect(formatDist(-30)).toBe('-30p');
    expect(formatDist(0)).toBe('+0p');
  });

  it('rounds fractional points toward zero', () => {
    expect(formatDist(7.6)).toBe('+8p');
    expect(formatDist(-2.4)).toBe('-2p');
  });
});

describe('formatNet', () => {
  it('formats million-scale values with one decimal and M suffix', () => {
    expect(formatNet(2_400_000)).toBe('+2.4M');
    expect(formatNet(-1_700_000)).toBe('\u22121.7M');
  });

  it('formats thousand-scale values with no decimals and K suffix', () => {
    expect(formatNet(8_500)).toBe('+9K');
    expect(formatNet(-1_200)).toBe('\u22121K');
  });

  it('formats whole-number values without a unit suffix', () => {
    expect(formatNet(42)).toBe('+42');
    expect(formatNet(-7)).toBe('\u22127');
  });

  it('shows two decimals for fractional values below 0.5', () => {
    expect(formatNet(0.25)).toBe('+0.25');
    expect(formatNet(-0.13)).toBe('\u22120.13');
    expect(formatNet(0)).toBe('+0.00');
  });

  it('uses the unicode minus (\u2212), not ASCII hyphen', () => {
    expect(formatNet(-100)).toContain('\u2212');
    expect(formatNet(-100)).not.toContain('-');
  });
});
