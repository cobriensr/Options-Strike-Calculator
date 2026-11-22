import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LotteryTierBanner } from '../components/LotteryFinder/LotteryTierBanner';
import type {
  LotteryFire,
  LotteryFireMacro,
} from '../components/LotteryFinder/types';
import {
  srHintText,
  titledElementsNeedingHint,
  titledGenericsWithoutHint,
} from './helpers/aria';

// ── Fixture factory ──────────────────────────────────────────

function makeMacro(
  overrides: Partial<LotteryFireMacro> = {},
): LotteryFireMacro {
  return {
    mktTideNcp: null,
    mktTideNpp: null,
    mktTideDiff: null,
    mktTideOtmDiff: null,
    tickerCumNcpAtFire: null,
    tickerCumNppAtFire: null,
    spxFlowDiff: null,
    spyEtfDiff: null,
    qqqEtfDiff: null,
    zeroDteDiff: null,
    spxSpotGammaOi: null,
    spxSpotGammaVol: null,
    spxSpotCharmOi: null,
    spxSpotVannaOi: null,
    gexStrikeCallMinusPut: null,
    gexStrikeCallAskMinusBid: null,
    gexStrikePutAskMinusBid: null,
    gexStrikeActualStrike: null,
    ...overrides,
  };
}

function makeFire(overrides: Partial<LotteryFire> = {}): LotteryFire {
  return {
    id: 1,
    date: '2026-05-08',
    triggerTimeCt: '2026-05-08T14:30:00Z',
    entryTimeCt: '2026-05-08T14:31:00Z',
    optionChainId: 'AAPL260508C00200000',
    underlyingSymbol: 'AAPL',
    optionType: 'C',
    strike: 200,
    expiry: '2026-05-08',
    dte: 0,
    score: 15,
    scoreTier: 'tier2',
    directionGated: false,
    forecastHighPeakPct: '40-60%',
    avgHoldMinutes: 160,
    tickerStats: null,
    fireCount: 1,
    firstFireTimeCt: '2026-05-08T14:30:00Z',
    trigger: {
      volToOiWindow: 1.5,
      volToOiCum: 2.2,
      iv: 0.35,
      delta: 0.25,
      askPct: 0.7,
      windowSize: 5,
      windowPrints: 50,
    },
    entry: {
      price: 1.5,
      openInterest: 5000,
      spotAtFirst: 198,
      spotAtTrigger: 198,
      alertSeq: 1,
      minutesSincePrevFire: 30,
    },
    tags: {
      flowQuad: 'call_ask',
      tod: 'AM_open',
      mode: 'A_intraday_0DTE',
      reload: false,
      cheapCallPm: false,
      burstRatioVsPrev: null,
      entryDropPctVsPrev: null,
    },
    macro: makeMacro(),
    gex: {
      oneCvroflow: null,
      netPutDex: null,
      oneDexoflow: null,
      oneGexoflow: null,
      zcvr: null,
      zeroGamma: null,
      spot: null,
      capturedAt: null,
    },
    outcomes: {
      realizedTrail30_10Pct: null,
      realizedHard30mPct: null,
      realizedTier50HoldEodPct: null,
      realizedFlowInversionPct: null,
      realizedEodPct: null,
      peakCeilingPct: null,
      minutesToPeak: null,
      enrichedAt: null,
    },
    qualityAdjustedScore: 15,
    inversionQuintile: null,
    inversionBlend: null,
    inversionN21d: null,
    inversionN90d: null,
    insertedAt: '2026-05-08T14:31:00Z',
    ...overrides,
  };
}

// ============================================================
// EMPTY STATE
// ============================================================

describe('LotteryTierBanner: empty state', () => {
  it('renders empty-state line when fires array is empty', () => {
    render(<LotteryTierBanner fires={[]} total={0} />);
    expect(
      screen.getByText(
        'No lottery fires yet today — banner populates with the first fire.',
      ),
    ).toBeInTheDocument();
  });

  it('does not render the headline when no fires', () => {
    render(<LotteryTierBanner fires={[]} total={0} />);
    expect(screen.queryByText(/This page/)).not.toBeInTheDocument();
  });
});

// ============================================================
// SINGULAR vs PLURAL
// ============================================================

describe('LotteryTierBanner: singular vs plural', () => {
  it('renders "1 fire" (no s) when the page holds one fire', () => {
    render(
      <LotteryTierBanner
        fires={[makeFire({ scoreTier: 'tier1', score: 20 })]}
        total={1}
      />,
    );
    // Headline pluralizes off the PAGE count (fires.length), not `total`.
    expect(screen.getByText(/This page · 1 fire$/)).toBeInTheDocument();
  });

  it('renders "N fires" (with s) when the page holds multiple fires', () => {
    render(
      <LotteryTierBanner
        fires={[
          makeFire({ id: 1, scoreTier: 'tier1', score: 20 }),
          makeFire({ id: 2, scoreTier: 'tier2', score: 14 }),
        ]}
        total={2}
      />,
    );
    expect(screen.getByText(/This page · 2 fires/)).toBeInTheDocument();
  });

  it('formats large page counts with toLocaleString', () => {
    // 1234 page rows → "1,234 fires" (locale-dependent — toLocaleString in
    // jsdom defaults to en-US which uses comma group separators). Build a
    // page array of that length so the headline reflects the page count.
    const fires = Array.from({ length: 1234 }, (_, i) =>
      makeFire({ id: i + 1, scoreTier: 'tier3', score: 8 }),
    );
    render(<LotteryTierBanner fires={fires} total={1234} />);
    expect(screen.getByText(/This page · 1,234 fires/)).toBeInTheDocument();
  });
});

// ============================================================
// DENOMINATOR COHERENCE (Fix 5)
// ============================================================

describe('LotteryTierBanner: denominator coherence', () => {
  it('headline page count equals the tier sum (t1 + t2 + t3)', () => {
    // 5 fires on the page: 2 tier1, 1 tier2, 2 tier3 → sum 5 === page count.
    const fires: LotteryFire[] = [
      makeFire({ id: 1, scoreTier: 'tier1', score: 20 }),
      makeFire({ id: 2, scoreTier: 'tier1', score: 19 }),
      makeFire({ id: 3, scoreTier: 'tier2', score: 14 }),
      makeFire({ id: 4, scoreTier: 'tier3', score: 6 }),
      makeFire({ id: 5, scoreTier: 'tier3', score: 5 }),
    ];
    // Full-day total is much larger (paginated view).
    render(<LotteryTierBanner fires={fires} total={372} />);

    // Headline number is the PAGE count, which equals 2 + 1 + 2 = 5.
    expect(screen.getByText(/This page · 5 fires/)).toBeInTheDocument();
    expect(screen.getByText('🔥🔥🔥 2')).toBeInTheDocument();
    expect(screen.getByText('🔥🔥 1')).toBeInTheDocument();
    expect(screen.getByText('🔥 2')).toBeInTheDocument();
  });

  it('surfaces the full-day total separately when it exceeds the page', () => {
    const fires: LotteryFire[] = [
      makeFire({ id: 1, scoreTier: 'tier1', score: 20 }),
      makeFire({ id: 2, scoreTier: 'tier2', score: 14 }),
    ];
    render(<LotteryTierBanner fires={fires} total={372} />);

    expect(screen.getByText(/This page · 2 fires/)).toBeInTheDocument();
    // Full-day total appears in a distinct, clearly labelled clause.
    expect(screen.getByText(/of 372 today/)).toBeInTheDocument();
  });

  it('omits the "of N today" clause when the page holds the whole day', () => {
    const fires: LotteryFire[] = [
      makeFire({ id: 1, scoreTier: 'tier1', score: 20 }),
      makeFire({ id: 2, scoreTier: 'tier2', score: 14 }),
    ];
    render(<LotteryTierBanner fires={fires} total={2} />);

    expect(screen.getByText(/This page · 2 fires/)).toBeInTheDocument();
    expect(screen.queryByText(/today/)).not.toBeInTheDocument();
  });
});

// ============================================================
// TIER COUNTS
// ============================================================

describe('LotteryTierBanner: tier counts', () => {
  it('counts tier1, tier2, tier3 correctly across mixed fires', () => {
    const fires: LotteryFire[] = [
      makeFire({ id: 1, scoreTier: 'tier1', score: 20 }),
      makeFire({ id: 2, scoreTier: 'tier1', score: 19 }),
      makeFire({ id: 3, scoreTier: 'tier2', score: 14 }),
      makeFire({ id: 4, scoreTier: 'tier3', score: 6 }),
      makeFire({ id: 5, scoreTier: 'tier3', score: 5 }),
      makeFire({ id: 6, scoreTier: 'tier3', score: 4 }),
    ];
    render(<LotteryTierBanner fires={fires} total={6} />);

    expect(screen.getByText('🔥🔥🔥 2')).toBeInTheDocument();
    expect(screen.getByText('🔥🔥 1')).toBeInTheDocument();
    expect(screen.getByText('🔥 3')).toBeInTheDocument();
  });
});

// ============================================================
// TIER CUTOFFS (the response's, not a fixed pair)
// ============================================================

describe('LotteryTierBanner: tier cutoffs', () => {
  const fires: LotteryFire[] = [
    makeFire({ id: 1, scoreTier: 'tier1', score: 20 }),
    makeFire({ id: 2, scoreTier: 'tier2', score: 14 }),
    makeFire({ id: 3, scoreTier: 'tier3', score: 4 }),
  ];
  const tierTitles = () => ({
    tier1: screen.getByText('🔥🔥🔥 1').getAttribute('title'),
    tier2: screen.getByText('🔥🔥 1').getAttribute('title'),
    tier3: screen.getByText('🔥 1').getAttribute('title'),
  });

  it("names the bands from the response's cutoffs", () => {
    render(
      <LotteryTierBanner
        fires={fires}
        total={3}
        cutoffs={{
          version: 'refit-2026-11-13',
          tier1MinScore: 16,
          tier2MinScore: 12,
        }}
      />,
    );

    const titles = tierTitles();
    expect(titles.tier1).toContain('(qas ≥ 16)');
    expect(titles.tier2).toContain('(qas 12–15)');
    expect(titles.tier3).toContain('(qas < 12)');
  });

  it('follows a change of cutoffs, as after a promotion', () => {
    const { rerender } = render(
      <LotteryTierBanner
        fires={fires}
        total={3}
        cutoffs={{
          version: 'seed-2026-06-17',
          tier1MinScore: 13,
          tier2MinScore: 10,
        }}
      />,
    );
    expect(tierTitles().tier1).toContain('(qas ≥ 13)');

    rerender(
      <LotteryTierBanner
        fires={fires}
        total={3}
        cutoffs={{
          version: 'refit-2026-11-13',
          tier1MinScore: 17,
          tier2MinScore: 11,
        }}
      />,
    );

    expect(tierTitles().tier1).toContain('(qas ≥ 17)');
    expect(tierTitles().tier2).toContain('(qas 11–16)');
  });

  it('says no number before a response has carried the cutoffs', () => {
    render(<LotteryTierBanner fires={fires} total={3} />);

    for (const title of Object.values(tierTitles())) {
      // No cutoff, and none of the fixed 18 / 12 the banner used to print.
      expect(title).not.toMatch(/qas|score [≥<0-9]|18|12/);
      expect(title).toMatch(/^Tier [123] fires on the current page\./);
    }
  });

  it('labels the quoted rates with the weights they were measured on', () => {
    render(<LotteryTierBanner fires={fires} total={3} />);

    expect(tierTitles().tier1).toContain(
      'high-peak rate ~80%, measured on the 06-17 seed weights.',
    );
  });
});

// ============================================================
// DOMINANT TICKER
// ============================================================

describe('LotteryTierBanner: dominant ticker', () => {
  it('picks the ticker with the highest count as dominant', () => {
    const fires: LotteryFire[] = [
      makeFire({ id: 1, underlyingSymbol: 'AAPL', score: 20 }),
      makeFire({ id: 2, underlyingSymbol: 'AAPL', score: 18 }),
      makeFire({ id: 3, underlyingSymbol: 'AAPL', score: 15 }),
      makeFire({ id: 4, underlyingSymbol: 'TSLA', score: 12 }),
      makeFire({ id: 5, underlyingSymbol: 'NVDA', score: 8 }),
    ];
    render(<LotteryTierBanner fires={fires} total={5} />);

    // AAPL appears 3x, dominant — verify the ×3 count is rendered.
    // Note: "AAPL" appears in both the dominant-ticker pill AND the
    // top-score pill (since the top-scoring fire is also AAPL), so we
    // assert via getAllByText rather than getByText.
    expect(screen.getAllByText('AAPL').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('×3')).toBeInTheDocument();
    // TSLA / NVDA should not appear in the dominant pill as ×1.
    expect(screen.queryByText('×1')).not.toBeInTheDocument();
  });
});

// ============================================================
// TOP FIRE BY SCORE
// ============================================================

describe('LotteryTierBanner: top fire', () => {
  it('selects the fire with the highest score as top', () => {
    const fires: LotteryFire[] = [
      makeFire({ id: 1, underlyingSymbol: 'AAPL', score: 12 }),
      makeFire({ id: 2, underlyingSymbol: 'TSLA', score: 22 }),
      makeFire({ id: 3, underlyingSymbol: 'NVDA', score: 18 }),
    ];
    render(<LotteryTierBanner fires={fires} total={3} />);

    // Top score should be 22 from TSLA.
    expect(screen.getByText('22')).toBeInTheDocument();
    // The "top score:" tooltip should reference the top-scoring fire.
    const tslaSpans = screen.getAllByText('TSLA');
    expect(tslaSpans.length).toBeGreaterThan(0);
  });

  it('treats null scores as -Infinity so a real-scored fire wins', () => {
    const fires: LotteryFire[] = [
      makeFire({ id: 1, underlyingSymbol: 'AAPL', score: null }),
      makeFire({ id: 2, underlyingSymbol: 'TSLA', score: 5 }),
    ];
    render(<LotteryTierBanner fires={fires} total={2} />);

    // TSLA (score 5) wins over AAPL (null).
    expect(screen.getByText('5')).toBeInTheDocument();
  });
});

// ============================================================
// FOOTER
// ============================================================

describe('LotteryTierBanner: footer', () => {
  it('renders the "counts on current page" footer text', () => {
    render(
      <LotteryTierBanner
        fires={[makeFire({ scoreTier: 'tier2', score: 13 })]}
        total={1}
      />,
    );
    expect(screen.getByText('counts on current page')).toBeInTheDocument();
  });
});

// ============================================================
// Hover text for screen readers
// ============================================================

describe('LotteryTierBanner: hover text for screen readers', () => {
  const CUTOFFS = {
    version: 'refit-2026-11-13',
    tier1MinScore: 16,
    tier2MinScore: 12,
  };
  const twoFires: LotteryFire[] = [
    makeFire({ id: 1, scoreTier: 'tier1', score: 20 }),
    makeFire({ id: 2, scoreTier: 'tier2', score: 14 }),
  ];

  describe('headline', () => {
    it.each([
      [
        'a page that is part of a longer day',
        twoFires,
        372,
        /This page · 2 fires/,
        'Tier breakdown below covers the 2 fires on this page; 372 fired across the full day.',
      ],
      [
        'a one-fire page of a longer day',
        [twoFires[0]!],
        372,
        /This page · 1 fire/,
        'Tier breakdown below covers the 1 fire on this page; 372 fired across the full day.',
      ],
    ])(
      'repeats the title as the hint for %s',
      (_name, fires, total, text, title) => {
        render(<LotteryTierBanner fires={fires} total={total} />);
        const headline = screen.getByText(text);
        expect(srHintText(headline)).toBe(title);
        expect(headline).toHaveAttribute('title', title);
      },
    );

    it.each([
      [
        'a page that holds the whole day',
        twoFires,
        /This page · 2 fires/,
        'All 2 fires today are shown on this page.',
      ],
      [
        'a one-fire day',
        [twoFires[0]!],
        /This page · 1 fire/,
        'All 1 fire today are shown on this page.',
      ],
    ])(
      'gives %s a hint that keeps the word today out',
      (_name, fires, text, title) => {
        render(<LotteryTierBanner fires={fires} total={fires.length} />);
        const headline = screen.getByText(text);
        expect(srHintText(headline)).toBe(
          'every fire of the day is on this page',
        );
        expect(headline).toHaveAttribute('title', title);
        // No text on the page says "today": the hint does not either.
        expect(screen.queryByText(/today/)).not.toBeInTheDocument();
      },
    );
  });

  describe('tier counts', () => {
    it.each([
      [
        '🔥🔥🔥 1',
        'Tier 1 fires on the current page (qas ≥ 16). Historical high-peak rate ~80%, measured on the 06-17 seed weights.',
      ],
      [
        '🔥🔥 1',
        'Tier 2 fires on the current page (qas 12–15). Historical high-peak rate ~63%, measured on the 06-17 seed weights.',
      ],
      [
        '🔥 0',
        'Tier 3 fires on the current page (qas < 12). Historical high-peak rate ~32%, measured on the 06-17 seed weights.',
      ],
    ])(
      'repeats the title of %s as the hint, with the cutoffs',
      (text, title) => {
        render(
          <LotteryTierBanner fires={twoFires} total={2} cutoffs={CUTOFFS} />,
        );
        const count = screen.getByText(text);
        expect(srHintText(count)).toBe(title);
        expect(count).toHaveAttribute('title', title);
      },
    );

    it.each([
      [
        '🔥🔥🔥 1',
        'Tier 1 fires on the current page. Historical high-peak rate ~80%, measured on the 06-17 seed weights.',
      ],
      [
        '🔥🔥 1',
        'Tier 2 fires on the current page. Historical high-peak rate ~63%, measured on the 06-17 seed weights.',
      ],
      [
        '🔥 0',
        'Tier 3 fires on the current page. Historical high-peak rate ~32%, measured on the 06-17 seed weights.',
      ],
    ])(
      'repeats the title of %s as the hint, before the cutoffs arrive',
      (text, title) => {
        render(<LotteryTierBanner fires={twoFires} total={2} />);
        const count = screen.getByText(text);
        expect(srHintText(count)).toBe(title);
        expect(count).toHaveAttribute('title', title);
      },
    );
  });

  describe('dominant ticker and top score', () => {
    const fires: LotteryFire[] = [
      makeFire({ id: 1, underlyingSymbol: 'AAPL', score: 20, strike: 200 }),
      makeFire({ id: 2, underlyingSymbol: 'AAPL', score: 18 }),
      makeFire({
        id: 3,
        underlyingSymbol: 'TSLA',
        score: 12,
        strike: 250,
        optionType: 'P',
      }),
    ];

    it('explains the dominant ticker without naming it, and keeps its title', () => {
      render(<LotteryTierBanner fires={fires} total={3} />);
      const pill = screen.getByText('top:');
      expect(srHintText(pill)).toBe(
        'most fires of any ticker on the current page',
      );
      expect(pill).toHaveAttribute(
        'title',
        "AAPL dominates today's lottery feed with 2 fires on the current page.",
      );
      // The hint is the pill's own last child, after the ticker spans.
      expect(pill.lastElementChild).toHaveClass('sr-only');
    });

    it('explains the top score with the contract, without naming the ticker, and keeps its title', () => {
      render(<LotteryTierBanner fires={fires} total={3} />);
      const pill = screen.getByText('top score:');
      expect(srHintText(pill)).toBe(
        '200C, highest-scoring fire in the current view',
      );
      expect(pill).toHaveAttribute(
        'title',
        'Highest-scoring fire in the current view: AAPL 200C at score 20.',
      );
      expect(pill.lastElementChild).toHaveClass('sr-only');
    });

    it('names a put contract in the top-score hint', () => {
      render(
        <LotteryTierBanner
          fires={[
            makeFire({
              id: 1,
              underlyingSymbol: 'TSLA',
              score: 30,
              strike: 250,
              optionType: 'P',
            }),
          ]}
          total={1}
        />,
      );
      expect(srHintText(screen.getByText('top score:'))).toBe(
        '250P, highest-scoring fire in the current view',
      );
    });

    it('keeps the ticker queries to the two ticker spans: neither hint names one', () => {
      render(<LotteryTierBanner fires={fires} total={3} />);
      // One in the dominant-ticker pill, one in the top-score pill.
      expect(screen.getAllByText('AAPL')).toHaveLength(2);
    });
  });

  it('leaves no titled generic element without a hint, and reaches all six', () => {
    const { container } = render(
      <LotteryTierBanner
        fires={[
          makeFire({ id: 1, scoreTier: 'tier1', score: 20 }),
          makeFire({ id: 2, scoreTier: 'tier2', score: 14 }),
        ]}
        total={372}
        cutoffs={CUTOFFS}
      />,
    );
    // Headline, three tier counts, dominant ticker and top score.
    expect(titledElementsNeedingHint(container)).toHaveLength(6);
    expect(titledGenericsWithoutHint(container)).toEqual([]);
  });

  it('leaves no titled generic element without a hint when the page holds the whole day', () => {
    const { container } = render(
      <LotteryTierBanner fires={twoFires} total={2} />,
    );
    expect(titledElementsNeedingHint(container)).toHaveLength(6);
    expect(titledGenericsWithoutHint(container)).toEqual([]);
  });
});
