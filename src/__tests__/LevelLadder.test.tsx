import '@testing-library/jest-dom';
import { act, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ExpectedMoveRow,
  GexbotView,
  SnapshotsLatestRow,
} from '../hooks/useGexbotData';
import type { DeltaRow, DeltaRowError } from '../types';

const mockUseGexbotData = vi.fn();
vi.mock('../hooks/useGexbotData', () => ({
  useGexbotData: (...args: unknown[]) => mockUseGexbotData(...args),
}));

import { LevelLadder } from '../components/Gexbot/LevelLadder';
import type { LadderStrikeIv } from '../components/Gexbot/level-ladder/types';
import { titledGenericsWithoutHint } from './helpers/aria';
import { dealerClaims } from './helpers/dealer-claims';

// ────────────────────────────────────────────────────────────
// Fixtures: the spec's sample ladder (spot 7,588.4, E 23.0, 10Δ call 7,620
// and put 7,555), read at 09:46 CT on 2026-11-25 (CST, UTC−6). The views are
// mocked at the hook boundary; strike IVs live on the expected-move row only.
// ────────────────────────────────────────────────────────────

const NOW_ISO = '2026-11-25T15:46:00.000Z';
const NOW = Date.parse(NOW_ISO);
const SPOT = 7588.4;

function snapshot(over: Partial<SnapshotsLatestRow> = {}): SnapshotsLatestRow {
  return {
    ticker: 'SPX',
    capturedAt: '2026-11-25T15:45:12.000Z', // 09:45 CT
    spot: 7588.1,
    zeroGamma: 7586.2,
    zMlgamma: 7595,
    zMsgamma: 7580,
    zcvr: null,
    zgr: null,
    zvanna: null,
    zcharm: null,
    oMlgamma: null,
    oMsgamma: null,
    ocvr: null,
    ogr: null,
    ovanna: null,
    ocharm: null,
    oneDexoflow: null,
    oneGexoflow: null,
    oneCvroflow: null,
    zeroMcall: 7600,
    zeroMput: 7570,
    majorPosVol: 7605,
    majorPosOi: null,
    majorNegVol: 7560,
    majorNegOi: null,
    minDte: 0,
    ...over,
  };
}

/** Every level present: eight strike chips and the zero-gamma marker. */
const ALL_LEVELS: Partial<SnapshotsLatestRow> = {
  majorPosOi: 7610,
  majorNegOi: 7565,
};

/** Stamped at now, so `E` is the row's 23.0 exactly. */
function expectedMove(over: Partial<ExpectedMoveRow> = {}): ExpectedMoveRow {
  return {
    ticker: 'SPX',
    capturedAt: NOW_ISO,
    asOf: NOW_ISO,
    spot: 7588.1,
    minDte: 0,
    atmStrike: 7590,
    atmIv: 0.11,
    dteFraction: 0.25,
    expectedMove: 23,
    lower: 7565.1,
    upper: 7611.1,
    unavailable: null,
    strikeIvs: [],
    ...over,
  };
}

/**
 * A skew that prices both candidates `watch` where the ATM σ reads them
 * `clear` (the phase 2 build test's own sample).
 */
const SKEWED_IVS: LadderStrikeIv[] = [
  { strike: 7615, callIv: 0.13, putIv: 0.13 },
  { strike: 7620, callIv: 0.129, putIv: 0.129 },
  { strike: 7625, callIv: 0.128, putIv: 0.128 },
  { strike: 7550, callIv: 0.16, putIv: 0.16 },
  { strike: 7555, callIv: 0.158, putIv: 0.158 },
  { strike: 7560, callIv: 0.156, putIv: 0.156 },
];

const deltaRow = (delta: number, callSnapped: number, putSnapped: number) =>
  ({ delta, callSnapped, putSnapped }) as unknown as DeltaRow;
const DELTAS: ReadonlyArray<DeltaRow | DeltaRowError> = [
  deltaRow(5, 7650, 7520),
  deltaRow(10, 7620, 7555),
  deltaRow(15, 7610, 7565),
];

interface ViewState {
  rows: unknown[];
  loading: boolean;
  error: string | null;
}

const ready = (...rows: unknown[]): ViewState => ({
  rows,
  loading: false,
  error: null,
});
const LOADING: ViewState = { rows: [], loading: true, error: null };
const failed = (message: string): ViewState => ({
  rows: [],
  loading: false,
  error: message,
});

/** Answers each view by its spec, the way the section's children read them. */
function answer(levels: ViewState, move: ViewState) {
  mockUseGexbotData.mockImplementation((spec: GexbotView) => {
    const view = spec.view === 'snapshots-latest' ? levels : move;
    return { ...view, freshestAt: null, asOf: null };
  });
}

function renderLadder(over: Partial<ComponentProps<typeof LevelLadder>> = {}) {
  return render(
    <LevelLadder
      marketOpen
      spxSpot={SPOT}
      allDeltas={DELTAS}
      quotesFetchedAt={NOW - 5_000}
      session="regular"
      {...over}
    />,
  );
}

const rowText = (strike: number) =>
  screen.getByTestId(`level-ladder-row-${strike}`);

beforeEach(() => {
  mockUseGexbotData.mockReset();
  answer(ready(snapshot()), ready(expectedMove()));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

// ────────────────────────────────────────────────────────────
// The ladder, laid out
// ────────────────────────────────────────────────────────────

describe('<LevelLadder> layout', () => {
  it('reads both views for the section, with the market gate forwarded', () => {
    renderLadder();
    expect(mockUseGexbotData).toHaveBeenCalledWith(
      { view: 'snapshots-latest' },
      true,
    );
    expect(mockUseGexbotData).toHaveBeenCalledWith(
      { view: 'expected-move' },
      true,
    );
  });

  it('prints the header with the spot and the levels time', () => {
    renderLadder();
    expect(screen.getByTestId('level-ladder-header')).toHaveTextContent(
      'Level Ladder — SPX 0DTE · spot 7,588.4 · levels 09:45 CT',
    );
  });

  it('names the panel as a group', () => {
    renderLadder();
    expect(
      screen.getByRole('group', { name: 'Level Ladder' }),
    ).toBeInTheDocument();
  });

  it("puts the model's result line in its own band, with the pill", () => {
    renderLadder();
    const band = screen.getByTestId('level-ladder-result');
    expect(band).toHaveTextContent(
      'CLEAR Both candidate strikes are clear. Call 7,620 is 1.37σ away with a 17% priced chance of a touch. Put 7,555 is 1.45σ away with 15%.',
    );
  });

  it('marks spot and the ±1σ band with their words', () => {
    renderLadder();
    expect(screen.getByTestId('level-ladder-marker-spot')).toHaveTextContent(
      'SPX 7,588.4',
    );
    expect(screen.getByTestId('level-ladder-marker-upper')).toHaveTextContent(
      '+1σ · 7,611.4',
    );
    expect(screen.getByTestId('level-ladder-marker-lower')).toHaveTextContent(
      '−1σ · 7,565.4',
    );
  });

  it('draws zero gamma as a marker line, not a chip', () => {
    renderLadder();
    expect(
      screen.getByTestId('level-ladder-marker-classic_zero_gamma'),
    ).toHaveTextContent('Classic zero gamma · 7,586.2');
  });

  it('shows one chip per level and one per candidate', () => {
    answer(ready(snapshot(ALL_LEVELS)), ready(expectedMove()));
    renderLadder();
    const chipLabels = [
      'Classic major positive · volume',
      'Classic major negative · volume',
      'Classic major positive · OI',
      'Classic major negative · OI',
      'State long gamma · taker-long',
      'State short gamma · taker-short',
      'State major call',
      'State major put',
    ];
    for (const label of chipLabels) {
      expect(screen.getAllByText(label)).toHaveLength(1);
    }
    expect(screen.getAllByText('CANDIDATE · 10Δ CALL')).toHaveLength(1);
    expect(screen.getAllByText('CANDIDATE · 10Δ PUT')).toHaveLength(1);
  });

  it('puts a level chip on its strike with its distance and band position', () => {
    renderLadder();
    const row = rowText(7605);
    expect(row).toHaveTextContent('Classic major positive · volume');
    expect(row).toHaveTextContent('+16.6 pts · inside +1σ');
  });

  it("puts a candidate's pill and priced odds on its strike", () => {
    renderLadder();
    const row = rowText(7620);
    expect(row).toHaveTextContent('CANDIDATE · 10Δ CALL');
    expect(within(row).getByText('CLEAR')).toBeInTheDocument();
    expect(row).toHaveTextContent('1.37σ · touch 17% · finish beyond 8%');
    expect(rowText(7555)).toHaveTextContent(
      '1.45σ · touch 15% · finish beyond 7%',
    );
  });

  it('leaves an untagged strike as its price alone', () => {
    renderLadder();
    const row = rowText(7615);
    expect(row.textContent).toBe('7,615');
    expect(within(row).queryByText(/pts|σ/)).toBeNull();
    // The strike alone: no chip column and no second column behind it.
    expect(row.children).toHaveLength(1);
    // A tagged row has both: the strike, then the body.
    expect(rowText(7605).children).toHaveLength(2);
  });

  it('prints the summary under each side', () => {
    renderLadder();
    expect(screen.getByTestId('level-ladder-summary-call')).toHaveTextContent(
      'Call 7,620: 31.6 pts above spot, 8.6 outside +1σ. Levels between: 7,595 · 7,600 · 7,605.',
    );
    expect(screen.getByTestId('level-ladder-summary-put')).toHaveTextContent(
      'Put 7,555: 33.4 pts below spot, 10.4 outside −1σ. Levels between: 7,580 · 7,570 · 7,560.',
    );
  });

  it('lists what fell outside the window on one line a side', () => {
    answer(
      ready(snapshot({ majorPosOi: 7700, majorNegOi: 7400 })),
      ready(expectedMove()),
    );
    renderLadder();
    expect(screen.getByTestId('level-ladder-edge-above')).toHaveTextContent(
      'Above: Classic major positive · OI 7,700',
    );
    expect(screen.getByTestId('level-ladder-edge-below')).toHaveTextContent(
      'Below: Classic major negative · OI 7,400',
    );
    // No odds on these lines, so nothing to call priced.
    expect(screen.getByTestId('level-ladder-edge-above')).not.toHaveTextContent(
      'priced',
    );
    expect(screen.getByTestId('level-ladder-edge-below')).not.toHaveTextContent(
      'priced',
    );
  });

  it('prints no edge line when nothing fell outside', () => {
    renderLadder();
    expect(screen.queryByTestId('level-ladder-edge-above')).toBeNull();
    expect(screen.queryByTestId('level-ladder-edge-below')).toBeNull();
  });

  it('calls the odds on an edge line priced, for a candidate beyond the window', () => {
    // E 61.5 puts the 10Δ strikes 1.3σ out and 80 pts away: past the ±60 pt
    // cap, so their odds are on the Above/Below lines, not on a row under the
    // column header.
    answer(ready(snapshot()), ready(expectedMove({ expectedMove: 61.5 })));
    renderLadder({ allDeltas: [deltaRow(10, 7670, 7510)] });
    expect(screen.queryByTestId('level-ladder-row-7670')).toBeNull();
    expect(screen.queryByTestId('level-ladder-row-7510')).toBeNull();
    expect(screen.getByTestId('level-ladder-edge-above').textContent).toBe(
      'Above: Call 7,670 (CLEAR 1.33σ · touch 18% · finish beyond 9%) · priced odds',
    );
    expect(screen.getByTestId('level-ladder-edge-below').textContent).toBe(
      'Below: Put 7,510 (CLEAR 1.27σ · touch 20% · finish beyond 10%) · priced odds',
    );
  });

  // The word sits right after the short strike's own odds, before the next
  // item, whichever side of it the level falls; it never trails a level.
  it.each([
    [
      'a level after the call',
      7700,
      'Above: Call 7,670 (CLEAR 1.33σ · touch 18% · finish beyond 9%) · priced odds; Classic major positive · OI 7,700',
    ],
    [
      'a level before the call',
      7660,
      'Above: Classic major positive · OI 7,660; Call 7,670 (CLEAR 1.33σ · touch 18% · finish beyond 9%) · priced odds',
    ],
  ])(
    'puts "priced" beside the short strike\'s odds on a mixed edge line: %s',
    (_where, level, expected) => {
      answer(
        ready(snapshot({ majorPosOi: level })),
        ready(expectedMove({ expectedMove: 61.5 })),
      );
      renderLadder({ allDeltas: [deltaRow(10, 7670, 7510)] });
      const text = screen.getByTestId('level-ladder-edge-above').textContent;
      expect(text).toBe(expected);
      expect(text?.match(/priced/g)).toHaveLength(1);
      // The level carries no suffix of its own.
      expect(text).not.toMatch(/OI [\d,]+ · priced/);
    },
  );

  it('joins several edge items with "; " and carries no "priced" without odds', () => {
    // Two levels above the window: the model's own line format, no odds.
    answer(
      ready(snapshot({ majorPosOi: 7700, zeroMcall: 7720 })),
      ready(expectedMove()),
    );
    renderLadder({ allDeltas: null });
    expect(screen.getByTestId('level-ladder-edge-above').textContent).toBe(
      'Above: Classic major positive · OI 7,700; State major call 7,720',
    );
  });

  it('prints no "priced" for a breached strike on an edge line', () => {
    // Spot is 88 pts past a call at 7,500: it has been touched, so the line
    // gives how far past it spot is and no probability.
    renderLadder({ allDeltas: [deltaRow(10, 7500, 7555)] });
    const below = screen.getByTestId('level-ladder-edge-below');
    expect(below).toHaveTextContent('Call 7,500 (BREACHED');
    expect(below).not.toHaveTextContent('priced');
    expect(below).not.toHaveTextContent('touch');
  });
});

describe('<LevelLadder> off-grid strike levels', () => {
  // The two state gamma levels are usually off the 5-pt grid (spec, "Levels"),
  // so they are usually marker lines, not chips.
  const OFF_GRID = { zMlgamma: 7592.4, zMsgamma: 7581.7 };

  it('draws each as a marker line with its distance and band position', () => {
    answer(ready(snapshot(OFF_GRID)), ready(expectedMove()));
    renderLadder();
    const long = screen.getByTestId('level-ladder-marker-state_long_gamma');
    expect(long).toHaveTextContent('State long gamma · taker-long · 7,592.4');
    expect(within(long).getByText('+4.0 pts · inside +1σ')).toBeInTheDocument();
    const short = screen.getByTestId('level-ladder-marker-state_short_gamma');
    expect(short).toHaveTextContent(
      'State short gamma · taker-short · 7,581.7',
    );
    expect(
      within(short).getByText('−6.7 pts · inside −1σ'),
    ).toBeInTheDocument();
  });

  it('carries no chip with either label, and leaves the on-grid rows untagged', () => {
    answer(ready(snapshot(OFF_GRID)), ready(expectedMove()));
    renderLadder();
    // A chip's text is the label alone; the marker's carries the price too.
    expect(screen.queryByText('State long gamma · taker-long')).toBeNull();
    expect(screen.queryByText('State short gamma · taker-short')).toBeNull();
    expect(rowText(7595).textContent).toBe('7,595');
    expect(rowText(7580).textContent).toBe('7,580');
  });

  it('adds one list item per off-grid level, each between its two rows', () => {
    answer(ready(snapshot(OFF_GRID)), ready(expectedMove()));
    renderLadder();
    // 18 with both on the grid (the list test above), plus the two markers.
    expect(
      within(screen.getByRole('list')).getAllByRole('listitem'),
    ).toHaveLength(20);
    const long = screen.getByTestId('level-ladder-marker-state_long_gamma');
    expect(long.previousElementSibling).toBe(rowText(7595));
    expect(long.nextElementSibling).toBe(rowText(7590));
    const short = screen.getByTestId('level-ladder-marker-state_short_gamma');
    expect(short.previousElementSibling).toBe(rowText(7585));
    expect(short.nextElementSibling).toBe(rowText(7580));
  });

  it('prints the distance alone when the expected move failed', () => {
    answer(ready(snapshot(OFF_GRID)), failed('boom (HTTP 500)'));
    renderLadder();
    const long = screen.getByTestId('level-ladder-marker-state_long_gamma');
    expect(within(long).getByText('+4.0 pts')).toBeInTheDocument();
    expect(long).not.toHaveTextContent('inside');
    const short = screen.getByTestId('level-ladder-marker-state_short_gamma');
    expect(within(short).getByText('−6.7 pts')).toBeInTheDocument();
    expect(short).not.toHaveTextContent('inside');
  });
});

describe('<LevelLadder> list and column header', () => {
  it('is one list whose items are the strike and marker rows', () => {
    renderLadder();
    const list = screen.getByRole('list');
    // The spec's sketch: 7,620 down to 7,555 is 14 strikes, plus spot, +1σ, −1σ
    // and zero gamma.
    expect(within(list).getAllByRole('listitem')).toHaveLength(18);
    expect(screen.getAllByRole('list')).toHaveLength(1);
  });

  it('names the list', () => {
    renderLadder();
    expect(
      screen.getByRole('list', { name: 'SPX strike ladder' }),
    ).toBeInTheDocument();
  });

  it('prints a column header line that is not a list item and says "priced"', () => {
    renderLadder();
    const columns = screen.getByTestId('level-ladder-columns');
    expect(columns).toHaveTextContent('Strike');
    expect(columns).toHaveTextContent('On this strike');
    expect(columns).toHaveTextContent('From spot · priced odds');
    expect(columns.closest('li')).toBeNull();
    expect(within(screen.getByRole('list')).queryByText('Strike')).toBeNull();
  });

  it('never asks a column for more width than its body has (320 px phones)', () => {
    const { container } = renderLadder();
    const capped = '[class*="min-w-[min(11rem,100%)]"]';
    // Both header labels, and both columns of a tagged row.
    expect(
      screen.getByTestId('level-ladder-columns').querySelectorAll(capped),
    ).toHaveLength(2);
    expect(rowText(7620).querySelectorAll(capped)).toHaveLength(2);
    expect(container.querySelectorAll('[class*="min-w-[11rem]"]')).toHaveLength(
      0,
    );
  });

  it('puts the column header between the result band and the list', () => {
    renderLadder();
    const result = screen.getByTestId('level-ladder-result');
    const columns = screen.getByTestId('level-ladder-columns');
    const list = screen.getByRole('list');
    expect(
      result.compareDocumentPosition(columns) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      columns.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

// ────────────────────────────────────────────────────────────
// Wording and accessibility guards
// ────────────────────────────────────────────────────────────

describe('<LevelLadder> wording', () => {
  it('carries no title attribute, and no titled generic element', () => {
    answer(ready(snapshot(ALL_LEVELS)), ready(expectedMove()));
    const { container } = renderLadder();
    expect(container.querySelectorAll('[title]')).toHaveLength(0);
    expect(titledGenericsWithoutHint(container)).toEqual([]);
  });

  it('makes no dealer claims on a fully populated ladder', () => {
    answer(ready(snapshot(ALL_LEVELS)), ready(expectedMove()));
    const { container } = renderLadder();
    expect(container.textContent).toContain('Classic major negative · OI');
    expect(dealerClaims(container.textContent ?? '')).toEqual([]);
  });

  it('makes no dealer claims in the no-short-strikes or closed lines', () => {
    const open = renderLadder({ allDeltas: null });
    expect(open.container.textContent).toContain('No short strikes to check.');
    expect(dealerClaims(open.container.textContent ?? '')).toEqual([]);
    open.unmount();
    const closed = renderLadder({ marketOpen: false, session: 'closed' });
    expect(closed.container.textContent).toContain('Session closed.');
    expect(dealerClaims(closed.container.textContent ?? '')).toEqual([]);
  });

  it('gives every status pill its word', () => {
    answer(ready(snapshot()), ready(expectedMove({ strikeIvs: SKEWED_IVS })));
    renderLadder();
    expect(within(rowText(7620)).getByText('WATCH')).toBeInTheDocument();
    expect(within(rowText(7555)).getByText('WATCH')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('level-ladder-result')).getByText('WATCH'),
    ).toBeInTheDocument();
  });
});

// ────────────────────────────────────────────────────────────
// Short strikes
// ────────────────────────────────────────────────────────────

describe('<LevelLadder> short strikes', () => {
  it('shows no candidate chips when allDeltas is null', () => {
    renderLadder({ allDeltas: null });
    expect(screen.queryByText(/CANDIDATE/)).toBeNull();
    expect(screen.getByTestId('level-ladder-result')).toHaveTextContent(
      'No short strikes to check. Nearest levels: State long gamma · taker-long 7,595 (+6.6 pts) above, State short gamma · taker-short 7,580 (−8.4 pts) below.',
    );
    expect(screen.queryByTestId('level-ladder-summary-call')).toBeNull();
    expect(screen.queryByTestId('level-ladder-summary-put')).toBeNull();
  });

  it('shows no candidate chips for an error row at 10Δ', () => {
    renderLadder({
      allDeltas: [{ delta: 10, error: 'Strike out of range' } as DeltaRowError],
    });
    expect(screen.queryByText(/CANDIDATE/)).toBeNull();
  });

  it("prices the candidates from the expected-move row's own strike IVs", () => {
    answer(ready(snapshot()), ready(expectedMove({ strikeIvs: SKEWED_IVS })));
    renderLadder();
    // The same row without strike IVs reads CLEAR (the next test): the skew
    // moved it, so the row's strikeIvs reached the model.
    expect(screen.getByTestId('level-ladder-result')).toHaveTextContent(
      'WATCH Put 7,555 is on watch: 1.15σ away, a 25% priced chance of a touch and 13% of finishing beyond. Call is on watch.',
    );
    expect(rowText(7620)).toHaveTextContent(
      '1.19σ · touch 23% · finish beyond 12%',
    );
  });

  it('still prints odds when the row sent no strike IVs (the ATM σ fallback)', () => {
    answer(ready(snapshot()), ready(expectedMove({ strikeIvs: [] })));
    renderLadder();
    expect(rowText(7620)).toHaveTextContent(
      '1.37σ · touch 17% · finish beyond 8%',
    );
    expect(screen.getByTestId('level-ladder-result')).toHaveTextContent(
      'CLEAR Both candidate strikes are clear.',
    );
  });

  it('keeps a candidate with no odds in the short-strike style, and a level row in its own', () => {
    // No expected move, so no odds: the candidate's distance is still the
    // answer on its row, and a level's distance stays the quieter text.
    answer(ready(snapshot()), ready());
    renderLadder();
    const candidate = within(rowText(7620)).getByText('+31.6 pts');
    expect(candidate.parentElement).toHaveClass('text-primary');
    const level = within(rowText(7605)).getByText('+16.6 pts');
    expect(level.parentElement).toHaveClass('text-tertiary');
  });
});

// ────────────────────────────────────────────────────────────
// States, in the spec's order
// ────────────────────────────────────────────────────────────

describe('<LevelLadder> states', () => {
  it('waits for a spot when there is neither a quote nor an expected-move spot', () => {
    // The spec's chain stops at the expected-move row: the levels row's own
    // spot (7,588.1 here) is not a fallback.
    answer(ready(snapshot()), ready(expectedMove({ spot: null })));
    renderLadder({ spxSpot: null, quotesFetchedAt: null });
    const box = screen.getByTestId('level-ladder-waiting');
    expect(box).toHaveAttribute('role', 'status');
    expect(box).toHaveTextContent('Level Ladder — waiting for SPX spot');
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('puts the missing spot ahead of loading and of failing', () => {
    answer(LOADING, LOADING);
    const loading = renderLadder({ spxSpot: null, quotesFetchedAt: null });
    expect(screen.getByTestId('level-ladder-waiting')).toBeInTheDocument();
    expect(screen.queryByTestId('level-ladder-loading')).toBeNull();
    loading.unmount();

    answer(failed('boom (HTTP 500)'), failed('boom (HTTP 500)'));
    renderLadder({ spxSpot: null, quotesFetchedAt: null });
    expect(screen.getByTestId('level-ladder-waiting')).toBeInTheDocument();
    expect(screen.queryByTestId('level-ladder-error')).toBeNull();
  });

  it('shows the loading box while both views are loading', () => {
    answer(LOADING, LOADING);
    renderLadder();
    const box = screen.getByTestId('level-ladder-loading');
    expect(box).toHaveAttribute('role', 'status');
    expect(box).toHaveTextContent('Level Ladder — loading…');
    expect(screen.queryByRole('list')).toBeNull();
  });

  // Spec state 2 says "both views still loading"; the component reads it as
  // "until both views have answered", because the model's result line would
  // print "Expected move unavailable" over a view that is only slow.
  it.each([
    ['the levels', LOADING, ready(expectedMove())],
    ['the expected move', ready(snapshot()), LOADING],
  ])(
    'holds the loading box until both views have answered: %s still loading',
    (_which, levels, move) => {
      answer(levels, move);
      const { container } = renderLadder();
      expect(screen.getByTestId('level-ladder-loading')).toHaveTextContent(
        'Level Ladder — loading…',
      );
      expect(screen.queryByRole('list')).toBeNull();
      expect(container.textContent).not.toMatch(/unavailable|No GEXBot levels/);
    },
  );

  it.each([
    ['empty', ready()],
    ['failed', failed('boom (HTTP 500)')],
  ])(
    'a view that has answered %s no longer holds the loading box',
    (_how, answered) => {
      answer(answered, ready(expectedMove()));
      renderLadder();
      expect(screen.queryByTestId('level-ladder-loading')).toBeNull();
      expect(screen.getByRole('list')).toBeInTheDocument();
    },
  );

  it('shows the error box, with both messages, when both views failed', () => {
    answer(failed('levels down (HTTP 503)'), failed('move down (HTTP 500)'));
    renderLadder();
    const box = screen.getByTestId('level-ladder-error');
    expect(box).toHaveAttribute('role', 'status');
    expect(box).toHaveTextContent('Level Ladder —');
    expect(box).toHaveTextContent('levels down (HTTP 503)');
    expect(box).toHaveTextContent('move down (HTTP 500)');
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('says a shared error once', () => {
    answer(failed('down (HTTP 503)'), failed('down (HTTP 503)'));
    renderLadder();
    expect(screen.getByTestId('level-ladder-error').textContent).toBe(
      'Level Ladder — down (HTTP 503)',
    );
  });

  it('with the levels view failed, drops chips and level markers and says so', () => {
    answer(failed('boom (HTTP 500)'), ready(expectedMove()));
    renderLadder();
    expect(screen.queryByTestId('level-ladder-error')).toBeNull();
    expect(screen.getByTestId('level-ladder-levels-line')).toHaveTextContent(
      'GEXBot levels unavailable',
    );
    expect(screen.queryByText('State major call')).toBeNull();
    expect(
      screen.queryByTestId('level-ladder-marker-classic_zero_gamma'),
    ).toBeNull();
    // The band, spot and short strikes stay.
    expect(screen.getByTestId('level-ladder-marker-upper')).toBeInTheDocument();
    expect(screen.getByTestId('level-ladder-marker-spot')).toBeInTheDocument();
    expect(rowText(7620)).toHaveTextContent('CANDIDATE · 10Δ CALL');
    expect(screen.getByTestId('level-ladder-header')).not.toHaveTextContent(
      'levels 09:45',
    );
  });

  it('with the expected-move view failed, prints distances only and keeps the levels', () => {
    answer(ready(snapshot()), failed('boom (HTTP 500)'));
    renderLadder();
    expect(screen.queryByTestId('level-ladder-error')).toBeNull();
    expect(screen.getByTestId('level-ladder-result')).toHaveTextContent(
      'Expected move unavailable. Distances only.',
    );
    expect(screen.queryByTestId('level-ladder-marker-upper')).toBeNull();
    expect(screen.queryByTestId('level-ladder-marker-lower')).toBeNull();
    expect(screen.getByText('State major call')).toBeInTheDocument();
    expect(rowText(7620)).toHaveTextContent('+31.6 pts');
    expect(within(rowText(7620)).queryByText('CLEAR')).toBeNull();
  });

  it('with an empty expected-move view, prints distances only', () => {
    answer(ready(snapshot()), ready());
    renderLadder();
    expect(screen.getByTestId('level-ladder-result')).toHaveTextContent(
      'Expected move unavailable. Distances only.',
    );
    expect(screen.getByText('State major call')).toBeInTheDocument();
  });

  it('says there are no levels for SPX when the levels view is empty', () => {
    answer(ready(), ready(expectedMove()));
    renderLadder();
    expect(screen.getByTestId('level-ladder-levels-line')).toHaveTextContent(
      'No GEXBot levels for SPX in the last 15 min',
    );
  });

  it('reads a failed read with the last rows held as no failure', () => {
    // The hook keeps the last good rows beside a later error.
    answer(
      { rows: [snapshot()], loading: false, error: 'blip (HTTP 503)' },
      { rows: [expectedMove()], loading: false, error: 'blip (HTTP 503)' },
    );
    renderLadder();
    expect(screen.queryByTestId('level-ladder-error')).toBeNull();
    expect(screen.queryByTestId('level-ladder-levels-line')).toBeNull();
    expect(screen.getByTestId('level-ladder-result')).toHaveTextContent(
      'Both candidate strikes are clear.',
    );
    expect(screen.getByText('State major call')).toBeInTheDocument();
  });

  it('prints the stale line, and keeps the band and short strikes, for old levels', () => {
    answer(
      ready(snapshot({ capturedAt: '2026-11-25T15:40:00.000Z' })),
      ready(expectedMove()),
    );
    renderLadder();
    expect(screen.getByTestId('level-ladder-levels-line')).toHaveTextContent(
      'GEXBot levels are 6 min old',
    );
    expect(screen.queryByText('State major call')).toBeNull();
    expect(screen.getByTestId('level-ladder-marker-upper')).toBeInTheDocument();
    expect(rowText(7620)).toHaveTextContent('CANDIDATE · 10Δ CALL');
    expect(screen.getByTestId('level-ladder-header')).toHaveTextContent(
      'levels 09:40 CT',
    );
  });

  it('prints no levels line while the levels are fine', () => {
    renderLadder();
    expect(screen.queryByTestId('level-ladder-levels-line')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// Spot
// ────────────────────────────────────────────────────────────

describe('<LevelLadder> spot', () => {
  it('uses a fresh Schwab quote and names it "spot"', () => {
    renderLadder({ spxSpot: 7590, quotesFetchedAt: NOW - 30_000 });
    const header = screen.getByTestId('level-ladder-header');
    expect(header).toHaveTextContent('spot 7,590.0');
    expect(header).not.toHaveTextContent('GEXBot spot');
  });

  it('falls back to the GEXBot spot once the quote is stale (91 s old)', () => {
    renderLadder({ spxSpot: 7500, quotesFetchedAt: NOW - 91_000 });
    const header = screen.getByTestId('level-ladder-header');
    expect(header).toHaveTextContent('GEXBot spot 7,588.1');
    expect(header).not.toHaveTextContent('7,500');
    expect(screen.getByTestId('level-ladder-marker-spot')).toHaveTextContent(
      'SPX 7,588.1',
    );
  });

  it('keeps the quote just under 90 s old', () => {
    renderLadder({ spxSpot: 7500, quotesFetchedAt: NOW - 89_000 });
    expect(screen.getByTestId('level-ladder-header')).toHaveTextContent(
      'spot 7,500.0',
    );
  });

  it('falls back to the GEXBot spot when there is no quote', () => {
    renderLadder({ spxSpot: null, quotesFetchedAt: null });
    expect(screen.getByTestId('level-ladder-header')).toHaveTextContent(
      'GEXBot spot 7,588.1',
    );
  });

  it('uses a held quote as is once the market is closed', () => {
    // After-hours, so the quote hook reads it stale: the market gate decides.
    renderLadder({
      spxSpot: 7500,
      quotesFetchedAt: NOW - 3 * 3_600_000,
      marketOpen: false,
      session: 'after-hours',
    });
    const header = screen.getByTestId('level-ladder-header');
    expect(header).toHaveTextContent('spot 7,500.0');
    expect(header).not.toHaveTextContent('GEXBot spot');
  });
});

// ────────────────────────────────────────────────────────────
// The closed market
// ────────────────────────────────────────────────────────────

describe('<LevelLadder> after the close', () => {
  it('prints the closed line with the held levels time, and no band or odds', () => {
    answer(
      ready(snapshot({ capturedAt: '2026-11-25T21:01:49.000Z' })),
      ready(expectedMove()),
    );
    renderLadder({ marketOpen: false, session: 'closed' });
    expect(screen.getByTestId('level-ladder-result')).toHaveTextContent(
      'Session closed. Levels as of 15:01 CT.',
    );
    expect(screen.queryByTestId('level-ladder-marker-upper')).toBeNull();
    expect(screen.queryByTestId('level-ladder-marker-lower')).toBeNull();
    expect(within(rowText(7620)).queryByText('CLEAR')).toBeNull();
    expect(rowText(7620)).not.toHaveTextContent('touch');
    // The held levels stay.
    expect(screen.getByText('State major call')).toBeInTheDocument();
  });

  it('prints just "Session closed." with no snapshot held', () => {
    answer(ready(), ready());
    renderLadder({ marketOpen: false, session: 'closed' });
    expect(screen.getByTestId('level-ladder-result').textContent).toBe(
      'Session closed.',
    );
    expect(screen.queryByTestId('level-ladder-levels-line')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// The only new timer
// ────────────────────────────────────────────────────────────

describe('<LevelLadder> clock', () => {
  beforeEach(() => {
    // Every timer, so the 30 s re-check and the quote age can be advanced.
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('ages stalled levels out without a new poll', () => {
    renderLadder({ quotesFetchedAt: NOW });
    expect(screen.getByText('State major call')).toBeInTheDocument();
    expect(screen.queryByTestId('level-ladder-levels-line')).toBeNull();
    // The snapshot is 48 s old at the start and the limit is 240 s: the 30 s
    // re-check that runs 210 s on sees it at 258 s.
    act(() => {
      vi.advanceTimersByTime(210_000);
    });
    expect(screen.getByTestId('level-ladder-levels-line')).toHaveTextContent(
      'GEXBot levels are 4 min old',
    );
    expect(screen.queryByText('State major call')).toBeNull();
  });

  it('ages a quote out to the GEXBot spot as time passes', () => {
    renderLadder({ spxSpot: 7500, quotesFetchedAt: NOW });
    expect(screen.getByTestId('level-ladder-header')).toHaveTextContent(
      'spot 7,500.0',
    );
    act(() => {
      vi.advanceTimersByTime(100_000);
    });
    expect(screen.getByTestId('level-ladder-header')).toHaveTextContent(
      'GEXBot spot 7,588.1',
    );
  });

  it('starts no timer while the market is closed', () => {
    renderLadder({
      marketOpen: false,
      session: 'closed',
      quotesFetchedAt: NOW,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs its timers while the market is open and clears them on unmount', () => {
    const { unmount } = renderLadder();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
