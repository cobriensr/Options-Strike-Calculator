import { memo, useEffect, useState } from 'react';
import { SectionBox } from './ui';
import { theme } from '../themes';
import { tint } from '../utils/ui-utils';
import { currentSessionStage, type SessionStage } from '../data/marketHours';

/* ── phase definitions (UI presentation only) ────────── */

interface Phase {
  /** Stage identifier from `currentSessionStage` — the single source of truth
   *  for phase timing. UI metadata here is presentation-only. */
  stage: SessionStage;
  timeLabel: string;
  title: string;
  subtitle: string;
  color: string;
}

const PHASES: readonly Phase[] = [
  {
    stage: 'opening-range',
    timeLabel: '8:30 – 9:00',
    title: 'Market Open',
    subtitle: 'Establishing opening range — do not trade',
    color: theme.red,
  },
  {
    stage: 'credit-spreads',
    timeLabel: '9:00 – 11:30',
    title: 'Sell Credit Spreads',
    subtitle:
      'Sell 0DTE put/call credit spreads — collect premium, let theta decay',
    color: theme.green,
  },
  {
    stage: 'directional',
    timeLabel: '11:30 – 1:00',
    title: 'Buy Directional',
    subtitle: '7 DTE ~50Δ ATM put or call — close EOD',
    color: theme.accent,
  },
  {
    stage: 'bwb',
    timeLabel: '1:00 – 2:30',
    title: 'Open BWB',
    subtitle: 'Open 0DTE broken wing butterfly around likely pin',
    color: theme.chartPurple,
  },
  {
    stage: 'flat',
    timeLabel: '2:55 – 3:00',
    title: 'Go Flat',
    subtitle: 'Close all non-0DTE positions — no overnight risk',
    color: theme.caution,
  },
];

/**
 * Returns the index of the currently-active phase in `PHASES`, or `-1`
 * if no phase is active (pre-market, post-close, 2:30–2:55 late-bwb
 * gap, weekend, full-day holiday, or NYSE half-day).
 *
 * Uses the shared `currentSessionStage` helper from `marketHours.ts`
 * so holiday and half-day handling are centralized. (CROSS-003)
 */
function getActiveIndex(): number {
  const stage = currentSessionStage();
  const idx = PHASES.findIndex((p) => p.stage === stage);
  return idx; // -1 when stage is not one of the five displayed phases
}

/* ── component ────────────────────────────────────────── */

export default memo(function TradingScheduleSection() {
  const [activeIdx, setActiveIdx] = useState(getActiveIndex);

  useEffect(() => {
    const id = setInterval(() => setActiveIdx(getActiveIndex()), 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <SectionBox label="Trading Schedule" badge="CT" collapsible>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {PHASES.map((phase, i) => {
          const active = i === activeIdx;
          const past = activeIdx >= 0 && i < activeIdx;

          return (
            <div
              key={phase.title}
              className="rounded-lg border-t-[3px] px-3.5 py-3 transition-all duration-200"
              style={{
                borderTopColor: past ? tint(phase.color, '50') : phase.color,
                background: active
                  ? tint(phase.color, '0c')
                  : tint(theme.textMuted, '08'),
                boxShadow: active
                  ? `inset 0 0 0 1.5px ${tint(phase.color, '25')}`
                  : 'none',
                opacity: past ? 0.45 : 1,
              }}
            >
              <div className="flex items-center justify-between">
                <span
                  className="font-mono text-[12px] font-semibold tracking-wide"
                  style={{ color: phase.color }}
                >
                  {phase.timeLabel}
                </span>
                {active && (
                  <span
                    className="rounded-full px-2 py-0.5 text-[9px] font-bold tracking-widest uppercase"
                    style={{
                      color: phase.color,
                      background: tint(phase.color, '18'),
                    }}
                  >
                    Active
                  </span>
                )}
              </div>
              <p className="text-primary mt-1.5 text-[13px] font-semibold">
                {phase.title}
              </p>
              <p className="text-secondary mt-1 text-[11px] leading-relaxed">
                {phase.subtitle}
              </p>
            </div>
          );
        })}
      </div>
    </SectionBox>
  );
});
