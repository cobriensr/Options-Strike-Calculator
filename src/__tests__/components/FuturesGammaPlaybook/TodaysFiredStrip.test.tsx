/**
 * TodaysFiredStrip tests — presentation + filtering only.
 *
 * The hook is mocked so we can drive each rendering branch (empty,
 * populated, wrong day, wrong type) directly without involving fetch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../../../hooks/useRegimeEventsHistory', () => ({
  useRegimeEventsHistory: vi.fn(),
}));

import { useRegimeEventsHistory } from '../../../hooks/useRegimeEventsHistory';
import { TodaysFiredStrip } from '../../../components/FuturesGammaPlaybook/TodaysFiredStrip';
import type { RegimeEventRow } from '../../../hooks/useRegimeEventsHistory';

// A timestamp of 15:00 UTC on 2026-04-20 lands at 11:00 ET that day
// (EDT is UTC-4 through early November 2026), so the ET calendar date
// matches '2026-04-20' — stable regardless of host TZ.
const SELECTED_DATE = '2026-04-20';
const TODAY_TS_MORNING = '2026-04-20T15:00:00.000Z'; // 11:00 CT
const TODAY_TS_MIDDAY = '2026-04-20T18:30:00.000Z'; // 13:30 CT
const TODAY_TS_AFTERNOON = '2026-04-20T20:15:00.000Z'; // 15:15 CT
// A timestamp on the prior ET calendar day — UTC 2026-04-20T03:00 is
// 23:00 ET on 2026-04-19, so filtering by ET date excludes it.
const PRIOR_DAY_TS = '2026-04-20T03:00:00.000Z';

function row(overrides: Partial<RegimeEventRow> = {}): RegimeEventRow {
  return {
    id: 1,
    ts: TODAY_TS_MIDDAY,
    type: 'TRIGGER_FIRE',
    severity: 'warn',
    title: 'Trigger fired: fade-call-wall',
    body: 'Named setup "fade-call-wall" just became active.',
    deliveredCount: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(useRegimeEventsHistory).mockReset();
});

describe('TodaysFiredStrip: empty state', () => {
  it('renders the empty message when no TRIGGER_FIRE events exist', () => {
    vi.mocked(useRegimeEventsHistory).mockReturnValue({
      events: [],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    render(<TodaysFiredStrip marketOpen={true} selectedDate={SELECTED_DATE} />);
    expect(screen.getByText(/no setups fired today yet/i)).toBeInTheDocument();
  });

  it('renders the empty message when only non-trigger events exist', () => {
    vi.mocked(useRegimeEventsHistory).mockReturnValue({
      events: [
        {
          id: 11,
          ts: TODAY_TS_MIDDAY,
          type: 'REGIME_FLIP',
          severity: 'urgent',
          title: 'Regime flip: POSITIVE → NEGATIVE',
          body: 'Net GEX flipped negative.',
          deliveredCount: 1,
        },
        {
          id: 12,
          ts: TODAY_TS_MIDDAY,
          type: 'LEVEL_BREACH',
          severity: 'urgent',
          title: 'call wall broken at 5830.00',
          body: 'ES 5832.00 has broken through the call wall.',
          deliveredCount: 1,
        },
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    render(<TodaysFiredStrip marketOpen={true} selectedDate={SELECTED_DATE} />);
    expect(screen.getByText(/no setups fired today yet/i)).toBeInTheDocument();
    expect(
      screen.queryByText('Regime flip: POSITIVE → NEGATIVE'),
    ).not.toBeInTheDocument();
  });
});

describe('TodaysFiredStrip: date filtering', () => {
  it('excludes TRIGGER_FIRE events from a different ET calendar day', () => {
    vi.mocked(useRegimeEventsHistory).mockReturnValue({
      events: [
        row({
          id: 21,
          ts: PRIOR_DAY_TS,
          title: 'Trigger fired: charm-drift',
          body: 'Named setup "charm-drift" just became active.',
        }),
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    render(<TodaysFiredStrip marketOpen={true} selectedDate={SELECTED_DATE} />);
    expect(screen.getByText(/no setups fired today yet/i)).toBeInTheDocument();
    expect(screen.queryByText('Charm drift')).not.toBeInTheDocument();
  });
});

describe('TodaysFiredStrip: chronological ordering', () => {
  it('sorts fire events ascending by timestamp regardless of input order', () => {
    vi.mocked(useRegimeEventsHistory).mockReturnValue({
      events: [
        // Hook returns newest first by default — we feed the reverse
        // order to confirm the strip re-sorts chronologically.
        row({
          id: 32,
          ts: TODAY_TS_AFTERNOON,
          title: 'Trigger fired: charm-drift',
          body: 'Named setup "charm-drift" just became active.',
        }),
        row({
          id: 31,
          ts: TODAY_TS_MIDDAY,
          title: 'Trigger fired: fade-call-wall',
          body: 'Named setup "fade-call-wall" just became active.',
        }),
        row({
          id: 30,
          ts: TODAY_TS_MORNING,
          title: 'Trigger fired: lift-put-wall',
          body: 'Named setup "lift-put-wall" just became active.',
        }),
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    render(<TodaysFiredStrip marketOpen={true} selectedDate={SELECTED_DATE} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    // Earliest row first (lift-put-wall at 11:00 CT).
    expect(items[0]).toHaveTextContent('Lift put wall');
    // Latest row last (charm-drift at 15:15 CT).
    expect(items[2]).toHaveTextContent('Charm drift');
  });
});

describe('TodaysFiredStrip: scrub interaction', () => {
  it('calls onScrubTo with the event timestamp when the row button is clicked', () => {
    const onScrubTo = vi.fn();
    vi.mocked(useRegimeEventsHistory).mockReturnValue({
      events: [row({ id: 41, ts: TODAY_TS_MIDDAY })],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    render(
      <TodaysFiredStrip
        marketOpen={true}
        selectedDate={SELECTED_DATE}
        onScrubTo={onScrubTo}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /jump scrubber to/i }));
    expect(onScrubTo).toHaveBeenCalledTimes(1);
    expect(onScrubTo).toHaveBeenCalledWith(TODAY_TS_MIDDAY);
  });

  it('omits the scrub button entirely when onScrubTo is not provided', () => {
    vi.mocked(useRegimeEventsHistory).mockReturnValue({
      events: [row({ id: 51 })],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    render(<TodaysFiredStrip marketOpen={true} selectedDate={SELECTED_DATE} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('TodaysFiredStrip: severity badges', () => {
  it('applies severity-specific class tokens to the badge', () => {
    vi.mocked(useRegimeEventsHistory).mockReturnValue({
      events: [
        row({
          id: 61,
          severity: 'urgent',
          ts: TODAY_TS_MORNING,
          title: 'Trigger fired: break-call-wall',
          body: 'Named setup "break-call-wall" just became active.',
        }),
        row({
          id: 62,
          severity: 'warn',
          ts: TODAY_TS_AFTERNOON,
          title: 'Trigger fired: fade-call-wall',
          body: 'Named setup "fade-call-wall" just became active.',
        }),
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    render(<TodaysFiredStrip marketOpen={true} selectedDate={SELECTED_DATE} />);
    const urgentBadge = screen.getByLabelText('Severity urgent');
    const warnBadge = screen.getByLabelText('Severity warn');
    expect(urgentBadge.className).toContain('rose');
    expect(warnBadge.className).toContain('amber');
  });
});
