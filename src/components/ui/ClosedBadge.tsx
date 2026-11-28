import { theme } from '../../themes';
import { closedLabelOrNull } from '../../utils/closed-session';
import { tint } from '../../utils/ui-utils';

/**
 * The CLOSED pill the GEXBot panels (GEX Landscape, Taker Flow, Periscope)
 * show once the cash session is over: "CLOSED · as of Fri 3:00 PM CT".
 *
 * Renders nothing when `asOf` is absent or does not parse (`closedLabelOrNull`,
 * the one rule for whether a label exists), so a bare "CLOSED · as of" never
 * dangles. The label reads the clock at render: it only decides whether the
 * capture is dated (more than 6 days old).
 *
 * Screen readers read its text in place, as they do the LIVE badge's; no
 * `aria-hidden`, no `aria-label`. The 9% tint is the header CLOSED badge's
 * (StatusBadge): the muted text on it measures 5.06:1 in the light theme and
 * 4.53:1 in the dark.
 */
export function ClosedBadge({
  asOf,
  testId,
}: {
  asOf?: string | null;
  testId: string;
}) {
  const label = closedLabelOrNull(asOf, new Date());
  if (label == null) return null;
  return (
    <span
      data-testid={testId}
      className="rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold whitespace-nowrap"
      style={{
        background: tint(theme.textMuted, '17'),
        color: theme.textMuted,
      }}
    >
      CLOSED · as of {label}
    </span>
  );
}
