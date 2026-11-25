/**
 * Reading of GEXBot's SPX net −vanna (`zvanna`, $MM to expiry) against the
 * vendor's own size-and-time guidance (docs.gexbot.com/orderflow/netvannacharm,
 * read 2026-11-20 and 2026-11-25): beyond $800 MM it matters mainly in the
 * last hour of the session, and above $1,000 MM in roughly the last two
 * hours. The vendor gives these for SPX only and calls them discretionary.
 *
 * The vendor's words are "beyond" and "above", so both comparisons are
 * strict: exactly $800 MM is quiet, and exactly $1,000 MM is the last-hour
 * tier, not the early one.
 *
 * Sign is the vendor's: positive = the delta drift adds passive bids,
 * negative = it adds passive offers. Vendor-defined, taker-side quantities.
 *
 * Spec: docs/superpowers/specs/gexbot-expected-move-net-vanna-2026-11-20.md
 */

/** Size beyond which net −vanna matters in the last hour ($MM). */
export const NET_VANNA_LAST_HOUR_MM = 800;
/** Size above which it matters earlier, in about the last two hours ($MM). */
export const NET_VANNA_EARLY_MM = 1000;

const LAST_HOUR_WINDOW_H = 1;
const EARLY_WINDOW_H = 2;

export type NetVannaSide = 'bids' | 'offers' | 'flat';

interface NoWindow {
  side: NetVannaSide;
  windowHours: null;
  hoursUntilInPlay: null;
}

interface InWindow {
  side: NetVannaSide;
  /** Hours before the close the size qualifies for (1 or 2). */
  windowHours: number;
  /** Hours until that window opens; 0 once in play. */
  hoursUntilInPlay: number;
}

/**
 *   - `in-play`: big enough, and inside the window its size qualifies for;
 *   - `pending`: big enough, but that window has not opened yet;
 *   - `quiet`: not beyond the smaller threshold;
 *   - `closed`: the session is over (or the market is not open).
 */
export type NetVannaRead =
  | ({ status: 'quiet' } & NoWindow)
  | ({ status: 'closed' } & NoWindow)
  | ({ status: 'in-play' } & InWindow)
  | ({ status: 'pending' } & InWindow);

function sideOf(netVannaMm: number): NetVannaSide {
  if (netVannaMm > 0) return 'bids';
  if (netVannaMm < 0) return 'offers';
  return 'flat';
}

export function readNetVanna(
  netVannaMm: number,
  hoursToClose: number,
): NetVannaRead {
  const side = sideOf(netVannaMm);
  if (hoursToClose <= 0) {
    return {
      status: 'closed',
      side,
      windowHours: null,
      hoursUntilInPlay: null,
    };
  }
  const size = Math.abs(netVannaMm);
  if (size <= NET_VANNA_LAST_HOUR_MM) {
    return { status: 'quiet', side, windowHours: null, hoursUntilInPlay: null };
  }
  const windowHours =
    size > NET_VANNA_EARLY_MM ? EARLY_WINDOW_H : LAST_HOUR_WINDOW_H;
  if (hoursToClose <= windowHours) {
    return { status: 'in-play', side, windowHours, hoursUntilInPlay: 0 };
  }
  return {
    status: 'pending',
    side,
    windowHours,
    hoursUntilInPlay: hoursToClose - windowHours,
  };
}

/** `+$912 MM`, `−$1,205 MM`; one decimal under $100 MM. */
export function formatVannaMm(value: number): string {
  if (value === 0) return '$0 MM';
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : 1;
  const body = abs.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${value > 0 ? '+' : '−'}$${body} MM`;
}
