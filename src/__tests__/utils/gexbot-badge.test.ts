import { describe, it, expect } from 'vitest';
import { gexbotBadge } from '../../utils/gexbot-badge';
import type { GexbotFireContext } from '../../types/gexbot';

/** Helper: build a full context overriding only the fields the test cares about. */
function ctx(overrides: Partial<GexbotFireContext> = {}): GexbotFireContext {
  return {
    oneCvroflow: 1.5,
    netPutDex: -1_200_000,
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

describe('gexbotBadge — direction arrow from oneCvroflow', () => {
  it('renders ↑ + up arrowWord when cvr > 1', () => {
    const b = gexbotBadge(ctx({ oneCvroflow: 1.8 }));
    expect(b?.label).toContain('↑');
    expect(b?.ariaLabel).toContain('up');
  });

  it('renders ↓ + down arrowWord when cvr < 1', () => {
    const b = gexbotBadge(ctx({ oneCvroflow: 0.5 }));
    expect(b?.label).toContain('↓');
    expect(b?.ariaLabel).toContain('down');
  });

  it('renders · + flat arrowWord when cvr == 1 exactly', () => {
    const b = gexbotBadge(ctx({ oneCvroflow: 1 }));
    expect(b?.label).toContain('·');
    expect(b?.ariaLabel).toContain('flat');
  });

  it('renders · + flat arrowWord when cvr is null', () => {
    const b = gexbotBadge(ctx({ oneCvroflow: null }));
    expect(b?.label).toContain('·');
    expect(b?.ariaLabel).toContain('flat');
    // cvrStr renders as em-dash in label
    expect(b?.label).toContain('—');
  });
});

describe('gexbotBadge — tooltip formatting', () => {
  it('formats all numeric fields when fully populated', () => {
    const b = gexbotBadge(ctx());
    expect(b?.tooltip).toContain('1DTE+ cvroflow: 1.50');
    expect(b?.tooltip).toContain('0DTE cvroflow (zcvr): 1.10');
    // netPutDex / 1e6 = -1.2M
    expect(b?.tooltip).toContain('Net put DEX: -1.2M');
    expect(b?.tooltip).toContain('1DTE+ dexoflow: 1.30');
    expect(b?.tooltip).toContain('1DTE+ gexoflow: 0.90');
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
    expect(b?.tooltip).toContain('1DTE+ cvroflow: —');
    expect(b?.tooltip).toContain('0DTE cvroflow (zcvr): —');
    expect(b?.tooltip).toContain('Net put DEX: —');
    expect(b?.tooltip).toContain('1DTE+ dexoflow: —');
    expect(b?.tooltip).toContain('1DTE+ gexoflow: —');
  });

  it('formats zero-gamma + spot delta when both present', () => {
    const b = gexbotBadge(ctx({ zeroGamma: 6850, spot: 6900 }));
    // Δ = 6850 - 6900 = -50
    expect(b?.tooltip).toContain('zero-γ 6850 vs spot 6900 (Δ -50)');
  });

  it('emits "zero-γ unavailable" when zeroGamma is null but spot is not', () => {
    const b = gexbotBadge(ctx({ zeroGamma: null, spot: 6900 }));
    expect(b?.tooltip).toContain('zero-γ unavailable');
    expect(b?.tooltip).not.toContain('Δ');
  });

  it('emits "zero-γ unavailable" when spot is null but zeroGamma is not', () => {
    const b = gexbotBadge(ctx({ zeroGamma: 6850, spot: null }));
    expect(b?.tooltip).toContain('zero-γ unavailable');
  });

  it('emits "zero-γ unavailable" when both are null', () => {
    const b = gexbotBadge(ctx({ zeroGamma: null, spot: null }));
    expect(b?.tooltip).toContain('zero-γ unavailable');
  });
});

describe('gexbotBadge — shape and accessibility', () => {
  it('label combines GEX prefix + direction + cvr value', () => {
    const b = gexbotBadge(ctx({ oneCvroflow: 1.5 }));
    expect(b?.label).toBe('GEX ↑1.50');
  });

  it('cls is the sky-themed pill style (does not vary by direction)', () => {
    const up = gexbotBadge(ctx({ oneCvroflow: 1.5 }));
    const down = gexbotBadge(ctx({ oneCvroflow: 0.5 }));
    expect(up?.cls).toBe(down?.cls);
    expect(up?.cls).toContain('text-sky-200');
  });

  it('ariaLabel is single-line (no newline tokens that confuse screen readers)', () => {
    const b = gexbotBadge(ctx());
    expect(b?.ariaLabel).not.toContain('\n');
  });

  it('tooltip uses newlines to separate rows', () => {
    const b = gexbotBadge(ctx());
    // 8 rows joined by \n → 7 newlines
    const newlines = (b?.tooltip ?? '').split('\n').length - 1;
    expect(newlines).toBe(7);
  });
});
