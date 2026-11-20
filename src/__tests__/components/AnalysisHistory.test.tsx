import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AnalysisHistory from '../../components/ChartAnalysis/AnalysisHistory';
import type { AnalysisResult } from '../../components/ChartAnalysis/types';
import { captureUnlessAuth } from '../../lib/sentry-helpers';
import type { AccessMode } from '../../utils/auth';

vi.mock('../../lib/sentry-helpers', () => ({ captureUnlessAuth: vi.fn() }));
const mockCaptureUnlessAuth = vi.mocked(captureUnlessAuth);

// The panel reads its access mode at every render, so a test flips it between
// renders. `checkIsOwner` is the one function the component imports.
const access = vi.hoisted(() => ({ mode: 'owner' as AccessMode }));
vi.mock('../../utils/auth', () => ({
  checkIsOwner: () => access.mode === 'owner',
}));

// ── Mock data ──────────────────────────────────────────────

function makeDateEntry(
  date: string,
  counts: { entries?: number; middays?: number; reviews?: number } = {},
) {
  const entries = counts.entries ?? 0;
  const middays = counts.middays ?? 0;
  const reviews = counts.reviews ?? 0;
  return {
    date,
    total: entries + middays + reviews,
    entries,
    middays,
    reviews,
  };
}

function makeAnalysis(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    mode: 'entry',
    structure: 'IRON CONDOR',
    confidence: 'HIGH',
    suggestedDelta: 8,
    reasoning: 'Test reasoning',
    observations: ['obs1'],
    risks: ['risk1'],
    structureRationale: 'Test rationale',
    ...overrides,
  };
}

function makeEntry(
  id: number,
  mode: 'entry' | 'midday' | 'review',
  entryTime: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    entryTime,
    mode,
    structure: 'IRON CONDOR',
    confidence: 'HIGH',
    suggestedDelta: 8,
    spx: 5700,
    vix: 18,
    vix1d: 15,
    hedge: null,
    analysis: makeAnalysis({ mode }),
    createdAt: '2025-03-01T10:00:00Z',
    ...overrides,
  };
}

const DATES = [
  makeDateEntry('2025-03-01', { entries: 2, middays: 1 }),
  makeDateEntry('2025-02-28', { entries: 1, reviews: 1 }),
];

const ANALYSES = [
  makeEntry(1, 'entry', '10:00 AM'),
  makeEntry(2, 'entry', '10:30 AM'),
  makeEntry(3, 'midday', '10:00 AM'),
];

// ── Helpers ────────────────────────────────────────────────

function mockFetch(
  dates: typeof DATES = DATES,
  analyses: typeof ANALYSES = ANALYSES,
) {
  return vi.fn().mockImplementation((url: string) => {
    if (url.includes('dates=true')) {
      return Promise.resolve(
        new Response(JSON.stringify({ dates }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    if (url.includes('date=')) {
      return Promise.resolve(
        new Response(JSON.stringify({ analyses }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
}

// ── Tests ──────────────────────────────────────────────────

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** One entry-mode analysis at 10:00 AM whose structure reads `structure`. */
function analysesFor(structure: string) {
  return [
    makeEntry(1, 'entry', '10:00 AM', {
      structure,
      analysis: makeAnalysis({ structure }),
    }),
  ];
}

/** Let any request a mount or rerender started settle, or not start. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Number of requests the component made for the dates list. */
function datesCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter((c: unknown[]) =>
    (c[0] as string).includes('dates=true'),
  ).length;
}

describe('AnalysisHistory', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockCaptureUnlessAuth.mockClear();
    access.mode = 'owner';
  });

  describe('empty state', () => {
    it('shows empty message when no dates exist', async () => {
      vi.stubGlobal('fetch', mockFetch([]));
      render(<AnalysisHistory />);

      await waitFor(() => {
        expect(screen.getByText(/No analyses saved yet/)).toBeInTheDocument();
      });
    });

    it('shows empty message when fetch fails', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('Network error')),
      );
      render(<AnalysisHistory />);

      await waitFor(() => {
        expect(
          screen.getByText(/Failed to load analysis dates/),
        ).toBeInTheDocument();
      });
    });
  });

  describe('date loading', () => {
    it('fetches dates on mount', async () => {
      const fetchMock = mockFetch();
      vi.stubGlobal('fetch', fetchMock);
      render(<AnalysisHistory />);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining('dates=true'),
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
      });
    });

    it('renders date options in the picker', async () => {
      vi.stubGlobal('fetch', mockFetch());
      render(<AnalysisHistory />);

      await waitFor(() => {
        expect(screen.getByText(/Select a date/)).toBeInTheDocument();
      });

      const select = screen.getByLabelText('Date');
      const options = within(select).getAllByRole('option');
      // placeholder + 2 dates
      expect(options).toHaveLength(3);
    });
  });

  describe('mode filter tabs', () => {
    it('renders all four filter tabs', async () => {
      vi.stubGlobal('fetch', mockFetch());
      render(<AnalysisHistory />);

      await waitFor(() => {
        expect(screen.getByText('All')).toBeInTheDocument();
      });

      expect(screen.getByText('Pre-Trade')).toBeInTheDocument();
      expect(screen.getByText('Mid-Day')).toBeInTheDocument();
      expect(screen.getByText('Review')).toBeInTheDocument();
    });

    it('filters dates by mode when tab is clicked', async () => {
      const dates = [
        makeDateEntry('2025-03-01', { entries: 2 }),
        makeDateEntry('2025-02-28', { reviews: 1 }),
      ];
      vi.stubGlobal('fetch', mockFetch(dates));
      const user = userEvent.setup();
      render(<AnalysisHistory />);

      await waitFor(() => {
        expect(screen.getByText('Review')).toBeInTheDocument();
      });

      // Click Review filter — only date with reviews should show
      await user.click(screen.getByText('Review'));

      const select = screen.getByLabelText('Date');
      const options = within(select).getAllByRole('option');
      // placeholder + 1 date (only 2025-02-28 has reviews)
      expect(options).toHaveLength(2);
    });
  });

  describe('date selection and cascade', () => {
    it('fetches analyses when date is selected', async () => {
      const fetchMock = mockFetch();
      vi.stubGlobal('fetch', fetchMock);
      const user = userEvent.setup();
      render(<AnalysisHistory />);

      await waitFor(() => {
        expect(screen.getByText(/Select a date/)).toBeInTheDocument();
      });

      const select = screen.getByLabelText('Date');
      await user.selectOptions(select, '2025-03-01');

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining('date=2025-03-01'),
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
      });
    });

    it('shows time picker after selecting a date', async () => {
      vi.stubGlobal('fetch', mockFetch());
      const user = userEvent.setup();
      render(<AnalysisHistory />);

      await waitFor(() => {
        expect(screen.getByText(/Select a date/)).toBeInTheDocument();
      });

      const select = screen.getByLabelText('Date');
      await user.selectOptions(select, '2025-03-01');

      await waitFor(() => {
        expect(screen.getByLabelText('Entry Time')).toBeInTheDocument();
      });
    });

    it('auto-selects first available time', async () => {
      vi.stubGlobal('fetch', mockFetch());
      const user = userEvent.setup();
      render(<AnalysisHistory />);

      await waitFor(() => {
        expect(screen.getByText(/Select a date/)).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Date'), '2025-03-01');

      await waitFor(() => {
        const timePicker = screen.getByLabelText('Entry Time');
        expect(timePicker).toHaveValue('10:00 AM');
      });
    });
  });

  describe('mode tabs for selected time', () => {
    it('shows mode tabs when multiple modes available for a time', async () => {
      vi.stubGlobal('fetch', mockFetch());
      const user = userEvent.setup();
      render(<AnalysisHistory />);

      await waitFor(() => {
        expect(screen.getByText(/Select a date/)).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Date'), '2025-03-01');

      // 10:00 AM has both entry and midday — mode tabs should show
      await waitFor(() => {
        const fieldset = screen.getByRole('group');
        expect(within(fieldset).getByText('Pre-Trade')).toBeInTheDocument();
        expect(within(fieldset).getByText('Mid-Day')).toBeInTheDocument();
      });
    });

    it('switches analysis when mode tab is clicked', async () => {
      const analyses = [
        makeEntry(1, 'entry', '10:00 AM'),
        makeEntry(3, 'midday', '10:00 AM', {
          structure: 'PUT CREDIT SPREAD',
          analysis: makeAnalysis({
            mode: 'midday',
            structure: 'PUT CREDIT SPREAD',
          }),
        }),
      ];
      vi.stubGlobal('fetch', mockFetch(DATES, analyses));
      const user = userEvent.setup();
      render(<AnalysisHistory />);

      await waitFor(() => {
        expect(screen.getByText(/Select a date/)).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Date'), '2025-03-01');

      // Auto-selects entry mode — should show IRON CONDOR
      await waitFor(() => {
        expect(screen.getByRole('group')).toBeInTheDocument();
        expect(
          screen.getAllByText('IRON CONDOR').length,
        ).toBeGreaterThanOrEqual(1);
      });

      // Click Mid-Day tab in the fieldset
      const fieldset = screen.getByRole('group');
      await user.click(within(fieldset).getByText('Mid-Day'));

      // Summary bar should now show PUT CREDIT SPREAD
      await waitFor(() => {
        expect(
          screen.getAllByText('PUT CREDIT SPREAD').length,
        ).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe('summary bar', () => {
    it('shows structure and confidence in summary', async () => {
      vi.stubGlobal('fetch', mockFetch());
      const user = userEvent.setup();
      render(<AnalysisHistory />);

      await waitFor(() => {
        expect(screen.getByText(/Select a date/)).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Date'), '2025-03-01');

      await waitFor(() => {
        // May appear in both summary bar and results view
        expect(
          screen.getAllByText('IRON CONDOR').length,
        ).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('HIGH').length).toBeGreaterThanOrEqual(1);
      });
    });

    it('shows SPX and VIX values when available', async () => {
      vi.stubGlobal('fetch', mockFetch());
      const user = userEvent.setup();
      render(<AnalysisHistory />);

      await waitFor(() => {
        expect(screen.getByText(/Select a date/)).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Date'), '2025-03-01');

      await waitFor(() => {
        expect(screen.getByText('SPX 5700')).toBeInTheDocument();
        expect(screen.getByText('VIX 18.0')).toBeInTheDocument();
      });
    });
  });

  describe('loading state', () => {
    it('shows loading indicator while fetching analyses', async () => {
      let resolveAnalyses: (v: Response) => void;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('dates=true')) {
          return Promise.resolve(
            new Response(JSON.stringify({ dates: DATES }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        }
        // Delay analyses response
        return new Promise<Response>((resolve) => {
          resolveAnalyses = resolve;
        });
      });
      vi.stubGlobal('fetch', fetchMock);
      const user = userEvent.setup();
      render(<AnalysisHistory />);

      await waitFor(() => {
        expect(screen.getByText(/Select a date/)).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Date'), '2025-03-01');

      expect(screen.getByText('Loading...')).toBeInTheDocument();

      // Resolve the analyses fetch
      resolveAnalyses!(
        new Response(JSON.stringify({ analyses: ANALYSES }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
      });
    });
  });

  describe('empty analyses for date', () => {
    it('shows empty message when no analyses match filter', async () => {
      vi.stubGlobal('fetch', mockFetch(DATES, []));
      const user = userEvent.setup();
      render(<AnalysisHistory />);

      await waitFor(() => {
        expect(screen.getByText(/Select a date/)).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Date'), '2025-03-01');

      await waitFor(() => {
        expect(
          screen.getByText(/No.*analyses found for this date/),
        ).toBeInTheDocument();
      });
    });
  });

  describe('time sorting', () => {
    it('sorts times chronologically (AM before PM)', async () => {
      const analyses = [
        makeEntry(1, 'entry', '2:00 PM'),
        makeEntry(2, 'entry', '9:30 AM'),
        makeEntry(3, 'entry', '12:00 PM'),
      ];
      vi.stubGlobal('fetch', mockFetch(DATES, analyses));
      const user = userEvent.setup();
      render(<AnalysisHistory />);

      await waitFor(() => {
        expect(screen.getByText(/Select a date/)).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Date'), '2025-03-01');

      await waitFor(() => {
        expect(screen.getByLabelText('Entry Time')).toBeInTheDocument();
      });

      const timePicker = screen.getByLabelText('Entry Time');
      const options = within(timePicker).getAllByRole('option');
      expect(options[0]).toHaveTextContent('9:30 AM');
      expect(options[1]).toHaveTextContent('12:00 PM');
      expect(options[2]).toHaveTextContent('2:00 PM');
    });

    it('orders mixed CT and ET labels by the moment they name', async () => {
      // 10:30 AM ET is 9:30 AM CT, ahead of 9:45 AM CT; 3:30 PM ET is
      // 2:30 PM CT, after 2:00 PM CT. Sorted as bare clock times, 9:45 AM
      // CT would come first.
      const analyses = [
        makeEntry(1, 'entry', '3:30 PM ET'),
        makeEntry(2, 'entry', '2:00 PM CT'),
        makeEntry(3, 'entry', '9:45 AM CT'),
        makeEntry(4, 'entry', '10:30 AM ET'),
      ];
      vi.stubGlobal('fetch', mockFetch(DATES, analyses));
      const user = userEvent.setup();
      render(<AnalysisHistory />);

      await waitFor(() => {
        expect(screen.getByText(/Select a date/)).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Date'), '2025-03-01');

      await waitFor(() => {
        expect(screen.getByLabelText('Entry Time')).toBeInTheDocument();
      });

      const options = within(screen.getByLabelText('Entry Time')).getAllByRole(
        'option',
      );
      expect(options.map((o) => o.textContent)).toEqual([
        '10:30 AM ET',
        '9:45 AM CT',
        '2:00 PM CT',
        '3:30 PM ET',
      ]);
    });

    it('lists a label that is not a clock time ahead of the others', async () => {
      // db-analyses.ts saves 'unknown' when the context has no entryTime.
      const analyses = [
        makeEntry(1, 'entry', '9:30 AM CT'),
        makeEntry(2, 'entry', 'unknown'),
      ];
      vi.stubGlobal('fetch', mockFetch(DATES, analyses));
      const user = userEvent.setup();
      render(<AnalysisHistory />);

      await waitFor(() => {
        expect(screen.getByText(/Select a date/)).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Date'), '2025-03-01');

      await waitFor(() => {
        expect(screen.getByLabelText('Entry Time')).toBeInTheDocument();
      });

      const options = within(screen.getByLabelText('Entry Time')).getAllByRole(
        'option',
      );
      expect(options.map((o) => o.textContent)).toEqual([
        'unknown',
        '9:30 AM CT',
      ]);
    });
  });

  describe('mode filter resets cascade', () => {
    it('resets date and time when mode filter changes', async () => {
      vi.stubGlobal('fetch', mockFetch());
      const user = userEvent.setup();
      render(<AnalysisHistory />);

      await waitFor(() => {
        expect(screen.getByText(/Select a date/)).toBeInTheDocument();
      });

      // Select a date
      await user.selectOptions(screen.getByLabelText('Date'), '2025-03-01');

      await waitFor(() => {
        expect(screen.getByLabelText('Entry Time')).toBeInTheDocument();
      });

      // Change mode filter — should reset date selection
      await user.click(screen.getByText('Review'));

      // Date picker should be reset to placeholder
      expect(screen.getByLabelText('Date')).toHaveValue('');
      // Time picker should not be visible
      expect(screen.queryByLabelText('Entry Time')).not.toBeInTheDocument();
    });
  });

  describe('refreshKey triggers refetch', () => {
    it('refetches dates when refreshKey changes', async () => {
      const fetchMock = mockFetch();
      vi.stubGlobal('fetch', fetchMock);
      const { rerender } = render(<AnalysisHistory refreshKey={0} />);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining('dates=true'),
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
      });

      const callsBefore = fetchMock.mock.calls.filter((c: unknown[]) =>
        (c[0] as string).includes('dates=true'),
      ).length;

      rerender(<AnalysisHistory refreshKey={1} />);

      await waitFor(() => {
        const callsAfter = fetchMock.mock.calls.filter((c: unknown[]) =>
          (c[0] as string).includes('dates=true'),
        ).length;
        expect(callsAfter).toBe(callsBefore + 1);
      });
    });

    it('refetches analyses for selected date when refreshKey changes', async () => {
      const fetchMock = mockFetch();
      vi.stubGlobal('fetch', fetchMock);
      const user = userEvent.setup();
      const { rerender } = render(<AnalysisHistory refreshKey={0} />);

      await waitFor(() => {
        expect(screen.getByText(/Select a date/)).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Date'), '2025-03-01');

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining('date=2025-03-01'),
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
      });

      const dateCalls = fetchMock.mock.calls.filter((c: unknown[]) =>
        (c[0] as string).includes('date=2025-03-01'),
      ).length;

      rerender(<AnalysisHistory refreshKey={1} />);

      await waitFor(() => {
        const newDateCalls = fetchMock.mock.calls.filter((c: unknown[]) =>
          (c[0] as string).includes('date=2025-03-01'),
        ).length;
        expect(newDateCalls).toBe(dateCalls + 1);
      });
    });
  });

  describe('review mode color', () => {
    it('shows review mode tab with correct styling', async () => {
      const analyses = [makeEntry(1, 'review', '10:00 AM')];
      vi.stubGlobal('fetch', mockFetch(DATES, analyses));
      const user = userEvent.setup();
      render(<AnalysisHistory />);

      await waitFor(() => {
        expect(screen.getByText(/Select a date/)).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Date'), '2025-03-01');

      await waitFor(() => {
        // Review mode should be auto-selected (only mode available)
        expect(screen.getByLabelText('Entry Time')).toBeInTheDocument();
      });
    });
  });

  describe('time picker change resets mode', () => {
    it('resets selectedMode when a different time is picked', async () => {
      // Two times, each with entry + midday so mode tabs appear
      const analyses = [
        makeEntry(1, 'entry', '9:30 AM'),
        makeEntry(2, 'midday', '9:30 AM', {
          structure: 'PUT CREDIT SPREAD',
          analysis: makeAnalysis({
            mode: 'midday',
            structure: 'PUT CREDIT SPREAD',
          }),
        }),
        makeEntry(3, 'entry', '11:00 AM'),
        makeEntry(4, 'midday', '11:00 AM', {
          structure: 'CALL CREDIT SPREAD',
          analysis: makeAnalysis({
            mode: 'midday',
            structure: 'CALL CREDIT SPREAD',
          }),
        }),
      ];
      vi.stubGlobal('fetch', mockFetch(DATES, analyses));
      const user = userEvent.setup();
      render(<AnalysisHistory />);

      await waitFor(() => {
        expect(screen.getByText(/Select a date/)).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Date'), '2025-03-01');

      // Wait for time picker and auto-selection of 9:30 AM
      await waitFor(() => {
        expect(screen.getByLabelText('Entry Time')).toHaveValue('9:30 AM');
      });

      // Auto-selected mode should be 'entry' (preferred order)
      // Mode tabs should be visible (entry + midday at 9:30 AM)
      await waitFor(() => {
        expect(screen.getByRole('group')).toBeInTheDocument();
      });

      // Click Mid-Day tab to switch mode
      const fieldset = screen.getByRole('group');
      await user.click(within(fieldset).getByText('Mid-Day'));

      // Verify we're showing the midday analysis
      await waitFor(() => {
        expect(
          screen.getAllByText('PUT CREDIT SPREAD').length,
        ).toBeGreaterThanOrEqual(1);
      });

      // Now change the time picker to 11:00 AM — this should reset selectedMode
      await user.selectOptions(screen.getByLabelText('Entry Time'), '11:00 AM');

      // After time change, mode resets and auto-selects entry (preferred)
      // The entry analysis at 11:00 AM has structure IRON CONDOR (default)
      await waitFor(() => {
        expect(
          screen.getAllByText('IRON CONDOR').length,
        ).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe('formatDateLabel error fallback', () => {
    it('falls back to raw string when toLocaleDateString throws', async () => {
      // Force the try block to throw by making toLocaleDateString throw
      const origToLocaleDateString = Date.prototype.toLocaleDateString;
      vi.spyOn(Date.prototype, 'toLocaleDateString').mockImplementation(
        function (this: Date, ...args) {
          // Only throw for the invalid date, let valid dates pass through
          if (Number.isNaN(this.getTime())) {
            throw new RangeError('Invalid time value');
          }
          return origToLocaleDateString.apply(this, args);
        },
      );

      const malformedDates = [makeDateEntry('not-a-real-date', { entries: 1 })];
      vi.stubGlobal('fetch', mockFetch(malformedDates));
      render(<AnalysisHistory />);

      await waitFor(() => {
        const select = screen.getByLabelText('Date');
        const options = within(select).getAllByRole('option');
        // placeholder + 1 date
        expect(options).toHaveLength(2);
        // The catch handler returns the raw string
        expect(options[1]).toHaveTextContent('not-a-real-date');
      });
    });

    it('renders valid dates normally when formatDateLabel succeeds', async () => {
      const validDates = [makeDateEntry('2025-03-15', { entries: 2 })];
      vi.stubGlobal('fetch', mockFetch(validDates));
      render(<AnalysisHistory />);

      await waitFor(() => {
        const select = screen.getByLabelText('Date');
        const options = within(select).getAllByRole('option');
        expect(options).toHaveLength(2); // placeholder + 1 date
        // Valid date should be formatted nicely
        expect(options[1]).toHaveTextContent('Sat, Mar 15, 2025');
      });
    });
  });

  describe('non-ok response handling', () => {
    it('handles non-ok date fetch gracefully', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response('', { status: 500 })),
      );
      render(<AnalysisHistory />);

      await waitFor(() => {
        expect(
          screen.getByText(/Failed to load analysis dates/),
        ).toBeInTheDocument();
      });
    });

    it('handles non-JSON date response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response('<!DOCTYPE html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
        ),
      );
      render(<AnalysisHistory />);

      await waitFor(() => {
        expect(
          screen.getByText(/Failed to load analysis dates/),
        ).toBeInTheDocument();
      });
    });
  });

  // /api/analyses is owner-or-guest, but the panel is owner-only: it renders
  // nothing for a guest. Before the gate, the effects ran ahead of the
  // component's own `return null`, so a guest fetched a list nothing showed
  // and a public visitor drew a 401 per page load.
  describe.each(['guest', 'public'] as const)('%s visitor', (mode) => {
    beforeEach(() => {
      access.mode = mode;
    });

    it('renders nothing and makes no request on mount', async () => {
      const fetchMock = mockFetch();
      vi.stubGlobal('fetch', fetchMock);

      const { container } = render(<AnalysisHistory />);
      await flush();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(container).toBeEmptyDOMElement();
    });

    it('makes no request after a refreshKey change either', async () => {
      const fetchMock = mockFetch();
      vi.stubGlobal('fetch', fetchMock);

      const { container, rerender } = render(
        <AnalysisHistory refreshKey={0} />,
      );
      rerender(<AnalysisHistory refreshKey={1} />);
      rerender(<AnalysisHistory refreshKey={2} />);
      await flush();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(container).toBeEmptyDOMElement();
    });
  });

  describe('access mode changes without a reload', () => {
    it('fetches the dates once when a public visitor becomes the owner', async () => {
      access.mode = 'public';
      const fetchMock = mockFetch();
      vi.stubGlobal('fetch', fetchMock);
      const { container, rerender } = render(<AnalysisHistory />);
      await flush();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(container).toBeEmptyDOMElement();

      access.mode = 'owner';
      rerender(<AnalysisHistory />);

      await waitFor(() => {
        expect(screen.getByText(/Select a date/)).toBeInTheDocument();
      });
      // A plain re-render as the owner doesn't fetch again.
      rerender(<AnalysisHistory />);
      await flush();
      expect(datesCalls(fetchMock)).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('aborts the dates request in flight when the owner drops to guest, and keeps nothing from its late reply', async () => {
      const calls: {
        signal: AbortSignal | undefined;
        reply: (res: Response) => void;
      }[] = [];
      // Ignores the abort, as a reply already on the wire would: only the
      // component's own guard stands between this reply and its state.
      const fetchMock = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((resolve) => {
            calls.push({ signal: init?.signal ?? undefined, reply: resolve });
          }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const { container, rerender } = render(<AnalysisHistory />);
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(calls[0]?.signal?.aborted).toBe(false);

      access.mode = 'guest';
      rerender(<AnalysisHistory />);
      expect(calls[0]?.signal?.aborted).toBe(true);
      expect(container).toBeEmptyDOMElement();

      await act(async () => {
        calls[0]?.reply(
          new Response(JSON.stringify({ dates: DATES }), { status: 200 }),
        );
        await Promise.resolve();
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(container).toBeEmptyDOMElement();

      // Signing back in asks again, and the answer that was dropped must not
      // be what the owner sees while it waits: the empty state, not the list.
      access.mode = 'owner';
      rerender(<AnalysisHistory />);
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(screen.getByText(/No analyses saved yet/)).toBeInTheDocument();
      expect(screen.queryByText(/Select a date/)).not.toBeInTheDocument();
    });

    it('drops the dates an owner session held when it drops to guest', async () => {
      const fetchMock = mockFetch();
      vi.stubGlobal('fetch', fetchMock);
      const user = userEvent.setup();
      const { container, rerender } = render(<AnalysisHistory />);
      await waitFor(() => {
        expect(screen.getByText(/Select a date/)).toBeInTheDocument();
      });
      await user.selectOptions(screen.getByLabelText('Date'), '2025-03-01');
      await waitFor(() => {
        expect(screen.getByLabelText('Entry Time')).toBeInTheDocument();
      });

      access.mode = 'guest';
      rerender(<AnalysisHistory />);
      expect(container).toBeEmptyDOMElement();

      // The second dates request never settles, so only held state could put
      // the list on screen.
      fetchMock.mockImplementation((url: string) =>
        url.includes('dates=true')
          ? new Promise<Response>(() => {})
          : Promise.resolve(
              new Response(JSON.stringify({ analyses: ANALYSES }), {
                status: 200,
              }),
            ),
      );
      access.mode = 'owner';
      rerender(<AnalysisHistory />);
      await flush();

      expect(screen.getByText(/No analyses saved yet/)).toBeInTheDocument();
      expect(screen.queryByLabelText('Date')).not.toBeInTheDocument();
    });

    it('drops a dates error an owner session held when it drops to guest', async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error('Network error'));
      vi.stubGlobal('fetch', fetchMock);
      const { container, rerender } = render(<AnalysisHistory />);
      await waitFor(() => {
        expect(
          screen.getByText(/Failed to load analysis dates/),
        ).toBeInTheDocument();
      });

      access.mode = 'guest';
      rerender(<AnalysisHistory />);
      expect(container).toBeEmptyDOMElement();

      fetchMock.mockReturnValue(new Promise<Response>(() => {}));
      access.mode = 'owner';
      rerender(<AnalysisHistory />);
      await flush();

      expect(
        screen.queryByText(/Failed to load analysis dates/),
      ).not.toBeInTheDocument();
      expect(screen.getByText(/No analyses saved yet/)).toBeInTheDocument();
    });

    // No refreshKey bump anywhere in this one, so the only thing that can
    // abort the picked date's request at the drop, and refetch it on sign-in,
    // is `isOwner` in that effect's deps.
    it('aborts the picked date request when the owner drops to guest, keeps nothing from its late reply, and fetches it once on sign-in', async () => {
      const dateCalls: {
        signal: AbortSignal | undefined;
        reply: (res: Response) => void;
      }[] = [];
      // Ignores the abort, as a reply already on the wire would.
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url.includes('dates=true')) {
          return Promise.resolve(jsonResponse({ dates: DATES }));
        }
        return new Promise<Response>((resolve) => {
          dateCalls.push({ signal: init?.signal ?? undefined, reply: resolve });
        });
      });
      vi.stubGlobal('fetch', fetchMock);
      const user = userEvent.setup();
      const { container, rerender } = render(<AnalysisHistory />);
      await waitFor(() => {
        expect(screen.getByText(/Select a date/)).toBeInTheDocument();
      });
      await user.selectOptions(screen.getByLabelText('Date'), '2025-03-01');
      await waitFor(() => {
        expect(dateCalls).toHaveLength(1);
      });
      expect(dateCalls[0]?.signal?.aborted).toBe(false);

      access.mode = 'guest';
      rerender(<AnalysisHistory />);
      expect(dateCalls[0]?.signal?.aborted).toBe(true);
      expect(container).toBeEmptyDOMElement();

      await act(async () => {
        dateCalls[0]?.reply(
          jsonResponse({ analyses: analysesFor('FIRST DATE CONDOR') }),
        );
        await Promise.resolve();
      });
      expect(dateCalls).toHaveLength(1);

      access.mode = 'owner';
      rerender(<AnalysisHistory />);
      await waitFor(() => {
        expect(dateCalls).toHaveLength(2);
      });
      // The reply the drop discarded is not what the owner sees while the
      // new request waits, or after it.
      expect(screen.getByLabelText('Date')).toHaveValue('2025-03-01');
      expect(screen.queryByText('FIRST DATE CONDOR')).not.toBeInTheDocument();
      await act(async () => {
        dateCalls[1]?.reply(
          jsonResponse({ analyses: analysesFor('SECOND REPLY CONDOR') }),
        );
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(
          screen.getAllByText('SECOND REPLY CONDOR').length,
        ).toBeGreaterThan(0);
      });
      expect(screen.queryByText('FIRST DATE CONDOR')).not.toBeInTheDocument();
      expect(dateCalls).toHaveLength(2);
    });

    it('makes no analyses request for the picked date once the owner has dropped to guest', async () => {
      const fetchMock = mockFetch();
      vi.stubGlobal('fetch', fetchMock);
      const user = userEvent.setup();
      const { container, rerender } = render(
        <AnalysisHistory refreshKey={0} />,
      );
      await waitFor(() => {
        expect(screen.getByText(/Select a date/)).toBeInTheDocument();
      });
      await user.selectOptions(screen.getByLabelText('Date'), '2025-03-01');
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining('date=2025-03-01'),
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
      });
      const callsAsOwner = fetchMock.mock.calls.length;

      // The picked date is still in state; a refreshKey bump re-runs the
      // effect that fetches for it, and only the owner gate stops it.
      access.mode = 'guest';
      rerender(<AnalysisHistory refreshKey={0} />);
      rerender(<AnalysisHistory refreshKey={1} />);
      await flush();

      expect(fetchMock).toHaveBeenCalledTimes(callsAsOwner);
      expect(container).toBeEmptyDOMElement();
    });
  });

  // A reply for one date that fails (a rejected fetch, a non-ok status, a 2xx
  // whose body isn't JSON) proves nothing about that date: the panel says it
  // failed, not that there is nothing, and shows none of the date picked
  // before it. The error has its own state, apart from the dates list's.
  describe('a failed analyses fetch', () => {
    const FIRST_STRUCTURE = 'FIRST DATE CONDOR';
    const ERROR_TEXT = 'Failed to load analyses for this date';
    const FAILURES = [
      ['a rejected fetch', () => Promise.reject(new Error('Network error'))],
      ['a 500', () => Promise.resolve(new Response('', { status: 500 }))],
      [
        'a 200 whose body is not JSON',
        () =>
          Promise.resolve(
            new Response('<!DOCTYPE html>', {
              status: 200,
              headers: { 'Content-Type': 'text/html' },
            }),
          ),
      ],
    ] as const;

    /** The dates list, plus a reply per date; any other date has none. */
    function fetchByDate(replies: Record<string, () => Promise<Response>>) {
      return vi.fn().mockImplementation((url: string) => {
        if (url.includes('dates=true')) {
          return Promise.resolve(jsonResponse({ dates: DATES }));
        }
        const date = /date=([\d-]+)/.exec(url)?.[1] ?? '';
        return (
          replies[date] ??
          (() => Promise.resolve(jsonResponse({ analyses: [] })))
        )();
      });
    }

    const firstDateOk = () =>
      Promise.resolve(jsonResponse({ analyses: analysesFor(FIRST_STRUCTURE) }));

    async function renderOnFirstDate(
      fetchMock: ReturnType<typeof vi.fn>,
      props: { refreshKey?: number } = {},
    ) {
      vi.stubGlobal('fetch', fetchMock);
      const user = userEvent.setup();
      const rendered = render(<AnalysisHistory {...props} />);
      await waitFor(() => {
        expect(screen.getByText(/Select a date/)).toBeInTheDocument();
      });
      await user.selectOptions(screen.getByLabelText('Date'), '2025-03-01');
      await waitFor(() => {
        expect(screen.getAllByText(FIRST_STRUCTURE).length).toBeGreaterThan(0);
      });
      return { ...rendered, user };
    }

    it.each(FAILURES)(
      'after %s for a second date, shows the error, not the first date or the empty state',
      async (_label, fail) => {
        const { user } = await renderOnFirstDate(
          fetchByDate({ '2025-03-01': firstDateOk, '2025-02-28': fail }),
        );

        await user.selectOptions(screen.getByLabelText('Date'), '2025-02-28');

        await waitFor(() => {
          expect(screen.getByText(ERROR_TEXT)).toBeInTheDocument();
        });
        expect(screen.queryByText(FIRST_STRUCTURE)).not.toBeInTheDocument();
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
        expect(
          screen.queryByText(/No.*analyses found for this date/),
        ).not.toBeInTheDocument();
        // The dates list loaded fine, so its message stays out of it.
        expect(
          screen.queryByText(/Failed to load analysis dates/),
        ).not.toBeInTheDocument();
      },
    );

    it('clears the error when a successful date is picked next', async () => {
      const { user } = await renderOnFirstDate(
        fetchByDate({
          '2025-03-01': firstDateOk,
          '2025-02-28': () =>
            Promise.resolve(new Response('', { status: 500 })),
        }),
      );
      await user.selectOptions(screen.getByLabelText('Date'), '2025-02-28');
      await waitFor(() => {
        expect(screen.getByText(ERROR_TEXT)).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Date'), '2025-03-01');

      await waitFor(() => {
        expect(screen.getAllByText(FIRST_STRUCTURE).length).toBeGreaterThan(0);
      });
      expect(screen.queryByText(ERROR_TEXT)).not.toBeInTheDocument();
    });

    it('clears the error when the date is set back to none', async () => {
      const { user } = await renderOnFirstDate(
        fetchByDate({
          '2025-03-01': firstDateOk,
          '2025-02-28': () => Promise.reject(new Error('Network error')),
        }),
      );
      await user.selectOptions(screen.getByLabelText('Date'), '2025-02-28');
      await waitFor(() => {
        expect(screen.getByText(ERROR_TEXT)).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Date'), '');

      expect(screen.queryByText(ERROR_TEXT)).not.toBeInTheDocument();
      expect(
        screen.queryByText(/No.*analyses found for this date/),
      ).not.toBeInTheDocument();
    });

    it('clears the error when a refreshKey bump starts the next request', async () => {
      let failing = true;
      const fetchMock = fetchByDate({
        '2025-03-01': () =>
          failing
            ? Promise.resolve(new Response('', { status: 500 }))
            : firstDateOk(),
      });
      vi.stubGlobal('fetch', fetchMock);
      const user = userEvent.setup();
      const { rerender } = render(<AnalysisHistory refreshKey={0} />);
      await waitFor(() => {
        expect(screen.getByText(/Select a date/)).toBeInTheDocument();
      });
      await user.selectOptions(screen.getByLabelText('Date'), '2025-03-01');
      await waitFor(() => {
        expect(screen.getByText(ERROR_TEXT)).toBeInTheDocument();
      });

      failing = false;
      rerender(<AnalysisHistory refreshKey={1} />);

      await waitFor(() => {
        expect(screen.getAllByText(FIRST_STRUCTURE).length).toBeGreaterThan(0);
      });
      expect(screen.queryByText(ERROR_TEXT)).not.toBeInTheDocument();
    });

    it('keeps both messages when the dates list and the date both fail, neither overwriting the other', async () => {
      let datesFail = false;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('dates=true')) {
          return datesFail
            ? Promise.resolve(new Response('', { status: 500 }))
            : Promise.resolve(jsonResponse({ dates: DATES }));
        }
        return Promise.resolve(new Response('', { status: 500 }));
      });
      vi.stubGlobal('fetch', fetchMock);
      const user = userEvent.setup();
      const { rerender } = render(<AnalysisHistory refreshKey={0} />);
      await waitFor(() => {
        expect(screen.getByText(/Select a date/)).toBeInTheDocument();
      });
      await user.selectOptions(screen.getByLabelText('Date'), '2025-03-01');
      await waitFor(() => {
        expect(screen.getByText(ERROR_TEXT)).toBeInTheDocument();
      });

      datesFail = true;
      rerender(<AnalysisHistory refreshKey={1} />);

      await waitFor(() => {
        expect(
          screen.getByText(/Failed to load analysis dates/),
        ).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByText(ERROR_TEXT)).toBeInTheDocument();
      });
    });

    // R6: the request a date pick supersedes is aborted, and a reply that
    // still arrives (one already on the wire ignores the abort) is dropped,
    // or it would put the first date's analyses under the second date's error.
    it('drops the late reply of a date the next pick superseded', async () => {
      let replyFirst: (res: Response) => void = () => {};
      let firstSignal: AbortSignal | undefined;
      const fetchMock = vi.fn().mockImplementation((url: string, init) => {
        if (url.includes('dates=true')) {
          return Promise.resolve(jsonResponse({ dates: DATES }));
        }
        if (url.includes('date=2025-03-01')) {
          firstSignal = (init as RequestInit).signal ?? undefined;
          return new Promise<Response>((resolve) => {
            replyFirst = resolve;
          });
        }
        return Promise.resolve(new Response('', { status: 500 }));
      });
      vi.stubGlobal('fetch', fetchMock);
      const user = userEvent.setup();
      render(<AnalysisHistory />);
      await waitFor(() => {
        expect(screen.getByText(/Select a date/)).toBeInTheDocument();
      });
      await user.selectOptions(screen.getByLabelText('Date'), '2025-03-01');
      expect(firstSignal?.aborted).toBe(false);
      await user.selectOptions(screen.getByLabelText('Date'), '2025-02-28');
      await waitFor(() => {
        expect(screen.getByText(ERROR_TEXT)).toBeInTheDocument();
      });
      expect(firstSignal?.aborted).toBe(true);

      await act(async () => {
        replyFirst(jsonResponse({ analyses: analysesFor(FIRST_STRUCTURE) }));
        await Promise.resolve();
      });

      expect(screen.queryByText(FIRST_STRUCTURE)).not.toBeInTheDocument();
      expect(screen.getByText(ERROR_TEXT)).toBeInTheDocument();
    });

    // A 2xx whose JSON has the wrong shape is rejected whole, before any of it
    // reaches state, where a wrong type would throw during render. It shows
    // the same message as any other failure, and reaches Sentry by name.
    const MALFORMED_ANALYSES = [
      ['analyses that is a string', { analyses: 'x' }],
      ['no analyses key', {}],
      ['a null body', null],
      ['an entry that is not an object', { analyses: [null] }],
      ['an entry missing its fields', { analyses: [{ id: 1 }] }],
      [
        'an entry with an unknown mode',
        { analyses: [{ ...analysesFor('X')[0], mode: 'weekly' }] },
      ],
      [
        'an analysis whose observations are a string',
        {
          analyses: [
            {
              ...analysesFor('X')[0],
              analysis: { ...analysesFor('X')[0]!.analysis, observations: 'x' },
            },
          ],
        },
      ],
    ] as const;

    it.each(MALFORMED_ANALYSES)(
      'after a 200 with %s for a second date, shows the error and reports it, keeping nothing',
      async (_label, body) => {
        const { user } = await renderOnFirstDate(
          fetchByDate({
            '2025-03-01': firstDateOk,
            '2025-02-28': () => Promise.resolve(jsonResponse(body)),
          }),
        );
        expect(mockCaptureUnlessAuth).not.toHaveBeenCalled();

        await user.selectOptions(screen.getByLabelText('Date'), '2025-02-28');

        await waitFor(() => {
          expect(screen.getByText(ERROR_TEXT)).toBeInTheDocument();
        });
        expect(screen.queryByText(FIRST_STRUCTURE)).not.toBeInTheDocument();
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
        expect(
          screen.queryByText(/No.*analyses found for this date/),
        ).not.toBeInTheDocument();
        expect(mockCaptureUnlessAuth).toHaveBeenCalledTimes(1);
        const [error, options] = mockCaptureUnlessAuth.mock.calls[0]!;
        expect((error as Error).message).toBe(
          'analyses response failed schema validation',
        );
        expect(options).toEqual({
          contexts: {
            analyses: {
              date: '2025-02-28',
              issues: expect.arrayContaining([expect.any(String)]),
              issueCount: expect.any(Number),
            },
          },
        });
      },
    );

    // A stored row that predates a field must still load: the server stores
    // null for the blocks a mode doesn't produce and for a SIT OUT's delta,
    // and the older arrays may be absent.
    it('still shows a SIT OUT row whose blocks are null and whose arrays are absent', async () => {
      const sitOut = {
        ...analysesFor('SIT OUT')[0],
        suggestedDelta: null,
        hedge: null,
        analysis: {
          mode: 'entry',
          structure: 'SIT OUT',
          confidence: 'LOW',
          suggestedDelta: null,
          reasoning: 'No edge today',
          structureRationale: 'Nothing to sell',
          chartConfidence: null,
          strikeGuidance: null,
          managementRules: null,
          entryPlan: null,
          directionalOpportunity: null,
          hedge: null,
          periscopeNotes: null,
          review: null,
        },
      };
      const { user } = await renderOnFirstDate(
        fetchByDate({
          '2025-03-01': firstDateOk,
          '2025-02-28': () =>
            Promise.resolve(jsonResponse({ analyses: [sitOut] })),
        }),
      );

      await user.selectOptions(screen.getByLabelText('Date'), '2025-02-28');

      await waitFor(() => {
        expect(screen.getAllByText('SIT OUT').length).toBeGreaterThan(0);
      });
      expect(screen.queryByText(ERROR_TEXT)).not.toBeInTheDocument();
      expect(mockCaptureUnlessAuth).not.toHaveBeenCalled();
    });

    // The dates reply gets the same treatment, and the list from before it
    // goes with it: nothing the panel shows came from a body it can't trust.
    it.each([
      ['dates that is a string', { dates: 'x' }],
      ['no dates key', {}],
      ['a date entry missing its counts', { dates: [{ date: '2025-03-01' }] }],
      ['a date entry that is null', { dates: [null] }],
    ] as const)(
      'shows the dates error and reports it for a 200 with %s',
      async (_label, body) => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(body)));

        render(<AnalysisHistory />);

        await waitFor(() => {
          expect(
            screen.getByText(/Failed to load analysis dates/),
          ).toBeInTheDocument();
        });
        expect(screen.queryByLabelText('Date')).not.toBeInTheDocument();
        expect(mockCaptureUnlessAuth).toHaveBeenCalledTimes(1);
        const [error, options] = mockCaptureUnlessAuth.mock.calls[0]!;
        expect((error as Error).message).toBe(
          'analyses dates response failed schema validation',
        );
        expect(options).toEqual({
          contexts: {
            analysesDates: {
              issues: expect.arrayContaining([expect.any(String)]),
              issueCount: expect.any(Number),
            },
          },
        });
      },
    );

    it('drops the list a refresh replaces with a malformed dates reply', async () => {
      let malformed = false;
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockImplementation(() =>
            Promise.resolve(
              jsonResponse(malformed ? { dates: 'x' } : { dates: DATES }),
            ),
          ),
      );
      const { rerender } = render(<AnalysisHistory refreshKey={0} />);
      await waitFor(() => {
        expect(screen.getByLabelText('Date')).toBeInTheDocument();
      });

      malformed = true;
      rerender(<AnalysisHistory refreshKey={1} />);

      await waitFor(() => {
        expect(
          screen.getByText(/Failed to load analysis dates/),
        ).toBeInTheDocument();
      });
      expect(screen.queryByLabelText('Date')).not.toBeInTheDocument();
    });

    // The first date's times were auto-selected from analyses that stayed in
    // state while the second date loaded, so a second date with other times
    // opened on a time it doesn't have and showed nothing.
    it('shows a second date whose times differ from the first', async () => {
      const second = [
        makeEntry(5, 'entry', '11:30 AM', {
          structure: 'SECOND DATE CONDOR',
          analysis: makeAnalysis({ structure: 'SECOND DATE CONDOR' }),
        }),
      ];
      const { user } = await renderOnFirstDate(
        fetchByDate({
          '2025-03-01': firstDateOk,
          '2025-02-28': () =>
            Promise.resolve(jsonResponse({ analyses: second })),
        }),
      );

      await user.selectOptions(screen.getByLabelText('Date'), '2025-02-28');

      await waitFor(() => {
        expect(screen.getByLabelText('Entry Time')).toHaveValue('11:30 AM');
      });
      expect(screen.getAllByText('SECOND DATE CONDOR').length).toBeGreaterThan(
        0,
      );
      expect(screen.queryByText(FIRST_STRUCTURE)).not.toBeInTheDocument();
    });
  });

  describe('loading flag', () => {
    it('clears Loading... when a filter change drops the date whose fetch is in flight', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((url: string) =>
          url.includes('dates=true')
            ? Promise.resolve(
                new Response(JSON.stringify({ dates: DATES }), {
                  status: 200,
                }),
              )
            : new Promise<Response>(() => {}),
        ),
      );
      const user = userEvent.setup();
      render(<AnalysisHistory />);
      await waitFor(() => {
        expect(screen.getByText(/Select a date/)).toBeInTheDocument();
      });
      await user.selectOptions(screen.getByLabelText('Date'), '2025-03-01');
      expect(screen.getByText('Loading...')).toBeInTheDocument();

      // The filter change resets the date to none: the cancelled fetch never
      // clears the flag itself, so the effect has to.
      await user.click(screen.getByText('Review'));

      expect(screen.getByLabelText('Date')).toHaveValue('');
      expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
    });
  });
});
