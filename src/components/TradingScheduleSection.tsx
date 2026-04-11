import { memo, useCallback, useEffect, useState } from 'react';
import { SectionBox } from './ui';
import { theme } from '../themes';
import { tint } from '../utils/ui-utils';
import { currentSessionStage, type SessionStage } from '../data/marketHours';
import { to24Hour } from '../utils/time';
import type { AmPm, Timezone } from '../types';

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

/* ── helpers ──────────────────────────────────────────── */

const IANA_ZONE: Record<Timezone, string> = {
  CT: 'America/Chicago',
  ET: 'America/New_York',
};

/** Today's date in CT as YYYY-MM-DD. */
function ctToday(): string {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Chicago',
  });
}

/**
 * Build a Date for a specific wall-clock time in the given IANA zone.
 *
 * Two-step DST correction: create a candidate at UTC-6 (CST baseline),
 * then check what the zone's Intl formatter says about that instant and
 * adjust by the difference. Handles CT (CDT/CST) and ET (EDT/EST) without
 * any hard-coded offset tables.
 */
function buildDateFromTZ(
  dateStr: string,
  h24: number,
  minute: number,
  ianaZone: string,
): Date {
  const pad = (n: number) => String(n).padStart(2, '0');
  // Step 1: candidate using CST (UTC-6) — at most 1h off from actual offset
  const candidate = new Date(`${dateStr}T${pad(h24)}:${pad(minute)}:00-06:00`);
  // Step 2: see what the zone actually reports at this UTC instant
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ianaZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(candidate);
  const rawH = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const actualM = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  // Some locales return '24' for midnight — normalize
  const actualH = rawH >= 24 ? 0 : rawH;
  const diffMs = ((h24 - actualH) * 60 + (minute - actualM)) * 60_000;
  return new Date(candidate.getTime() + diffMs);
}

/**
 * Returns the index of the currently-active phase in `PHASES`, or `-1`
 * if no phase is active (pre-market, post-close, 2:30–2:55 late-bwb
 * gap, weekend, full-day holiday, or NYSE half-day).
 */
function getActiveIndex(now?: Date): number {
  const stage = currentSessionStage(now);
  return PHASES.findIndex((p) => p.stage === stage);
}

/* ── component ────────────────────────────────────────── */

export default memo(function TradingScheduleSection({
  selectedDate,
  timeHour,
  timeMinute,
  timeAmPm,
  timezone = 'CT',
}: {
  selectedDate?: string;
  timeHour?: string;
  timeMinute?: string;
  timeAmPm?: AmPm;
  timezone?: Timezone;
}) {
  // Live mode: no date provided, or the selected date is today's CT date.
  // Backtest mode: a past date is selected — highlight based on that time.
  const isLive = !selectedDate || selectedDate === ctToday();

  const computeActiveIdx = useCallback((): number => {
    if (isLive || !selectedDate || !timeHour || !timeMinute || !timeAmPm) {
      return getActiveIndex(); // wall-clock now
    }
    const h24 = to24Hour(Number.parseInt(timeHour, 10), timeAmPm);
    const minute = Number.parseInt(timeMinute, 10) || 0;
    const backtestDate = buildDateFromTZ(
      selectedDate,
      h24,
      minute,
      IANA_ZONE[timezone],
    );
    return getActiveIndex(backtestDate);
  }, [isLive, selectedDate, timeHour, timeMinute, timeAmPm, timezone]);

  const [activeIdx, setActiveIdx] = useState(computeActiveIdx);

  useEffect(() => {
    setActiveIdx(computeActiveIdx());
    // Only poll the live clock; backtest snapshots are static
    if (!isLive) return;
    const id = setInterval(() => setActiveIdx(computeActiveIdx()), 60_000);
    return () => clearInterval(id);
  }, [computeActiveIdx, isLive]);

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
