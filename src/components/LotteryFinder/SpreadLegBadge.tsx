/**
 * Spread-leg badge for a Lottery Finder row, and the per-fire marker for
 * its reignites list. Both read the exchange's trade code on each fire's
 * anchor print (spec docs/superpowers/specs/2026-10-28-classifier-
 * replacement-design.md, "Badge"). Information only: nothing filters,
 * dims or sorts on them.
 */

import { memo } from 'react';
import { StatusBadge } from '../ui/StatusBadge.js';
import { theme } from '../../themes/index.js';
import { describeSpread } from '../../utils/spread-badge.js';
import type {
  AnchorLegKind,
  SpreadLegSummary,
} from '../../types/spread-legs.js';

const INFO_ONLY =
  'Information only: not part of the score, and nothing is filtered on it.';

/**
 * Badge text and tooltip, or null for no badge. A spread count (k ≥ 1)
 * wins; otherwise a stock-tied latest fire gets its own badge.
 */
function badgeContent(
  spreadLeg: SpreadLegSummary | null,
  anchorLegKind: AnchorLegKind | null,
): { label: string; title: string } | null {
  if (spreadLeg != null) {
    const { fires: k, totalFires: n } = spreadLeg;
    const desc = describeSpread(spreadLeg.shape, spreadLeg.legs);
    if (n === 1) {
      return {
        label: `spread leg · ${desc}`,
        title: `The exchange flagged this fire's anchor print as one leg of a multi-leg order. ${INFO_ONLY}`,
      };
    }
    return {
      label:
        k === n
          ? `spread leg on all ${n} fires · ${desc}`
          : `spread leg on ${k} of ${n} fires · ${desc}`,
      title: `The exchange flagged the anchor print of ${k} of this chain's ${n} fires today as one leg of a multi-leg order. Shape and strikes are from the most recent one. ${INFO_ONLY}`,
    };
  }
  if (anchorLegKind === 'stock_tied') {
    return {
      label: 'stock-tied leg',
      title: `The exchange flagged the latest fire's anchor print as the option leg of a stock-and-option order. ${INFO_ONLY}`,
    };
  }
  return null;
}

/** Row badge: `spread leg on <k> of <n> fires · <shape> <strikes>`. */
export const SpreadLegBadge = memo(function SpreadLegBadge({
  spreadLeg,
  anchorLegKind,
}: {
  spreadLeg: SpreadLegSummary | null;
  anchorLegKind: AnchorLegKind | null;
}) {
  const content = badgeContent(spreadLeg, anchorLegKind);
  if (content == null) return null;
  return (
    <StatusBadge
      label={content.label}
      title={content.title}
      color={theme.textSecondary}
    />
  );
});

/** Small marker on a reignites-list entry; nothing for single or NULL. */
export const FireLegMarker = memo(function FireLegMarker({
  kind,
}: {
  kind: AnchorLegKind | null;
}) {
  if (kind !== 'multi_leg' && kind !== 'stock_tied') return null;
  const spread = kind === 'multi_leg';
  const label = spread ? 'spread-leg fire' : 'stock-tied fire';
  return (
    <span
      role="img"
      aria-label={label}
      title={
        spread
          ? 'Spread-leg fire: its anchor print was one leg of a multi-leg order.'
          : 'Stock-tied fire: its anchor print was the option leg of a stock-and-option order.'
      }
      className="text-secondary ml-1"
    >
      {spread ? '⇄' : '+S'}
    </span>
  );
});
