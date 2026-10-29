import { describe, it, expect } from 'vitest';
import { gexbotBadge } from '../../utils/gexbot-badge';
import type { GexbotFireContext } from '../../types/gexbot';
import { dealerClaims } from '../helpers/dealer-claims';

/** Helper: build a full context overriding only the fields the test cares about. */
function ctx(overrides: Partial<GexbotFireContext> = {}): GexbotFireContext {
  return {
    oneCvroflow: 1.5,
    netPutDex: -1200,
    oneDexoflow: 1.3,
    oneGexoflow: 0.9,
    zcvr: 1.1,
    zeroGamma: 6850,
    spot: 6900,
    capturedAt: '2026-05-26T19:35:00Z',
    ...overrides,
  };
}

describe('gexbotBadge — null gate', () => {
  it('returns null when capturedAt is null (block treated as absent)', () => {
    expect(gexbotBadge(ctx({ capturedAt: null }))).toBeNull();
  });

  it('returns a badge when capturedAt is any non-null string (even other nulls inside)', () => {
    const result = gexbotBadge({
      oneCvroflow: null,
      netPutDex: null,
      oneDexoflow: null,
      oneGexoflow: null,
      zcvr: null,
      zeroGamma: null,
      spot: null,
      capturedAt: '2026-05-26T19:35:00Z',
    });
    expect(result).not.toBeNull();
  });
});

describe('gexbotBadge — direction arrow splits at 0', () => {
  it.each([
    [5, '↑', 'up'],
    [-5, '↓', 'down'],
    [0, '—', 'flat'],
  ])('cvroflow %s renders %s (%s)', (value, arrow, word) => {
    const b = gexbotBadge(ctx({ oneCvroflow: value }));
    expect(b?.label.startsWith(`GEX ${arrow}`)).toBe(true);
    expect(b?.ariaLabel).toContain(word);
  });

  it('shows ↑ for a small positive value that the old >1 split called down', () => {
    expect(gexbotBadge(ctx({ oneCvroflow: 0.4 }))?.label).toContain('↑');
  });

  it('renders · + flat when cvr is null', () => {
    const b = gexbotBadge(ctx({ oneCvroflow: null }));
    expect(b?.label).toContain('·');
    expect(b?.ariaLabel).toContain('flat');
    expect(b?.label).toContain('—');
  });
});

describe('gexbotBadge — tooltip formatting', () => {
  it('prints net put DEX raw with no 1e6 scaling and no M suffix', () => {
    const b = gexbotBadge(ctx({ netPutDex: -1234.4 }));
    expect(b?.tooltip).toContain('Net put DEX: -1234');
    expect(b?.tooltip).not.toMatch(/DEX: -?[\d.]+M/);
    expect(b?.tooltip).not.toContain('0.0M');
  });

  it('formats all numeric fields when fully populated', () => {
    const b = gexbotBadge(ctx());
    expect(b?.tooltip).toContain('Next-expiry cvroflow: 1.50');
    expect(b?.tooltip).toContain('Net convexity (zcvr): 1.10');
    expect(b?.tooltip).toContain('Next-expiry dexoflow: 1.30');
    expect(b?.tooltip).toContain('Next-expiry gexoflow: 0.90');
    expect(b?.tooltip).toContain('Snapshot at: 2026-05-26T19:35:00Z');
  });

  it('renders em-dash for each null numeric field independently', () => {
    const b = gexbotBadge(
      ctx({
        oneCvroflow: null,
        zcvr: null,
        netPutDex: null,
        oneDexoflow: null,
        oneGexoflow: null,
      }),
    );
    expect(b?.tooltip).toContain('Next-expiry cvroflow: —');
    expect(b?.tooltip).toContain('Net convexity (zcvr): —');
    expect(b?.tooltip).toContain('Net put DEX: —');
    expect(b?.tooltip).toContain('Next-expiry dexoflow: —');
    expect(b?.tooltip).toContain('Next-expiry gexoflow: —');
  });

  it('formats zero-gamma + spot delta when both present', () => {
    const b = gexbotBadge(ctx({ zeroGamma: 6850, spot: 6900 }));
    expect(b?.tooltip).toContain('zero-γ 6850 vs spot 6900 (Δ -50)');
  });

  it.each([
    [null, 6900],
    [6850, null],
    [null, null],
  ])('emits "zero-γ unavailable" for zeroGamma=%s spot=%s', (zg, spot) => {
    const b = gexbotBadge(ctx({ zeroGamma: zg, spot }));
    expect(b?.tooltip).toContain('zero-γ unavailable');
    expect(b?.tooltip).not.toContain('Δ');
  });

  it('drops the 1DTE+ wording and the 05-26 probe r-values', () => {
    const b = gexbotBadge(ctx());
    expect(b?.tooltip).not.toContain('1DTE+');
    expect(b?.tooltip).not.toMatch(/r vs hit/);
    expect(b?.tooltip).not.toMatch(/anti-signal/);
    expect(b?.tooltip).not.toContain('0DTE cvroflow');
    expect(b?.ariaLabel).not.toContain('1DTE+');
  });

  it('uses taker wording with no dealer claims in any text', () => {
    const b = gexbotBadge(ctx());
    expect(b?.tooltip).toContain('taker');
    expect(dealerClaims(b!.tooltip)).toEqual([]);
    expect(dealerClaims(b!.label)).toEqual([]);
    expect(dealerClaims(b!.ariaLabel)).toEqual([]);
  });
});

describe('gexbotBadge — shape and accessibility', () => {
  it('label combines GEX prefix + direction + cvr value', () => {
    expect(gexbotBadge(ctx({ oneCvroflow: 1.5 }))?.label).toBe('GEX ↑1.50');
  });

  it('cls is the sky-themed pill style (does not vary by direction)', () => {
    const up = gexbotBadge(ctx({ oneCvroflow: 1.5 }));
    const down = gexbotBadge(ctx({ oneCvroflow: -0.5 }));
    expect(up?.cls).toBe(down?.cls);
    expect(up?.cls).toContain('text-sky-200');
  });

  it('ariaLabel is single-line (no newline tokens that confuse screen readers)', () => {
    expect(gexbotBadge(ctx())?.ariaLabel).not.toContain('\n');
  });

  it('tooltip uses newlines to separate rows', () => {
    const newlines = (gexbotBadge(ctx())?.tooltip ?? '').split('\n').length - 1;
    expect(newlines).toBe(7);
  });
});
