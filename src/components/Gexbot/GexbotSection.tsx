/**
 * GexbotSection — dedicated section housing the GEXBot trial-data
 * components. Spec:
 * docs/superpowers/specs/gexbot-frontend-2026-05-16.md
 *
 * Wave 2 starts with just the VIX Dealer-State Badge to validate the
 * full shared-infra pipeline (cron → DB → /api/gexbot → hook → tile).
 * Each subsequent wave adds more children: Charm Clock, Gamma Compass,
 * Dexoflow Velocity Tape, Convexity Matrix, Skew Dashboard, Strike
 * Mover Ticker.
 *
 * The Sibling-Asset Confirmation Bar lives inline in lottery/silent-
 * boom rows, not in this section.
 */

import { memo } from 'react';

import { SectionBox } from '../ui';
import { VixDealerStateBadge } from './VixDealerStateBadge';

interface GexbotSectionProps {
  marketOpen: boolean;
}

function GexbotSectionInner({ marketOpen }: GexbotSectionProps) {
  // defaultCollapsed=true for Wave 2a (one tile, saves vertical space).
  // Flip to false when Wave 2b+ adds Charm Clock / Gamma Compass etc.
  return (
    <SectionBox label="GEXBot Dealer State" collapsible defaultCollapsed>
      <div className="flex flex-col gap-3">
        <VixDealerStateBadge marketOpen={marketOpen} />
      </div>
      <p className="text-tertiary mt-3 text-[10px] leading-relaxed">
        GEXBot Orderflow-tier data — capture pipeline ships dealer
        positioning + flow metrics for 16 Index/ETF tickers every minute
        during market hours. More tiles in upcoming waves.
      </p>
    </SectionBox>
  );
}

export const GexbotSection = memo(GexbotSectionInner);
