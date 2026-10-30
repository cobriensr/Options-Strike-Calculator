/**
 * SiblingAssetConfirmationBar — inline pill row next to the existing
 * TakeItScore badges on each Lottery + Silent Boom alert.
 *
 * For an alert on `{ticker, side}` as of `firedAt`, queries
 * `/api/gexbot?view=sibling-confirm&ticker=...&side=...&at=...` and renders
 * one pill per sibling showing whether that sibling's taker flow pointed
 * the same way as the alert when it fired.
 *
 * The read is GEXBot's `net_dex`, the net taker delta across the 0DTE
 * chain (+ = takers net long delta, call-side flow). A call alert agrees
 * with a positive sibling net_dex, a put alert with a negative one; zero
 * or missing reads as "—". The snapshot used is the latest one at or
 * before `firedAt`, so an alert viewed hours later is still judged
 * against the market as it was. What `firedAt` means differs by feed
 * (a Lottery row's latest fire, a Silent Boom 5-min bucket start), so the
 * caller names it in `asOfLabel` and every tooltip repeats it. The live table only holds ~2 sessions,
 * older fires show "no data". `zgr` appears in the tooltip as context. It
 * is not in the verdict, and the whole read is unvalidated.
 *
 * Siblings are the 14 underlyings (no futures views). Groups are defined
 * server-side in `api/_lib/gexbot-queries.ts` (`SIBLING_GROUPS`).
 *
 * The bar renders nothing while loading or on error. It's an inline
 * augmentation, so an absent bar reads as "no information yet" rather
 * than a broken UI.
 */

import { memo } from 'react';

import { useGexbotData } from '../../hooks/useGexbotData';
import type { SiblingConfirmRow } from '../../hooks/useGexbotData';
import { formatTimeCT } from '../../utils/component-formatters';
import { GEXBOT_UNDERLYING_ORDER } from './ticker-order';

interface SiblingAssetConfirmationBarProps {
  ticker: string;
  side: 'call' | 'put';
  /** The moment the pills reflect (ISO 8601 with a Z or ±hh:mm offset). */
  firedAt: string;
  /** What `firedAt` is, in words: "latest fire", "5-min bucket start". */
  asOfLabel: string;
  marketOpen: boolean;
}

/** A zone-less ISO string would parse as browser-local time; reject it. */
const ZONED_ISO_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

type Verdict = SiblingConfirmRow['verdict'];

const GLYPH: Record<Verdict, string> = {
  agree: '✓',
  disagree: '✗',
  none: '—',
};

const VERDICT_LABEL: Record<Verdict, string> = {
  agree: 'agrees',
  disagree: 'disagrees',
  none: '—',
};

const VERDICT_CLASS: Record<Verdict, string> = {
  agree: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
  disagree: 'border-rose-500/30 bg-rose-500/10 text-rose-200',
  none: 'border-white/10 bg-white/[0.04] text-tertiary',
};

const UNDERLYING_RANK = new Map<string, number>(
  GEXBOT_UNDERLYING_ORDER.map((t, i) => [t, i]),
);

/** Signed compact dollars-of-delta, e.g. +1.50M. */
function formatNetDex(v: number): string {
  const abs = Math.abs(v);
  let scaled = abs.toFixed(0);
  if (abs >= 1e9) scaled = `${(abs / 1e9).toFixed(2)}B`;
  else if (abs >= 1e6) scaled = `${(abs / 1e6).toFixed(2)}M`;
  else if (abs >= 1e3) scaled = `${(abs / 1e3).toFixed(2)}K`;
  return `${v < 0 ? '-' : '+'}${scaled}`;
}

function verdictText(row: SiblingConfirmRow): string {
  return row.verdict === 'none'
    ? `${row.ticker} taker flow: no reading`
    : `${row.ticker} taker flow ${VERDICT_LABEL[row.verdict]}`;
}

function pillTitle(row: SiblingConfirmRow, asOfLabel: string): string {
  const snapshot =
    row.capturedAt != null
      ? `, snapshot ${formatTimeCT(row.capturedAt)} CT`
      : '';
  return [
    verdictText(row),
    row.netDex != null ? `net_dex ${formatNetDex(row.netDex)}` : null,
    row.zgr != null ? `zgr ${row.zgr.toFixed(2)}` : null,
    `as of ${asOfLabel}${snapshot}`,
    'context, unvalidated',
  ]
    .filter(Boolean)
    .join(' · ');
}

interface BarBodyProps {
  ticker: string;
  side: 'call' | 'put';
  at: string;
  asOfLabel: string;
  marketOpen: boolean;
}

function SiblingBarBody({
  ticker,
  side,
  at,
  asOfLabel,
  marketOpen,
}: BarBodyProps) {
  const { rows, loading, error } = useGexbotData(
    { view: 'sibling-confirm', ticker, side, at },
    marketOpen,
  );

  // Futures views are SPX/NDX re-scaled; counting them double-weights.
  const siblings = rows
    .filter((r) => UNDERLYING_RANK.has(r.ticker))
    .sort(
      (a, b) =>
        (UNDERLYING_RANK.get(a.ticker) ?? 0) -
        (UNDERLYING_RANK.get(b.ticker) ?? 0),
    );

  // Render nothing while loading, on error, or with no siblings. Errors
  // surface via Sentry on the API side; the row UI stays quiet.
  if (loading || error || siblings.length === 0) return null;

  const hasAnyRead = siblings.some((r) => r.verdict !== 'none');

  return (
    <span
      role="group"
      aria-label={`Sibling taker flow for ${ticker} ${side}`}
      data-testid={`sibling-bar-${ticker}-${side}`}
      className="inline-flex items-center gap-1"
    >
      <span className="text-tertiary mr-1 text-[9px] tracking-wide uppercase">
        taker flow:
      </span>
      {hasAnyRead ? (
        siblings.map((row) => (
          <span
            key={row.ticker}
            aria-label={verdictText(row)}
            data-testid={`sibling-pill-${ticker}-${row.ticker}`}
            className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px] tabular-nums ${VERDICT_CLASS[row.verdict]}`}
            title={pillTitle(row, asOfLabel)}
          >
            <span className="font-semibold">{row.ticker}</span>
            <span aria-hidden>{GLYPH[row.verdict]}</span>
          </span>
        ))
      ) : (
        <span
          className="text-tertiary text-[10px]"
          title={`No sibling snapshot near the ${asOfLabel} · context, unvalidated`}
        >
          no data
        </span>
      )}
    </span>
  );
}

function SiblingAssetConfirmationBarInner({
  firedAt,
  ...rest
}: SiblingAssetConfirmationBarProps) {
  // The endpoint rejects anything that isn't an ISO datetime, and a string
  // with no zone would be read as browser-local time. A row whose fire time
  // isn't a zoned ISO datetime gets no bar instead of a wrong or 400 read.
  const ms = ZONED_ISO_RE.test(firedAt) ? Date.parse(firedAt) : Number.NaN;
  if (Number.isNaN(ms)) return null;
  return <SiblingBarBody {...rest} at={new Date(ms).toISOString()} />;
}

export const SiblingAssetConfirmationBar = memo(
  SiblingAssetConfirmationBarInner,
);
