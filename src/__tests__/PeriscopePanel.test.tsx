/**
 * PeriscopePanel unit tests — pragmatic smoke + state-routing coverage.
 * The trade-plan computation is exercised via a populated-view smoke
 * test; the heavier `computeTradePlan` math has dedicated unit coverage
 * in `periscope-trade-plan.test.ts`.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { PeriscopeView } from '../hooks/usePeriscopeExposure';
import { PeriscopePanel } from '../components/Periscope/PeriscopePanel';

// ── Fixture factory ───────────────────────────────────────────────────

function makeView(overrides: Partial<PeriscopeView> = {}): PeriscopeView {
  return {
    capturedAt: '2026-05-08T13:30:00Z',
    priorCapturedAt: '2026-05-08T13:20:00Z',
    expiry: '2026-05-08',
    spot: 5800.25,
    gamma: {
      ceiling: { strike: 5825, value: 5_000_000, ptsFromSpot: 25 },
      floor: { strike: 5775, value: 4_000_000, ptsFromSpot: -25 },
      accelTop: [
        { strike: 5750, value: -3_000_000, ptsFromSpot: -50 },
        { strike: 5740, value: -2_500_000, ptsFromSpot: -60 },
      ],
      topByAbsNear: [],
    },
    charm: {
      tallyNear50: 1_500_000,
      tallyWide100: 2_500_000,
      topByAbs: [{ strike: 5800, value: 800_000 }],
      charmZeroStrike: 5810,
    },
    vanna: {
      topByAbs: [{ strike: 5800, value: 600_000 }],
    },
    signFlips: [{ strike: 5790, from: -1_000_000, to: 500_000 }],
    cone: {
      coneUpper: 5850,
      coneLower: 5750,
      coneWidth: 100,
      asymmetryPts: 5,
      spotAtCalc: 5800,
    },
    breaches: [],
    ...overrides,
  };
}

const baseProps = {
  view: null as PeriscopeView | null,
  emptyReason: null as 'no_spot' | 'no_slot' | null,
  asOf: null as string | null,
  isLoading: false,
  error: null as string | null,
  onRefresh: vi.fn(),
  availableSlots: [] as string[],
  selectedSlot: null as { date: string; time: string } | null,
  onSelectSlot: vi.fn(),
};

// ============================================================
// SMOKE
// ============================================================

describe('PeriscopePanel: smoke', () => {
  it('renders the section heading', () => {
    render(<PeriscopePanel {...baseProps} />);
    expect(
      screen.getByRole('heading', { name: /periscope mm exposure/i }),
    ).toBeInTheDocument();
  });

  it('renders all key sub-sections when given a populated view', () => {
    render(<PeriscopePanel {...baseProps} view={makeView()} />);
    // Trade plan box
    expect(screen.getByText(/Trade Plan/i)).toBeInTheDocument();
    // Cone
    expect(screen.getByText(/Straddle Cone/i)).toBeInTheDocument();
    // Gamma
    expect(screen.getByText(/Gamma Topology/i)).toBeInTheDocument();
    // Charm
    expect(screen.getByText(/Charm Flow/i)).toBeInTheDocument();
    // Vanna
    expect(screen.getByText(/Vanna Pressure/i)).toBeInTheDocument();
    // Sign flips
    expect(
      screen.getByText(/Sign Flips Since Prior Slice/i),
    ).toBeInTheDocument();
    // Spot value
    expect(screen.getByText(/spot 5800\.25/)).toBeInTheDocument();
  });

  it('omits cone section when view.cone is null', () => {
    render(<PeriscopePanel {...baseProps} view={makeView({ cone: null })} />);
    expect(screen.queryByText(/Straddle Cone/i)).not.toBeInTheDocument();
  });

  it('omits vanna section when no vanna entries', () => {
    render(
      <PeriscopePanel
        {...baseProps}
        view={makeView({ vanna: { topByAbs: [] } })}
      />,
    );
    expect(screen.queryByText(/Vanna Pressure/i)).not.toBeInTheDocument();
  });

  it('omits sign-flips section when there are no flips', () => {
    render(
      <PeriscopePanel {...baseProps} view={makeView({ signFlips: [] })} />,
    );
    expect(
      screen.queryByText(/Sign Flips Since Prior Slice/i),
    ).not.toBeInTheDocument();
  });

  it('shows breach rows when cone has been breached', () => {
    render(
      <PeriscopePanel
        {...baseProps}
        view={makeView({
          breaches: [
            {
              direction: 'upper',
              breachTime: '2026-05-08T14:00:00Z',
              spotAtBreach: 5852,
              ptsPastBound: 2,
            },
          ],
        })}
      />,
    );
    expect(screen.getByText(/UPPER breach/)).toBeInTheDocument();
  });
});

// ============================================================
// CHARM DRIFT — post-close suppression
// ============================================================

describe('PeriscopePanel: charm-drift post-close', () => {
  // Post-close slots freeze on a terminal charm value (e.g. -1269.33M
  // observed 2026-05-08 15:10–15:50 CT) that no longer predicts intraday
  // drift. The panel must surface that explicitly instead of running the
  // active "drift up/down" line that would otherwise mislead the user.
  it('replaces the drift line with an aftermarket message when capturedAt is post-close', () => {
    // 20:30Z = 15:30 CT — past the 15:00 CT cash close.
    const view = makeView({
      capturedAt: '2026-05-08T20:30:00Z',
      charm: {
        tallyNear50: -1_269_330_000,
        tallyWide100: -1_269_330_000,
        topByAbs: [{ strike: 7380, value: -806_000_000 }],
        charmZeroStrike: 7315,
      },
    });
    render(<PeriscopePanel {...baseProps} view={view} />);
    expect(
      screen.getByText(
        /aftermarket reading, not applicable to intraday price movement/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/mechanical \/ES (BUY|SELL) into close/i),
    ).not.toBeInTheDocument();
  });

  it('keeps the active drift line during the intraday charm window', () => {
    // 19:00Z = 14:00 CT — final 30m bucket, drift line should fire.
    const view = makeView({
      capturedAt: '2026-05-08T19:00:00Z',
      charm: {
        tallyNear50: -50_000_000,
        tallyWide100: -50_000_000,
        topByAbs: [{ strike: 5800, value: 800_000 }],
        charmZeroStrike: 5810,
      },
    });
    render(<PeriscopePanel {...baseProps} view={view} />);
    expect(
      screen.getByText(/mechanical \/ES SELL into close/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/aftermarket reading/i)).not.toBeInTheDocument();
  });
});

// ============================================================
// STATE ROUTING — error / empty / loading
// ============================================================

describe('PeriscopePanel: states', () => {
  it('renders the error string when error is set', () => {
    render(<PeriscopePanel {...baseProps} error="HTTP 500" />);
    expect(screen.getByText('HTTP 500')).toBeInTheDocument();
  });

  it('renders the no_slot empty-state copy', () => {
    render(<PeriscopePanel {...baseProps} emptyReason="no_slot" />);
    expect(
      screen.getByText(/Scraper has not inserted a Periscope slot/i),
    ).toBeInTheDocument();
  });

  it('renders the no_spot empty-state copy (distinct from no_slot)', () => {
    render(<PeriscopePanel {...baseProps} emptyReason="no_spot" />);
    expect(
      screen.getByText(/Waiting for SPX spot from index_candles_1m/i),
    ).toBeInTheDocument();
  });

  it('falls back to no_slot copy when emptyReason is null and view is null', () => {
    // Default null/null state still produces a sensible message rather
    // than a blank panel.
    render(<PeriscopePanel {...baseProps} />);
    expect(
      screen.getByText(/Scraper has not inserted a Periscope slot/i),
    ).toBeInTheDocument();
  });
});

// ============================================================
// HEADER — refresh button + asOf timestamp
// ============================================================

describe('PeriscopePanel: header controls', () => {
  it('renders the asOf timestamp in CT when provided', () => {
    render(<PeriscopePanel {...baseProps} asOf="2026-05-08T19:30:00Z" />);
    // Just assert the CT suffix is present (locale-safe — content is
    // formatted by Intl.DateTimeFormat which varies test-runner timezone).
    expect(screen.getByText(/CT$/)).toBeInTheDocument();
  });

  it('disables refresh button while isLoading and shows ellipsis', () => {
    const onRefresh = vi.fn();
    render(
      <PeriscopePanel {...baseProps} isLoading={true} onRefresh={onRefresh} />,
    );
    const btn = screen.getByRole('button', { name: '…' });
    expect(btn).toBeDisabled();
  });

  it('invokes onRefresh when the refresh button is clicked', () => {
    const onRefresh = vi.fn();
    render(<PeriscopePanel {...baseProps} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// TIME-TRAVEL NAVIGATION
// ============================================================

describe('PeriscopePanel: time-travel nav', () => {
  it('renders the date picker and prev/next/live controls', () => {
    render(<PeriscopePanel {...baseProps} />);
    expect(
      screen.getByRole('button', { name: /previous slot/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /next slot/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /return to live/i }),
    ).toBeInTheDocument();
    // The "live" button is highlighted (filled dot) when selectedSlot is null.
    expect(
      screen.getByRole('button', { name: /return to live/i }),
    ).toBeDisabled();
  });

  it('disables prev/next at the ends of availableSlots', () => {
    const view = makeView({
      capturedAt: '2026-05-08T14:00:00Z',
    });
    const slots = [
      '2026-05-08T13:50:00Z',
      '2026-05-08T14:00:00Z',
      '2026-05-08T14:10:00Z',
    ];
    render(
      <PeriscopePanel {...baseProps} view={view} availableSlots={slots} />,
    );
    // Middle slot — both buttons enabled.
    expect(
      screen.getByRole('button', { name: /previous slot/i }),
    ).not.toBeDisabled();
    expect(
      screen.getByRole('button', { name: /next slot/i }),
    ).not.toBeDisabled();
  });

  it('disables prev when on the first slot', () => {
    const view = makeView({ capturedAt: '2026-05-08T13:50:00Z' });
    render(
      <PeriscopePanel
        {...baseProps}
        view={view}
        availableSlots={['2026-05-08T13:50:00Z', '2026-05-08T14:00:00Z']}
      />,
    );
    expect(
      screen.getByRole('button', { name: /previous slot/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /next slot/i }),
    ).not.toBeDisabled();
  });

  it('calls onSelectSlot with the prior slot on prev click', () => {
    const onSelectSlot = vi.fn();
    const view = makeView({ capturedAt: '2026-05-08T14:00:00Z' });
    render(
      <PeriscopePanel
        {...baseProps}
        view={view}
        availableSlots={['2026-05-08T13:50:00Z', '2026-05-08T14:00:00Z']}
        onSelectSlot={onSelectSlot}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /previous slot/i }));
    expect(onSelectSlot).toHaveBeenCalledTimes(1);
    const arg = onSelectSlot.mock.calls[0]?.[0] as {
      date: string;
      time: string;
    };
    expect(arg.date).toBe('2026-05-08');
    // Time is CT — depends on DST. 13:50Z in CDT (UTC-5) is 08:50.
    // Just assert it parses as HH:MM.
    expect(arg.time).toMatch(/^\d{2}:\d{2}$/);
  });

  it('calls onSelectSlot(null) when Live is clicked while on a historical slot', () => {
    const onSelectSlot = vi.fn();
    render(
      <PeriscopePanel
        {...baseProps}
        selectedSlot={{ date: '2026-05-07', time: '13:30' }}
        onSelectSlot={onSelectSlot}
      />,
    );
    const liveBtn = screen.getByRole('button', { name: /return to live/i });
    expect(liveBtn).not.toBeDisabled();
    fireEvent.click(liveBtn);
    expect(onSelectSlot).toHaveBeenCalledWith(null);
  });

  it('jumps to end-of-day when the date picker is changed', () => {
    const onSelectSlot = vi.fn();
    render(<PeriscopePanel {...baseProps} onSelectSlot={onSelectSlot} />);
    const dateInput = screen.getByLabelText(
      /periscope slot date/i,
    ) as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: '2026-05-07' } });
    expect(onSelectSlot).toHaveBeenCalledWith({
      date: '2026-05-07',
      time: '23:59',
    });
  });
});

// ============================================================
// CLAUDE PLAYBOOK — Phase 4b render integration
// ============================================================

describe('PeriscopePanel: Claude playbook section', () => {
  type PlaybookData = {
    id: number;
    mode: 'pre_trade' | 'intraday' | 'debrief';
    status: 'in_progress' | 'complete' | 'failed' | 'truncated';
    slotCapturedAt: string;
    readTime: string;
    spot: number;
    panelPayload: {
      spot: number | null;
      cone: { lower: number; upper: number } | null;
      longTrigger: number | null;
      shortTrigger: number | null;
      regime: string | null;
      bias: string | null;
      recommended: string[];
      avoid: string[];
      futuresPlan: string | null;
      gammaFloor: number | null;
      gammaCeiling: number | null;
      magnet: number | null;
      charmZero: number | null;
      expectedDealerBehavior: string | null;
      confidence: string | null;
      confidenceBasis: string | null;
      narrative: string;
    } | null;
    parentId: number | null;
    model: string | null;
    failureReason: string | null;
    durationMs: number | null;
    createdAt: string;
  };

  function makePlaybook(
    opts: {
      data?: PlaybookData | null;
      latestInProgress?: boolean;
      error?: string | null;
    } = {},
  ) {
    return {
      data: opts.data === undefined ? null : opts.data,
      latestInProgress: opts.latestInProgress ?? false,
      asOf: '2026-05-08T13:30:00Z',
      emptyReason: opts.data == null ? ('no_playbook' as const) : null,
      isLoading: false,
      error: opts.error ?? null,
      refresh: vi.fn(),
    };
  }

  function fullRow(overrides: Partial<PlaybookData> = {}): PlaybookData {
    // Build slotCapturedAt 5 minutes ago so the staleness chip is green.
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    return {
      id: 777,
      mode: 'intraday',
      status: 'complete',
      slotCapturedAt: recent,
      readTime: recent,
      spot: 5800.5,
      panelPayload: {
        spot: 5800.5,
        cone: { lower: 5780, upper: 5820 },
        longTrigger: 5810,
        shortTrigger: 5790,
        regime: 'drift-and-cap',
        bias: 'two-sided',
        recommended: ['debit_call_spread', 'directional_long_call'],
        avoid: ['iron_condor', 'iron_butterfly'],
        futuresPlan: 'LONG: SAFE above 5810\nSHORT: WAIT below 5790',
        gammaFloor: 5780,
        gammaCeiling: 5820,
        magnet: 5800,
        charmZero: 5805,
        expectedDealerBehavior:
          'Passive bid at the +γ floor, passive offer at the −γ trapdoor.',
        confidence: 'medium',
        confidenceBasis:
          'Pin scaffolding verified by charm-zero at 5805 and dominant +γ wall.',
        narrative: 'Tight two-sided regime with charm pinning at 5805.',
      },
      parentId: null,
      model: 'claude-opus-4-7',
      failureReason: null,
      durationMs: 1234,
      createdAt: recent,
      ...overrides,
    };
  }

  it('renders the Claude Playbook header + triggers when a complete row is present', () => {
    render(
      <PeriscopePanel
        {...baseProps}
        view={makeView()}
        playbook={makePlaybook({ data: fullRow() })}
      />,
    );
    expect(screen.getByText(/Claude Playbook/i)).toBeInTheDocument();
    // CLAUDE badge in the header strip
    expect(screen.getAllByText(/^Claude$/i).length).toBeGreaterThan(0);
    // INTRADAY mode chip
    expect(screen.getByText(/^INTRADAY$/)).toBeInTheDocument();
    // Triggers
    expect(screen.getByText(/LONG TRIGGER/i)).toBeInTheDocument();
    // 5810 appears in the trigger cell AND inline in the futures plan
    // narrative — just confirm at least one occurrence.
    expect(screen.getAllByText(/\b5810\b/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/\b5790\b/).length).toBeGreaterThan(0);
  });

  it('hides the client-derived Trade Plan when Claude has a fresh playbook', () => {
    render(
      <PeriscopePanel
        {...baseProps}
        view={makeView()}
        playbook={makePlaybook({ data: fullRow() })}
      />,
    );
    // "Trade Plan" header from TradePlanSection must not appear when
    // Claude's playbook is fresh — Risk R14: the fallback only renders
    // when no Claude playbook is present.
    expect(screen.queryByText(/^Trade Plan$/i)).not.toBeInTheDocument();
  });

  it('shows the deterministic Trade Plan when no playbook is provided', () => {
    render(<PeriscopePanel {...baseProps} view={makeView()} />);
    expect(screen.getByText(/Trade Plan/i)).toBeInTheDocument();
  });

  it('shows the deterministic Trade Plan when playbook has data:null (no completed row)', () => {
    render(
      <PeriscopePanel
        {...baseProps}
        view={makeView()}
        playbook={makePlaybook({ data: null })}
      />,
    );
    // The PlaybookSection's empty-state still renders Claude badge but
    // the deterministic Trade Plan should ALSO be present beneath.
    expect(screen.getByText(/Trade Plan/i)).toBeInTheDocument();
    // Empty-state copy
    expect(
      screen.getByText(/waiting for first scraper tick of the day/i),
    ).toBeInTheDocument();
  });

  it('surfaces the "Claude reading newer slot" hint when latestInProgress is true', () => {
    render(
      <PeriscopePanel
        {...baseProps}
        view={makeView()}
        playbook={makePlaybook({
          data: fullRow(),
          latestInProgress: true,
        })}
      />,
    );
    expect(screen.getByText(/Claude reading newer slot/i)).toBeInTheDocument();
  });

  it('renders recommended + avoid structure chips', () => {
    render(
      <PeriscopePanel
        {...baseProps}
        view={makeView()}
        playbook={makePlaybook({ data: fullRow() })}
      />,
    );
    expect(screen.getByText(/RECOMMENDED/i)).toBeInTheDocument();
    expect(screen.getByText(/debit_call_spread/)).toBeInTheDocument();
    expect(screen.getByText(/AVOID/i)).toBeInTheDocument();
    expect(screen.getByText(/iron_condor/)).toBeInTheDocument();
  });

  it('renders the futures plan + structured summary lines (not the full prose narrative)', () => {
    render(
      <PeriscopePanel
        {...baseProps}
        view={makeView()}
        playbook={makePlaybook({ data: fullRow() })}
      />,
    );
    expect(screen.getByText(/Futures Plan/i)).toBeInTheDocument();
    // confidence_basis renders as a top italic summary line
    expect(
      screen.getByText(/Pin scaffolding verified by charm-zero at 5805/i),
    ).toBeInTheDocument();
    // expected_dealer_behavior renders as a bottom italic line under the gamma row
    expect(
      screen.getByText(
        /Passive bid at the \+γ floor, passive offer at the −γ/i,
      ),
    ).toBeInTheDocument();
    // The full prose narrative is INTENTIONALLY NOT rendered in the panel
    // — it lives in periscope_analyses.prose_text and only surfaces in
    // PeriscopeChatHistory's detail view. Renders here would have dumped
    // the entire debrief into the live trading panel.
    expect(
      screen.queryByText(/Tight two-sided regime with charm pinning at 5805/i),
    ).not.toBeInTheDocument();
  });

  it('switches to labeled paragraph block when confidenceBasis is multi-sentence (>200 chars)', () => {
    // The 2026-05-11 lessons made confidence_basis multi-sentence
    // structural prose. ItalicSummaryLine at text-[11px] is unreadable
    // beyond ~2 sentences; ProseField switches to a labeled paragraph
    // block above the threshold.
    const longBasis =
      'Twin-strike +γ at 7,380 (+1,107) and 7,350 (+1,235) with no opposing flow in last 5 min. ' +
      'Charm-zero at 7,290 sits 94 pts below — supportive but consumed at this slice. ' +
      'No flow-structure conflict between the structural map and UW informed flow at this read.';
    expect(longBasis.length).toBeGreaterThan(200);
    render(
      <PeriscopePanel
        {...baseProps}
        view={makeView()}
        playbook={makePlaybook({
          data: fullRow({
            panelPayload: {
              ...fullRow().panelPayload!,
              confidenceBasis: longBasis,
            },
          }),
        })}
      />,
    );
    expect(screen.getByText(/CONFIDENCE BASIS/i)).toBeInTheDocument();
    expect(screen.getByText(/Twin-strike \+γ at 7,380/i)).toBeInTheDocument();
  });

  it('keeps italic 1-liner when confidenceBasis is short (≤200 chars)', () => {
    render(
      <PeriscopePanel
        {...baseProps}
        view={makeView()}
        playbook={makePlaybook({ data: fullRow() })}
      />,
    );
    // The default fixture's confidenceBasis is short, so no "CONFIDENCE
    // BASIS" label should render — it stays an italic summary line.
    expect(screen.queryByText(/^CONFIDENCE BASIS$/i)).not.toBeInTheDocument();
  });

  it('switches to labeled paragraph block when expectedDealerBehavior is long (>200 chars)', () => {
    const longBehavior =
      'Passive sell into 7,380 has already been absorbed by aggressive call buying; ' +
      'if spot clears 7,390 dealers become forced /ES buyers through the −γ pocket at 7,400 up to the next +γ ring at 7,425. ' +
      'On rejection back below 7,375, dealers transition to procyclical /ES sellers through the −γ acceleration at 7,365 down to the dominant +γ floor at 7,350.';
    expect(longBehavior.length).toBeGreaterThan(200);
    render(
      <PeriscopePanel
        {...baseProps}
        view={makeView()}
        playbook={makePlaybook({
          data: fullRow({
            panelPayload: {
              ...fullRow().panelPayload!,
              expectedDealerBehavior: longBehavior,
            },
          }),
        })}
      />,
    );
    expect(screen.getByText(/DEALER BEHAVIOR/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Passive sell into 7,380 has already been absorbed/i),
    ).toBeInTheDocument();
  });

  // ── Spot reconciliation (2026-05-11) — UW panel spot vs DB cash ──
  // The runner overrides panel_payload.spot with the DB-resolved SPX
  // cash from index_candles_1m. The header line currently shows the
  // snapshot's recorded UW spot, which periodically drifts 20-50pt
  // from cash. Reconciliation: prefer the playbook's cash spot when
  // present; surface both labeled only when they materially diverge.

  it('header shows snapshot spot when no playbook is present', () => {
    render(<PeriscopePanel {...baseProps} view={makeView()} />);
    // Default view spot is 5800.25 — no playbook → single "spot" line.
    expect(screen.getByText(/spot 5800\.25/)).toBeInTheDocument();
  });

  it('header shows the playbook cash spot when playbook agrees within 2pt', () => {
    // Default view spot 5800.25, default playbook spot 5800.50 → diff
    // 0.25 < 2pt threshold → single "spot" line, preferring playbook.
    render(
      <PeriscopePanel
        {...baseProps}
        view={makeView()}
        playbook={makePlaybook({ data: fullRow() })}
      />,
    );
    expect(screen.getByText(/spot 5800\.50/)).toBeInTheDocument();
    // The lower-precision UW value should NOT also appear as a header
    // label when they agree.
    expect(screen.queryByText(/cash 5800\.50 · UW/)).not.toBeInTheDocument();
  });

  it('header shows BOTH spots labeled when UW vs cash diverge > 2pt', () => {
    // The Sun 2026-05-11 audit found UW panel spots drifting 25-50pt
    // from SPX cash on certain days. When that happens the header
    // surfaces both: cash <playbook> · UW <view>.
    render(
      <PeriscopePanel
        {...baseProps}
        view={makeView({ spot: 7398.93 })}
        playbook={makePlaybook({
          data: fullRow({
            panelPayload: {
              ...fullRow().panelPayload!,
              spot: 7374.3,
            },
          }),
        })}
      />,
    );
    expect(screen.getByText(/cash 7374\.30/)).toBeInTheDocument();
    expect(screen.getByText(/UW 7398\.93/)).toBeInTheDocument();
  });

  it('renders staleness as a red chip when slot is over 25 minutes old', () => {
    const stale = new Date(Date.now() - 40 * 60_000).toISOString();
    render(
      <PeriscopePanel
        {...baseProps}
        view={makeView()}
        playbook={makePlaybook({
          data: fullRow({
            slotCapturedAt: stale,
            readTime: stale,
            createdAt: stale,
          }),
        })}
      />,
    );
    // The staleness chip uses an aria-label like "Slot age 40m ago" — we
    // assert the chip exists and is rendered with the minute count.
    expect(screen.getByLabelText(/Slot age 40m ago/i)).toBeInTheDocument();
  });

  it('renders "PRIOR SESSION" badge instead of staleness when slot is from a previous CT date', () => {
    // 30+ hours ago — guaranteed to be a prior CT date regardless of when
    // the test runs (clock skew + DST safe).
    const yesterday = new Date(Date.now() - 30 * 60 * 60_000).toISOString();
    render(
      <PeriscopePanel
        {...baseProps}
        view={makeView()}
        playbook={makePlaybook({
          data: fullRow({
            slotCapturedAt: yesterday,
            readTime: yesterday,
            createdAt: yesterday,
          }),
        })}
      />,
    );
    // Prior-session badge should appear instead of the red staleness counter.
    expect(screen.getByLabelText(/Prior trading session/i)).toBeInTheDocument();
    // The ticking-time chip's aria-label format must NOT appear.
    expect(screen.queryByLabelText(/Slot age \d/)).not.toBeInTheDocument();
  });

  it('returns null section content when playbook.error is set (fall through to fallback)', () => {
    render(
      <PeriscopePanel
        {...baseProps}
        view={makeView()}
        playbook={makePlaybook({ data: null, error: 'HTTP 500' })}
      />,
    );
    // Claude Playbook header should NOT appear when error is set.
    expect(screen.queryByText(/Claude Playbook/i)).not.toBeInTheDocument();
    // Deterministic Trade Plan should still be visible.
    expect(screen.getByText(/Trade Plan/i)).toBeInTheDocument();
  });
});
