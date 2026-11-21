/**
 * QuoteStatusBadge — the header's LIVE / STALE / CLOSED pill. FE-STATE-001.
 *
 *   quotes.marketOpen false    → CLOSED (muted)
 *   open, fresh                → LIVE   (green)
 *   open, quotes >= 90 s old   → STALE  (caution)
 *   open, quotes >= 180 s old  → STALE  (red)
 *   open, session closed       → STALE  (red, no age)
 *
 * The title shows the quote age whenever quotes are stale, which includes
 * pre-market and after-hours under a CLOSED label.
 *
 * The last row is a quote from the regular session that nothing has replaced:
 * useQuoteStaleness reads NOT_STALE once the session is closed (polling stops
 * on purpose), so without it the label would fall back to the quote's own
 * `marketOpen: true` and read LIVE on a frozen quote. A healthy tab's
 * after-hours polls bring `marketOpen: false` before the session closes, so a
 * `marketOpen: true` quote at `closed` is always one that stopped updating
 * (the Schwab login lapsed with the tab open, say).
 *
 * It calls `useQuoteStaleness` itself so the hook's 5 s tick re-renders
 * only this pill, not AppHeader, App or the panel tree (F1).
 */

import { StatusBadge } from '../ui';
import { theme } from '../../themes';
import { useQuoteStaleness } from '../../hooks/useQuoteStaleness';
import type { MarketSession } from '../../hooks/useMarketData';

interface QuoteStatusBadgeProps {
  /** `marketOpen` from the last /api/quotes payload (RTH only). */
  quotesMarketOpen: boolean;
  /** `useMarketData().quotesFetchedAt`. */
  quotesFetchedAt: number | null;
  /** `useMarketData().session`. */
  session: MarketSession;
}

export default function QuoteStatusBadge({
  quotesMarketOpen,
  quotesFetchedAt,
  session,
}: QuoteStatusBadgeProps) {
  const { isStale, isVeryStale, staleAgeSec } = useQuoteStaleness(
    quotesFetchedAt,
    session,
  );

  if (session === 'closed' && quotesMarketOpen) {
    return (
      <StatusBadge
        label="STALE"
        color={theme.red}
        dot
        title="Last quote is from the regular session — no update since"
      />
    );
  }

  // isVeryStale implies isStale, so the severity check cascades from
  // most-severe to least-severe.
  const label = quotesMarketOpen ? (isStale ? 'STALE' : 'LIVE') : 'CLOSED';
  const color = quotesMarketOpen
    ? isVeryStale
      ? theme.red
      : isStale
        ? theme.caution
        : theme.green
    : theme.textMuted;
  const missedPolls = isVeryStale ? ' — 3+ missed polls' : '';
  const title =
    isStale && staleAgeSec != null
      ? `Quotes ${staleAgeSec}s old${missedPolls}`
      : undefined;

  return <StatusBadge label={label} color={color} dot title={title} />;
}
