/**
 * SchwabExpiryBadge — owner-only countdown to the Schwab refresh-token
 * expiry, shown in the header next to the Re-auth control.
 *
 *   ● green — more than 24 h left
 *   ▲ amber — 24 h or less
 *   ◆ red   — 2 h or less
 *   ✕ red   — expired, or logged out
 *
 * Amber and red add a Re-auth link, unless the 401-driven Re-auth prompt
 * (`market.needsAuth`) is already showing, so only one Re-auth control
 * renders at a time. Renders nothing for non-owners, before the first
 * status arrives, or when the status is `unknown`.
 *
 * The tier is computed on the client clock (`useNowMinute`), so the badge
 * turns amber/red on time between the 5-minute status polls. The clock
 * lives in the inner `BadgeBody`, so non-owners (and the time before the
 * first status) run no minute timer, and the first status is classified
 * against a fresh `now`.
 *
 * Accessibility: it is a `timer` named "Schwab login expiry". That ARIA role
 * describes a countdown, and its implicit `aria-live="off"` keeps the
 * per-minute updates from chattering; the push reminder is the alerting
 * path. Each tier has its own shape glyph and screen-reader text, so none is
 * told apart by colour alone (WCAG 1.4.1), and the screen-reader text gives
 * the absolute expiry that sighted users get from the tooltip.
 */

import { useNowMinute } from '../../hooks/useNowMinute';
import { useSchwabAuthStatus } from '../../hooks/useSchwabAuthStatus';
import { theme } from '../../themes';
import {
  classifySchwabExpiry,
  formatSchwabExpiryCt,
  type SchwabAuthStatus,
  type SchwabExpiryTier,
} from '../../utils/schwab-expiry';
import SchwabAuthLink from './SchwabAuthLink';

type BadgeTier = SchwabExpiryTier | 'logged_out';

const TIER_LOOK: Record<BadgeTier, { color: string; glyph: string }> = {
  ok: { color: theme.green, glyph: '●' },
  warn: { color: theme.caution, glyph: '▲' },
  urgent: { color: theme.red, glyph: '◆' },
  expired: { color: theme.red, glyph: '✕' },
  logged_out: { color: theme.red, glyph: '✕' },
};

const MINUTE_MS = 60_000;

/** "4d 3h", "23h 10m", "42m" — whole minutes, rounded down. */
function formatRemaining(ms: number): string {
  const totalMin = Math.floor(ms / MINUTE_MS);
  const days = Math.floor(totalMin / (24 * 60));
  const hours = Math.floor((totalMin % (24 * 60)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

interface BadgeView {
  tier: BadgeTier;
  /** Visible text. */
  label: string;
  /** Tooltip: the absolute expiry. */
  title: string;
  /** Screen-reader text: severity in words plus the absolute expiry. */
  srText: string;
}

function badgeView(
  status: Exclude<SchwabAuthStatus, { state: 'unknown' }>,
  now: number,
): BadgeView {
  if (status.state === 'logged_out') {
    return {
      tier: 'logged_out',
      label: 'Schwab logged out',
      title: 'Schwab is logged out',
      srText: 'Re-authenticate to restore live data.',
    };
  }
  const { refreshExpiresAt } = status;
  const tier = classifySchwabExpiry(refreshExpiresAt, now);
  const at = formatSchwabExpiryCt(refreshExpiresAt);
  if (tier === 'expired') {
    return {
      tier,
      label: 'Schwab expired',
      title: `Schwab login expired ${at}`,
      srText: `Login expired ${at}.`,
    };
  }
  const srText =
    tier === 'ok'
      ? `Login active until ${at}.`
      : tier === 'warn'
        ? `Login expires within 24 hours, at ${at}.`
        : `Login expires within 2 hours, at ${at}.`;
  return {
    tier,
    label: `Schwab ${formatRemaining(refreshExpiresAt - now)}`,
    title: `Schwab login expires ${at}`,
    srText,
  };
}

interface SchwabExpiryBadgeProps {
  /** Owner session — the status endpoint is owner-only. */
  isOwner: boolean;
  /** The 401-driven Re-auth prompt is already on screen. */
  reauthPromptShown: boolean;
}

export default function SchwabExpiryBadge({
  isOwner,
  reauthPromptShown,
}: SchwabExpiryBadgeProps) {
  const status = useSchwabAuthStatus(isOwner);
  if (!isOwner || status === null || status.state === 'unknown') return null;
  return <BadgeBody status={status} reauthPromptShown={reauthPromptShown} />;
}

interface BadgeBodyProps {
  status: Exclude<SchwabAuthStatus, { state: 'unknown' }>;
  reauthPromptShown: boolean;
}

/** Owns the minute clock, so it only ticks while a badge is on screen. */
function BadgeBody({ status, reauthPromptShown }: BadgeBodyProps) {
  const now = useNowMinute();
  const { tier, label, title, srText } = badgeView(status, now);
  const { color, glyph } = TIER_LOOK[tier];
  return (
    <>
      <span
        role="timer"
        aria-label="Schwab login expiry"
        className="rounded-full px-2.5 py-0.5 font-mono text-[10px] font-semibold whitespace-nowrap"
        style={{
          backgroundColor: `color-mix(in srgb, ${color} 9%, transparent)`,
          color,
        }}
        title={title}
        data-tier={tier}
      >
        <span aria-hidden="true">{glyph} </span>
        {label}
        <span className="sr-only">{` — ${srText}`}</span>
      </span>
      {tier !== 'ok' && !reauthPromptShown && (
        <SchwabAuthLink
          ariaLabel="Re-auth with Schwab"
          text="Re-auth"
          color={color}
        />
      )}
    </>
  );
}
