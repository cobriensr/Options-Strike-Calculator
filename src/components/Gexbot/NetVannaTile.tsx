/**
 * NetVannaTile — SPX net −vanna (`zvanna`, $MM to expiry) read against
 * GEXBot's own size-and-time guidance (see `net-vanna.ts`).
 *
 * The tile is coloured only while the reading is in play: big enough, and
 * inside the part of the session the vendor says that size matters in. A big
 * reading at 10:00 stays neutral and counts down to its window, so a morning
 * number is never shown as a signal. A closed market reads as a closed
 * session (neutral), so a reading that was in play at 15:59 does not stay
 * coloured after the close.
 *
 * SPX only: the vendor's thresholds are for SPX, and ES_SPX repeats it.
 *
 * Spec: docs/superpowers/specs/gexbot-expected-move-net-vanna-2026-11-20.md
 */

import { memo, useMemo } from 'react';

import { useGexbotData } from '../../hooks/useGexbotData';
import { SrHint } from '../ui/SrHint';
import {
  formatVannaMm,
  NET_VANNA_EARLY_MM,
  NET_VANNA_LAST_HOUR_MM,
  readNetVanna,
  type NetVannaRead,
} from './net-vanna';
import { formatHoursMinutes, useHoursToClose } from './session-clock';
import { toneClasses } from './tile-tone';
import type { GammaSign } from './types';

interface NetVannaTileProps {
  marketOpen: boolean;
}

const SPEC = { view: 'snapshots-latest' as const };
const TICKER = 'SPX';

const NAME = 'SPX net −vanna';
const EARLY_TEXT = NET_VANNA_EARLY_MM.toLocaleString('en-US');
const TITLE = `GEXBot's SPX guidance: net −vanna matters beyond $${NET_VANNA_LAST_HOUR_MM} MM in the last hour of the session, and above $${EARLY_TEXT} MM in roughly the last two hours. Positive means the delta drift adds passive bids; negative, passive offers. Vendor-defined, taker-side. The tile is coloured only while the reading is in play.`;

/**
 * What a screen reader gets in place of the hover title. It names the source
 * and the condition; the sizes and the windows stay in the title.
 */
const HINT =
  'GEXBot guidance: matters only above a size threshold late in the session';

const SIDE_TEXT = {
  bids: 'adds passive bids',
  offers: 'adds passive offers',
  flat: 'flat',
} as const;

function windowLabel(windowHours: number): string {
  return windowHours === 1 ? 'last hour' : `last ${windowHours}h`;
}

function readText(read: NetVannaRead): string {
  if (read.status === 'closed') return 'session closed';
  if (read.status === 'quiet') {
    return `$${NET_VANNA_LAST_HOUR_MM} MM or less · no late-day read`;
  }
  const side = SIDE_TEXT[read.side];
  const label = windowLabel(read.windowHours);
  if (read.status === 'in-play') return `${side} · in play, ${label}`;
  const wait = formatHoursMinutes(read.hoursUntilInPlay);
  return `${side} · in play in ${wait} (${label})`;
}

/**
 * Colour only an in-play reading; everything else is the neutral tile. An
 * in-play reading is at least the threshold in size, so it is never flat.
 */
function toneSign(read: NetVannaRead): GammaSign {
  if (read.status !== 'in-play') return 'unknown';
  return read.side === 'offers' ? 'short' : 'long';
}

function NetVannaTileInner({ marketOpen }: NetVannaTileProps) {
  const { rows, loading, error } = useGexbotData(SPEC, marketOpen);
  // 0 whenever the market is closed, so the tile never stays "in play" on the
  // clock it stopped reading a minute before the close.
  const hoursLeft = useHoursToClose(marketOpen);

  const zvanna = useMemo(
    () => rows.find((r) => r.ticker === TICKER)?.zvanna ?? null,
    [rows],
  );

  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="net-vanna-tile-loading"
        className="text-tertiary rounded-md border border-white/5 bg-white/[0.02] px-3 py-2 text-xs"
      >
        {NAME} — loading…
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="net-vanna-tile-error"
        className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300/80"
      >
        {NAME} — {error}
      </div>
    );
  }

  if (zvanna == null) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="net-vanna-tile-empty"
        className="text-tertiary rounded-md border border-white/5 bg-white/[0.02] px-3 py-2 text-xs"
      >
        {NAME} — awaiting first GEXBot tick
      </div>
    );
  }

  const read = readNetVanna(zvanna, hoursLeft);
  const tone = toneClasses(toneSign(read));

  return (
    <div
      data-testid="net-vanna-tile"
      title={TITLE}
      className={`rounded-md border px-3 py-2 ${tone.container}`}
    >
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${tone.accent}`} aria-hidden />
        <span
          data-testid="net-vanna-value"
          className={`text-[11px] font-semibold tracking-wide ${tone.headline}`}
        >
          SPX −VANNA · {formatVannaMm(zvanna)}
        </span>
      </div>
      <div
        data-testid="net-vanna-read"
        className="text-tertiary mt-1 text-[10px] leading-tight"
      >
        {readText(read)}
      </div>
      <div className="text-tertiary text-[9px] leading-tight tracking-wide uppercase">
        GEXBot net −vanna ex · $MM to expiry
      </div>
      <SrHint>{HINT}</SrHint>
    </div>
  );
}

export const NetVannaTile = memo(NetVannaTileInner);
