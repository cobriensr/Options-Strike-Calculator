/**
 * LevelLadder — the GEXBot levels, the ±1σ band and the trader's short
 * strikes on one spot-anchored SPX strike scale, with the answer stated: how
 * far each short strike is in σ, the priced odds of a touch and of finishing
 * beyond it, and a status.
 *
 * This component only feeds the model and lays out what it returns.
 * `buildLevelLadder` (level-ladder/build.ts) computes and prints every
 * distance, σ, probability and status; nothing here does that arithmetic.
 *
 * Data: both views through `useGexbotData` (the hook shares one in-flight
 * request per URL with the sibling tiles): the SPX row of `snapshots-latest`
 * for the levels, and the SPX row of `expected-move` for σ and its per-strike
 * IVs, which price each short strike. Spot is the Schwab quote while it is
 * fresh (`useQuoteStaleness`, the hook behind the header's quote badge), else
 * the expected-move row's spot (GEXBot's own), named as such in the header.
 * The only timer is the 30 s clock re-read while the market is open, so
 * levels that stop updating age out without a new poll.
 *
 * States, in the spec's order: no spot (waiting), a view still on its first
 * answer (loading), both views failed (error), otherwise the ladder, where a
 * view that answered with an error or nothing degrades on its own. Spec state
 * 2 says "both views still loading"; this reads it as "until both have
 * answered", because the model's result line would otherwise print "Expected
 * move unavailable" over a view that is only slow, and the component cannot
 * suppress a model string.
 *
 * Short strikes are the calculator's 10Δ candidates (`allDeltas`). Open
 * positions are phase 4 (`NO_OPEN_STRIKES`).
 *
 * Spec: docs/superpowers/specs/gexbot-level-ladder-2026-11-22.md
 */

import { memo, useMemo, type ReactNode } from 'react';

import { useGexbotData } from '../../hooks/useGexbotData';
import type { MarketSession } from '../../hooks/useMarketData';
import { useQuoteStaleness } from '../../hooks/useQuoteStaleness';
import { theme } from '../../themes';
import type { DeltaRow, DeltaRowError } from '../../types';
import { StatusBadge } from '../ui';
import {
  buildLevelLadder,
  candidatesFromDeltas,
  isViewFailed,
  pickLadderSpot,
} from './level-ladder/build';
import {
  STATUS_PILL_LABEL,
  type LadderChip,
  type LadderEdge,
  type LadderMarkerKind,
  type LadderMarkerRow,
  type LadderStrikeInput,
  type LadderStrikeRow,
  type StrikeStatus,
} from './level-ladder/types';
import { useNow } from './session-clock';

interface LevelLadderProps {
  marketOpen: boolean;
  /** SPX last price from Schwab via useMarketData in App.tsx; null with none. */
  spxSpot: number | null;
  /**
   * The calculator's strike rows, whose 10Δ row gives the candidate short
   * strikes. Null with no calculation, and in backtest mode, where the
   * calculator describes a past moment while the levels are live.
   */
  allDeltas: ReadonlyArray<DeltaRow | DeltaRowError> | null;
  /** Epoch ms of the last successful quotes fetch (`useMarketData`). */
  quotesFetchedAt: number | null;
  session: MarketSession;
}

const SNAPSHOTS_SPEC = { view: 'snapshots-latest' as const };
const MOVE_SPEC = { view: 'expected-move' as const };

/** Open short legs come with phase 4; until then only candidates show. */
const NO_OPEN_STRIKES: readonly LadderStrikeInput[] = [];

const PILL_COLOR: Record<StrikeStatus, string> = {
  clear: theme.accent,
  watch: theme.caution,
  tested: theme.red,
  breached: theme.red,
};

/**
 * A body column wraps under the other below this width, but never asks for
 * more than its body has (a 320 px phone's body is narrower than 11rem).
 */
const COLUMN_MIN = 'min-w-[min(11rem,100%)]';

const CHIP_BASE =
  'max-w-full rounded-full border px-2 py-0.5 font-mono text-[10px] leading-tight break-words';
const SHORT_CHIP = `${CHIP_BASE} border-accent text-accent`;
const LEVEL_CHIP = `${CHIP_BASE} border-edge-strong bg-surface-alt text-secondary`;

const MARKER_STYLE: Record<LadderMarkerKind, { text: string; line: string }> = {
  spot: { text: 'text-accent font-semibold', line: 'border-t-2 border-accent' },
  upper: {
    text: 'text-caution',
    line: 'border-t border-dashed border-caution',
  },
  lower: {
    text: 'text-caution',
    line: 'border-t border-dashed border-caution',
  },
  level: { text: 'text-secondary', line: 'border-t border-edge-strong' },
};

// ────────────────────────────────────────────────────────────
// Pieces
// ────────────────────────────────────────────────────────────

function Pill({ status }: { status: StrikeStatus }) {
  return (
    <StatusBadge label={STATUS_PILL_LABEL[status]} color={PILL_COLOR[status]} />
  );
}

/** The loading, waiting and error boxes, shaped like the sibling tiles'. */
function NoticeBox({
  testId,
  tone,
  children,
}: {
  testId: string;
  tone: 'neutral' | 'warn';
  children: ReactNode;
}) {
  const toneClasses =
    tone === 'warn'
      ? 'border-amber-500/20 bg-amber-500/5 text-amber-300/80'
      : 'text-tertiary border-white/5 bg-white/[0.02]';
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={testId}
      className={`rounded-md border px-3 py-2 text-xs ${toneClasses}`}
    >
      {children}
    </div>
  );
}

function ChipView({ chip }: { chip: LadderChip }) {
  return (
    <span className={chip.kind === 'short' ? SHORT_CHIP : LEVEL_CHIP}>
      {chip.label}
    </span>
  );
}

const chipKey = (chip: LadderChip) =>
  chip.kind === 'short' ? `${chip.source}-${chip.side}` : chip.id;

/**
 * One listed strike. A tagged row (a chip on it) is full height with its
 * chips and its second column side by side, the column dropping under the
 * chips on a phone; an untagged row is the strike alone, thin and tertiary.
 */
const StrikeRowItem = memo(function StrikeRowItem({
  row,
}: {
  row: LadderStrikeRow;
}) {
  const tagged = row.chips.length > 0;
  // A candidate with no odds (no usable expected move) is still a short-strike
  // row: its distance reads as the answer, not as a level's.
  const isShort = row.chips.some((chip) => chip.kind === 'short');
  return (
    <li
      data-testid={`level-ladder-row-${row.strike}`}
      className={
        tagged
          ? 'flex items-start gap-2 py-1'
          : 'text-tertiary flex gap-2 py-px text-[10px]'
      }
    >
      <span
        className={`w-14 shrink-0 text-right font-mono tabular-nums ${
          tagged ? 'text-primary text-[11px] font-medium' : ''
        }`}
      >
        {row.strikeText}
      </span>
      {tagged && (
        <div className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-1">
          <div
            className={`flex ${COLUMN_MIN} flex-1 flex-wrap items-start gap-1`}
          >
            {row.chips.map((chip) => (
              <ChipView key={chipKey(chip)} chip={chip} />
            ))}
          </div>
          <div
            className={`flex ${COLUMN_MIN} flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] ${
              isShort ? 'text-primary' : 'text-tertiary'
            }`}
          >
            {row.status != null && (
              <>
                <Pill status={row.status} />{' '}
              </>
            )}
            {row.detail != null && <span>{row.detail}</span>}
          </div>
        </div>
      )}
    </li>
  );
});

/** Spot, the ±1σ lines, zero gamma and any off-grid level: a full-width line. */
const MarkerRowItem = memo(function MarkerRowItem({
  row,
}: {
  row: LadderMarkerRow;
}) {
  const style = MARKER_STYLE[row.marker];
  return (
    <li
      data-testid={`level-ladder-marker-${row.levelId ?? row.marker}`}
      className="flex flex-wrap items-center gap-x-2 py-0.5 font-mono text-[10px]"
    >
      <span className={`min-w-0 break-words ${style.text}`}>{row.text}</span>
      <span aria-hidden="true" className={`min-w-6 flex-1 ${style.line}`} />
      {row.detail != null && (
        <span className="text-tertiary">{row.detail}</span>
      )}
    </li>
  );
});

/**
 * What fell outside the window on one side: the model's own `edge.text`. A
 * short strike out there keeps its odds in its item, away from the column
 * header that calls them priced, so each item that prints a probability gets
 * " · priced odds" inserted right after its own text, before the next item.
 * That way the word sits next to the odds it describes and not after a level
 * that follows. A breached strike prints no probability (only how far past it
 * spot is), and a level or bound has none, so those items get no suffix.
 *
 * The line is the model's string with the insertions, so the side word and the
 * separator stay the model's. Item texts are distinct and none holds another
 * (each carries its own label and price), so the first match is the item.
 */
function EdgeLine({
  testId,
  edge,
  className,
}: {
  testId: string;
  edge: LadderEdge;
  className: string;
}) {
  if (edge.text == null) return null;
  const line = edge.items.reduce(
    (text, item) =>
      item.odds?.finishBeyond == null
        ? text
        : text.replace(item.text, () => `${item.text} · priced odds`),
    edge.text,
  );
  return (
    <div
      data-testid={testId}
      className={`text-tertiary text-[10px] break-words ${className}`}
    >
      {line}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// The panel
// ────────────────────────────────────────────────────────────

function LevelLadderInner({
  marketOpen,
  spxSpot,
  allDeltas,
  quotesFetchedAt,
  session,
}: LevelLadderProps) {
  const levelsView = useGexbotData(SNAPSHOTS_SPEC, marketOpen);
  const moveView = useGexbotData(MOVE_SPEC, marketOpen);
  const { isStale } = useQuoteStaleness(quotesFetchedAt, session);
  // The clock the model ages the views by. It is re-read every 30 s while the
  // market is open, so levels that stop updating age out without a new poll.
  const now = useNow(marketOpen ? 30_000 : null);
  const nowMs = now.getTime();

  const snapshot = useMemo(
    () => levelsView.rows.find((r) => r.ticker === 'SPX') ?? null,
    [levelsView.rows],
  );
  const moveRow = useMemo(
    () => moveView.rows.find((r) => r.ticker === 'SPX') ?? null,
    [moveView.rows],
  );
  const candidates = useMemo(
    () => candidatesFromDeltas(allDeltas),
    [allDeltas],
  );
  const levelsFailed = isViewFailed(levelsView);
  const moveFailed = isViewFailed(moveView);

  // A stale or missing quote falls back to GEXBot's spot, the expected-move
  // row's (the spec's chain).
  const ladderSpot = pickLadderSpot({
    spxSpot,
    spxSpotStale: isStale,
    gexbotSpot: moveRow?.spot ?? null,
    marketOpen,
  });
  const spot = ladderSpot?.spot ?? null;

  const ladder = useMemo(
    () =>
      buildLevelLadder({
        spot,
        snapshot,
        expectedMove: moveRow,
        strikeIvs: moveRow?.strikeIvs ?? null,
        levelsFailed,
        expectedMoveFailed: moveFailed,
        candidates,
        openShortStrikes: NO_OPEN_STRIKES,
        nowMs,
        marketOpen,
      }),
    [
      spot,
      snapshot,
      moveRow,
      levelsFailed,
      moveFailed,
      candidates,
      nowMs,
      marketOpen,
    ],
  );

  // The states, in the spec's order. The model prints a spot text for exactly
  // the spots `pickLadderSpot` accepts, so the second test only narrows.
  if (ladderSpot == null || ladder.spotText == null) {
    return (
      <NoticeBox testId="level-ladder-waiting" tone="neutral">
        Level Ladder — waiting for SPX spot
      </NoticeBox>
    );
  }
  // State 2 (see the file header): held until both views have answered.
  if (levelsView.loading || moveView.loading) {
    return (
      <NoticeBox testId="level-ladder-loading" tone="neutral">
        Level Ladder — loading…
      </NoticeBox>
    );
  }
  if (levelsFailed && moveFailed) {
    const messages = new Set(
      [levelsView.error, moveView.error].filter((e): e is string => e != null),
    );
    return (
      <NoticeBox testId="level-ladder-error" tone="warn">
        Level Ladder — {[...messages].join(' · ')}
      </NoticeBox>
    );
  }

  const { result, levels, summary, above, below } = ladder;
  const headerParts = [
    'Level Ladder — SPX 0DTE',
    `${ladderSpot.label} ${ladder.spotText}`,
  ];
  if (levels.asOfText != null) headerParts.push(`levels ${levels.asOfText}`);

  return (
    <div
      data-testid="level-ladder"
      role="group"
      aria-label="Level Ladder"
      className="rounded-md border border-white/5 bg-white/[0.02]"
    >
      <div className="flex items-baseline justify-between border-b border-white/5 px-3 py-2">
        <span
          data-testid="level-ladder-header"
          className="text-tertiary text-[10px] tracking-wide uppercase"
        >
          {headerParts.join(' · ')}
        </span>
      </div>

      <div
        data-testid="level-ladder-result"
        className="flex items-start gap-2 border-b border-white/5 px-3 py-2 text-xs"
      >
        {result.pill != null && (
          <>
            <span className="shrink-0">
              <Pill status={result.pill} />
            </span>{' '}
          </>
        )}
        <span className="text-secondary min-w-0 flex-1 break-words">
          {result.text}
        </span>
      </div>

      {levels.line != null && (
        <div
          data-testid="level-ladder-levels-line"
          className="text-tertiary border-b border-white/5 px-3 py-1.5 text-[10px]"
        >
          {levels.line}
        </div>
      )}

      <div
        data-testid="level-ladder-columns"
        className="text-tertiary flex gap-2 border-b border-white/5 px-3 py-1.5 text-[10px] tracking-wide uppercase"
      >
        <span className="w-14 shrink-0 text-right">Strike</span>
        <div className="flex min-w-0 flex-1 flex-wrap gap-x-3">
          <span className={`${COLUMN_MIN} flex-1`}>On this strike</span>
          <span className={`${COLUMN_MIN} flex-1`}>
            From spot · priced odds
          </span>
        </div>
      </div>

      <EdgeLine
        testId="level-ladder-edge-above"
        edge={above}
        className="px-3 pt-2"
      />
      <ul aria-label="SPX strike ladder" className="px-3 py-2">
        {ladder.rows.map((row) =>
          row.kind === 'marker' ? (
            <MarkerRowItem
              key={`marker-${row.levelId ?? row.marker}`}
              row={row}
            />
          ) : (
            <StrikeRowItem key={`strike-${row.strike}`} row={row} />
          ),
        )}
      </ul>
      <EdgeLine
        testId="level-ladder-edge-below"
        edge={below}
        className="px-3 pb-2"
      />

      {(summary.call != null || summary.put != null) && (
        <div className="text-tertiary space-y-0.5 border-t border-white/5 px-3 py-2 text-[10px]">
          {summary.call != null && (
            <div data-testid="level-ladder-summary-call">{summary.call}</div>
          )}
          {summary.put != null && (
            <div data-testid="level-ladder-summary-put">{summary.put}</div>
          )}
        </div>
      )}
    </div>
  );
}

export const LevelLadder = memo(LevelLadderInner);
