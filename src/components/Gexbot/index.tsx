/**
 * GexbotSection — dedicated section housing the GEXBot trial-data
 * components. Spec:
 * docs/superpowers/specs/gexbot-frontend-2026-05-16.md
 *
 * Children consume their own data via useGexbotData. The section
 * itself is a layout container that forwards `marketOpen` (used
 * for polling gating) and the live SPX spot (used by StrikeMoverLadder
 * to anchor the ladder). After the close it also labels the whole section
 * CLOSED with the snapshots' capture time, and hands the ladder that time
 * and the snapshots' SPX spot (see StrikeMoverLadder).
 *
 * The Sibling-Asset Confirmation Bar lives inline in lottery/silent-
 * boom rows, not in this section.
 */

import { memo } from 'react';

import { useGexbotData } from '../../hooks/useGexbotData';
import { formatClosedLabel } from '../../utils/closed-session';
import { SectionBox } from '../ui';
import { CharmClock } from './CharmClock';
import { ConvexityMatrix } from './ConvexityMatrix';
import { DealerStateSummaryStrip } from './DealerStateSummaryStrip';
import { DexoflowVelocityTape } from './DexoflowVelocityTape';
import { ExpectedMoveTile } from './ExpectedMoveTile';
import { GammaCompass } from './GammaCompass';
import { NetVannaTile } from './NetVannaTile';
import { StrikeMoverLadder } from './StrikeMoverLadder';

interface GexbotSectionProps {
  marketOpen: boolean;
  /**
   * Live SPX spot (Schwab via useMarketData). Forwarded to
   * StrikeMoverLadder; other children don't use it.
   */
  spxSpot: number | null;
}

const SNAPSHOTS_SPEC = { view: 'snapshots-latest' as const };

/** The section's one closed label: the capture time of the last session. */
function ClosedLabel({ label }: { label: string }) {
  return (
    <span
      data-testid="gexbot-closed-label"
      className="text-muted font-mono text-[10px]"
    >
      CLOSED · as of {label}
    </span>
  );
}

function GexbotSectionInner({ marketOpen, spxSpot }: GexbotSectionProps) {
  // The snapshots read the children already make (deduped by URL), for the
  // header label and the ladder's closed-session inputs.
  const { rows, asOf } = useGexbotData(SNAPSHOTS_SPEC, marketOpen);
  const fallbackSpot = rows.find((r) => r.ticker === 'SPX')?.spot ?? null;
  // The clock is read at render, and only decides whether the label carries a
  // date (a capture more than 6 days old), so a tab that stays closed needs no
  // tick. An empty label (a capture time that does not parse) keeps the plain
  // header, so a bare "CLOSED · as of" never dangles.
  const closedLabel =
    !marketOpen && asOf != null ? formatClosedLabel(asOf, new Date()) : '';
  return (
    <SectionBox
      label="GEXBot Taker Flow"
      collapsible
      headerRight={
        closedLabel === '' ? undefined : <ClosedLabel label={closedLabel} />
      }
    >
      <div className="flex flex-col gap-3">
        <DealerStateSummaryStrip marketOpen={marketOpen} />
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <ExpectedMoveTile marketOpen={marketOpen} />
          <NetVannaTile marketOpen={marketOpen} />
        </div>
        <StrikeMoverLadder
          marketOpen={marketOpen}
          spxSpot={spxSpot}
          sessionAsOf={asOf}
          fallbackSpot={fallbackSpot}
        />
        <CharmClock marketOpen={marketOpen} />
        <GammaCompass marketOpen={marketOpen} />
        <DexoflowVelocityTape marketOpen={marketOpen} />
        <ConvexityMatrix marketOpen={marketOpen} />
      </div>
      <p className="text-tertiary mt-3 text-[10px] leading-relaxed">
        GEXBot Orderflow-tier data — taker-side exposure and flow metrics for 14
        underlyings (plus ES_SPX / NQ_NDX futures views of SPX / NDX), captured
        every minute during market hours.
      </p>
    </SectionBox>
  );
}

export const GexbotSection = memo(GexbotSectionInner);
