import { memo, useEffect, useState } from 'react';
import { SectionBox } from './ui';
import { theme } from '../themes';
import { tint } from '../utils/ui-utils';

/* ── phase definitions (all times CT) ─────────────────── */

interface Phase {
  startMin: number; // minutes since midnight CT
  endMin: number;
  timeLabel: string;
  title: string;
  subtitle: string;
  color: string;
}

const PHASES: Phase[] = [
  {
    startMin: 9 * 60,
    endMin: 11 * 60 + 30,
    timeLabel: '9:00 – 11:30',
    title: 'Sell Credit Spreads',
    subtitle:
      'Sell 0DTE put/call credit spreads — collect premium, let theta decay',
    color: theme.green,
  },
  {
    startMin: 11 * 60 + 30,
    endMin: 13 * 60,
    timeLabel: '11:30 – 1:00',
    title: 'Buy Directional',
    subtitle: '7 DTE ~50Δ ATM put or call — close EOD',
    color: theme.accent,
  },
  {
    startMin: 13 * 60,
    endMin: 14 * 60 + 30,
    timeLabel: '1:00 – 2:30',
    title: 'Open BWB',
    subtitle: 'Open 0DTE broken wing butterfly around likely pin',
    color: theme.chartPurple,
  },
  {
    startMin: 14 * 60 + 55,
    endMin: 15 * 60,
    timeLabel: '2:55 – 3:00',
    title: 'Go Flat',
    subtitle: 'Close all non-0DTE positions — no overnight risk',
    color: theme.caution,
  },
];

/* ── time helpers ─────────────────────────────────────── */

function getCTMinutes(): number {
  const now = new Date();
  const ct = new Date(
    now.toLocaleString('en-US', { timeZone: 'America/Chicago' }),
  );
  return ct.getHours() * 60 + ct.getMinutes();
}

function isTradingDay(): boolean {
  const now = new Date();
  const ct = new Date(
    now.toLocaleString('en-US', { timeZone: 'America/Chicago' }),
  );
  const day = ct.getDay();
  return day >= 1 && day <= 5;
}

function getActiveIndex(): number {
  if (!isTradingDay()) return -1;
  const mins = getCTMinutes();
  return PHASES.findIndex((p) => mins >= p.startMin && mins < p.endMin);
}

/* ── component ────────────────────────────────────────── */

export default memo(function TradingScheduleSection() {
  const [activeIdx, setActiveIdx] = useState(getActiveIndex);

  useEffect(() => {
    const id = setInterval(() => setActiveIdx(getActiveIndex()), 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <SectionBox label="Trading Schedule" badge="CT">
      <div className="relative ml-2">
        {/* vertical connector line */}
        <div
          className="absolute top-3 bottom-3 left-[5px] w-[2px] rounded-full"
          style={{ background: tint(theme.textMuted, '30') }}
        />

        <div className="space-y-1">
          {PHASES.map((phase, i) => {
            const active = i === activeIdx;
            const past = activeIdx >= 0 && i < activeIdx;

            return (
              <div key={i} className="relative flex items-start pl-5">
                {/* timeline dot */}
                <span
                  className="absolute top-3 left-0 h-[11px] w-[11px] rounded-full border-[2px]"
                  style={{
                    borderColor: past ? tint(phase.color, '50') : phase.color,
                    background: active || past ? phase.color : 'transparent',
                    boxShadow: active
                      ? `0 0 8px ${tint(phase.color, '50')}`
                      : 'none',
                    opacity: past ? 0.45 : 1,
                    transition: 'all 0.3s ease',
                  }}
                />

                {/* phase card */}
                <div
                  className={`flex-1 rounded-lg px-3 py-2 transition-colors duration-200 ${
                    active ? 'border-[1.5px]' : ''
                  }`}
                  style={{
                    background: active
                      ? tint(phase.color, '0a')
                      : 'transparent',
                    borderColor: active
                      ? tint(phase.color, '25')
                      : 'transparent',
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
                  <p className="text-primary mt-0.5 text-[13px] font-semibold">
                    {phase.title}
                  </p>
                  <p className="text-secondary mt-0.5 text-[11px] leading-relaxed">
                    {phase.subtitle}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </SectionBox>
  );
});
