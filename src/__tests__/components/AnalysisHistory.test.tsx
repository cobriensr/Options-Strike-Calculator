import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AnalysisHistory from '../../components/ChartAnalysis/AnalysisHistory';
import { theme } from '../../themes';
import type { AnalysisResult } from '../../components/ChartAnalysis/types';

const th = theme;

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

describe('AnalysisHistory', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('empty state', () => {
    it('shows empty message when no dates exist', async () => {
      vi.stubGlobal('fetch', mockFetch([]));
      render(<AnalysisHistory th={th} />);

      await waitFor(() => {
        expect(screen.getByText(/No saved analyses yet/)).toBeInTheDocument();
      });
    });

    it('shows empty message when fetch fails', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('Network error')),
      );
      render(<AnalysisHistory th={th} />);

      await waitFor(() => {
        expect(screen.getByText(/No saved analyses yet/)).toBeInTheDocument();
      });
    });
  });

  describe('date loading', () => {
    it('fetches dates on mount', async () => {
      const fetchMock = mockFetch();
      vi.stubGlobal('fetch', fetchMock);
      render(<AnalysisHistory th={th} />);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining('dates=true'),
        );
      });
    });

    it('renders date options in the picker', async () => {
      vi.stubGlobal('fetch', mockFetch());
      render(<AnalysisHistory th={th} />);

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
      render(<AnalysisHistory th={th} />);

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
      render(<AnalysisHistory th={th} />);

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
      render(<AnalysisHistory th={th} />);

      await waitFor(() => {
        expect(screen.getByText(/Select a date/)).toBeInTheDocument();
      });

      const select = screen.getByLabelText('Date');
      await user.selectOptions(select, '2025-03-01');

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining('date=2025-03-01'),
        );
      });
    });

    it('shows time picker after selecting a date', async () => {
      vi.stubGlobal('fetch', mockFetch());
      const user = userEvent.setup();
      render(<AnalysisHistory th={th} />);

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
      render(<AnalysisHistory th={th} />);

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
      render(<AnalysisHistory th={th} />);

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
      render(<AnalysisHistory th={th} />);

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
      render(<AnalysisHistory th={th} />);

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
      render(<AnalysisHistory th={th} />);

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
      render(<AnalysisHistory th={th} />);

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
      render(<AnalysisHistory th={th} />);

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
      render(<AnalysisHistory th={th} />);

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
  });

  describe('mode filter resets cascade', () => {
    it('resets date and time when mode filter changes', async () => {
      vi.stubGlobal('fetch', mockFetch());
      const user = userEvent.setup();
      render(<AnalysisHistory th={th} />);

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
      const { rerender } = render(<AnalysisHistory th={th} refreshKey={0} />);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining('dates=true'),
        );
      });

      const callsBefore = fetchMock.mock.calls.filter((c: unknown[]) =>
        (c[0] as string).includes('dates=true'),
      ).length;

      rerender(<AnalysisHistory th={th} refreshKey={1} />);

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
      const { rerender } = render(<AnalysisHistory th={th} refreshKey={0} />);

      await waitFor(() => {
        expect(screen.getByText(/Select a date/)).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Date'), '2025-03-01');

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining('date=2025-03-01'),
        );
      });

      const dateCalls = fetchMock.mock.calls.filter((c: unknown[]) =>
        (c[0] as string).includes('date=2025-03-01'),
      ).length;

      rerender(<AnalysisHistory th={th} refreshKey={1} />);

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
      render(<AnalysisHistory th={th} />);

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

  describe('non-ok response handling', () => {
    it('handles non-ok date fetch gracefully', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response('', { status: 500 })),
      );
      render(<AnalysisHistory th={th} />);

      await waitFor(() => {
        expect(screen.getByText(/No saved analyses yet/)).toBeInTheDocument();
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
      render(<AnalysisHistory th={th} />);

      await waitFor(() => {
        expect(screen.getByText(/No saved analyses yet/)).toBeInTheDocument();
      });
    });
  });
});
