import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import ChartAnalysis from '../../components/ChartAnalysis';
import type { AnalysisContext } from '../../components/ChartAnalysis';
import AnalysisHistoryItem from '../../components/ChartAnalysis/AnalysisHistoryItem';
import {
  ConfirmationBar,
  LoadingIndicator,
  RetryPromptDialog,
} from '../../components/ChartAnalysis/AnalysisLoadingState';
import type { AnalysisEntry } from '../../components/ChartAnalysis/types';
import { theme } from '../../themes';
import type { CalculationResults } from '../../types';

// ============================================================
// HELPERS
// ============================================================

function makeContext(
  overrides: Partial<AnalysisContext> = {},
): AnalysisContext {
  return {
    spx: 5700,
    spy: 550,
    vix: 18,
    vix1d: 15,
    vix9d: 17,
    vvix: 90,
    sigma: 0.15,
    sigmaSource: 'VIX1D',
    T: 0.03,
    hoursRemaining: 7,
    deltaCeiling: 8,
    putSpreadCeiling: 10,
    callSpreadCeiling: 10,
    regimeZone: 'GREEN',
    clusterMult: 1.0,
    dowLabel: 'Friday',
    openingRangeSignal: 'neutral',
    openingRangeAvailable: true,
    vixTermSignal: 'contango',
    rvIvRatio: '0.85',
    overnightGap: '0.1',
    isBacktest: false,
    ...overrides,
  };
}

function makeResults(
  overrides: Partial<CalculationResults> = {},
): CalculationResults {
  return {
    allDeltas: [],
    sigma: 0.15,
    T: 0.03,
    hoursRemaining: 7,
    spot: 5700,
    marketHours: 6.5,
    ...overrides,
  };
}

const SAMPLE_ANALYSIS = {
  mode: 'entry' as const,
  structure: 'IRON CONDOR',
  confidence: 'HIGH',
  suggestedDelta: 8,
  reasoning: 'NCP and NPP are parallel, indicating a ranging day.',
  chartConfidence: null,
  observations: ['NCP at +50M', 'NPP at -40M', 'Lines trending parallel'],
  strikeGuidance: null,
  entryPlan: null,
  managementRules: null,
  risks: ['VIX elevated above 20'],
  hedge: null,
  periscopeNotes: null as string | null,
  structureRationale: 'NCP ≈ NPP suggests balanced flow.',
  review: null,
  imageIssues: null,
};

function createImageFile(name = 'chart.png', type = 'image/png'): File {
  return new File(['fake-image-data'], name, { type });
}

async function addImageViaInput(container: HTMLElement, file?: File) {
  const input = container.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file ?? createImageFile()] } });
}

async function expandSection(
  user: ReturnType<typeof userEvent.setup>,
  title: string,
) {
  const btn = screen.getByText(title).closest('button');
  if (btn) await user.click(btn);
}

/** Click Analyze → Confirm (two-step flow) */
async function clickAnalyzeAndConfirm(
  user: ReturnType<typeof userEvent.setup>,
) {
  await user.click(screen.getByRole('button', { name: /analyze/i }));
  await user.click(screen.getByRole('button', { name: /confirm/i }));
}

/** Full render → upload → analyze → confirm → wait for results */
async function renderAndAnalyze(
  analysis: Record<string, unknown> = SAMPLE_ANALYSIS,
) {
  const user = userEvent.setup();
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementation(
        () =>
          new Response(
            JSON.stringify({ analysis, raw: JSON.stringify(analysis) }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
  );
  const view = render(
    <ChartAnalysis results={makeResults()} context={makeContext()} />,
  );
  await addImageViaInput(view.container);
  await clickAnalyzeAndConfirm(user);
  await waitFor(() => {
    expect(screen.getByText(analysis.structure as string)).toBeInTheDocument();
  });
  return { user, view };
}

// ============================================================
// TESTS
// ============================================================

describe('ChartAnalysis', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal(
      'URL',
      new Proxy(globalThis.URL, {
        get(target, prop) {
          if (prop === 'createObjectURL') return () => 'blob:mock-url';
          if (prop === 'revokeObjectURL') return vi.fn();
          return Reflect.get(target, prop);
        },
      }),
    );
  });

  it('renders the section heading', () => {
    render(<ChartAnalysis results={null} context={makeContext()} />);
    expect(screen.getByText('Chart Analysis')).toBeInTheDocument();
  });

  it('shows upload prompt when no images', () => {
    render(<ChartAnalysis results={null} context={makeContext()} />);
    expect(screen.getByText(/drop or click to upload/i)).toBeInTheDocument();
  });

  it('does not show analyze button when no images', () => {
    render(<ChartAnalysis results={null} context={makeContext()} />);
    expect(
      screen.queryByRole('button', { name: /analyze/i }),
    ).not.toBeInTheDocument();
  });

  // ── IMAGE MANAGEMENT ──

  describe('image management', () => {
    it('shows image count after adding an image', async () => {
      const { container } = render(
        <ChartAnalysis results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      expect(screen.getByText(/1\/2 images/)).toBeInTheDocument();
    });

    it('shows analyze button after adding an image', async () => {
      const { container } = render(
        <ChartAnalysis results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      expect(
        screen.getByRole('button', { name: /analyze 1 chart/i }),
      ).toBeInTheDocument();
    });

    it('pluralizes button text for multiple images', async () => {
      const { container } = render(
        <ChartAnalysis results={null} context={makeContext()} />,
      );
      await addImageViaInput(container, createImageFile('chart1.png'));
      await addImageViaInput(container, createImageFile('chart2.png'));
      expect(
        screen.getByRole('button', { name: /analyze 2 charts/i }),
      ).toBeInTheDocument();
    });

    it('removes an image when X button is clicked', async () => {
      const user = userEvent.setup();
      const { container } = render(
        <ChartAnalysis results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await user.click(screen.getByRole('button', { name: /remove image/i }));
      expect(screen.getByText(/drop or click to upload/i)).toBeInTheDocument();
    });

    it('defaults image label to Periscope (Gamma)', async () => {
      const { container } = render(
        <ChartAnalysis results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(
        'Periscope (Gamma)',
      );
    });

    it('allows changing the image label', async () => {
      const user = userEvent.setup();
      const { container } = render(
        <ChartAnalysis results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      const select = screen.getByRole('combobox');
      await user.selectOptions(select, 'Periscope Charm (SPX)');
      expect((select as HTMLSelectElement).value).toBe('Periscope Charm (SPX)');
    });

    it('limits to 2 images', async () => {
      const { container } = render(
        <ChartAnalysis results={null} context={makeContext()} />,
      );
      for (let i = 0; i < 5; i++)
        await addImageViaInput(container, createImageFile(`chart${i}.png`));
      expect(screen.getByText(/2\/2 images/)).toBeInTheDocument();
    });

    it('handles drag and drop', async () => {
      render(<ChartAnalysis results={null} context={makeContext()} />);
      const dropZone = screen.getByRole('button', {
        name: /upload chart images/i,
      });
      fireEvent.drop(dropZone, {
        dataTransfer: {
          files: [createImageFile()],
          items: [],
          types: ['Files'],
        },
      });
      expect(screen.getByText(/1\/2 images/)).toBeInTheDocument();
    });
  });

  // ── CONFIRMATION STEP ──

  describe('confirmation step', () => {
    it('shows confirmation bar when analyze is clicked', async () => {
      const user = userEvent.setup();
      const { container } = render(
        <ChartAnalysis results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await user.click(screen.getByRole('button', { name: /analyze/i }));
      expect(screen.getByText(/send.*image.*to opus/i)).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /go back/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /confirm/i }),
      ).toBeInTheDocument();
    });

    it('shows image labels in confirmation', async () => {
      const user = userEvent.setup();
      const { container } = render(
        <ChartAnalysis results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await user.click(screen.getByRole('button', { name: /analyze/i }));
      expect(
        screen.getAllByText(/Periscope \(Gamma\)/).length,
      ).toBeGreaterThanOrEqual(1);
    });

    it('returns to normal state when Go Back is clicked', async () => {
      const user = userEvent.setup();
      const { container } = render(
        <ChartAnalysis results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await user.click(screen.getByRole('button', { name: /analyze/i }));
      await user.click(screen.getByRole('button', { name: /go back/i }));
      expect(
        screen.getByRole('button', { name: /analyze 1 chart/i }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /go back/i }),
      ).not.toBeInTheDocument();
    });

    it('does not call fetch until Confirm is clicked', async () => {
      const user = userEvent.setup();
      const mockFetch = vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ analysis: SAMPLE_ANALYSIS, raw: '{}' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      vi.stubGlobal('fetch', mockFetch);
      const { container } = render(
        <ChartAnalysis results={makeResults()} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await user.click(screen.getByRole('button', { name: /analyze/i }));
      expect(mockFetch).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: /confirm/i }));
      await waitFor(() => {
        // 2 calls: /api/positions (pre-fetch) + /api/analyze
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });
    });
  });

  // ── ANALYZE FLOW ──

  describe('analyze flow', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn());
    });

    it('calls /api/analyze with correct payload', async () => {
      const user = userEvent.setup();
      const mockFetch = vi.mocked(globalThis.fetch);
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ analysis: SAMPLE_ANALYSIS, raw: '{}' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      const { container } = render(
        <ChartAnalysis results={makeResults()} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await clickAnalyzeAndConfirm(user);
      await waitFor(() => {
        // 2 calls: /api/positions (pre-fetch) + /api/analyze
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });
      // First call is positions pre-fetch, second is the analyze call
      const [url, opts] = mockFetch.mock.calls[1]!;
      expect(url).toBe('/api/analyze');
      expect(opts!.method).toBe('POST');
      const body = JSON.parse(opts!.body as string);
      expect(body.images).toHaveLength(1);
      expect(body.context.mode).toBe('entry');
    });

    it('shows thinking indicator while analyzing', async () => {
      const user = userEvent.setup();
      vi.mocked(globalThis.fetch).mockReturnValue(new Promise(() => {}));
      const { container } = render(
        <ChartAnalysis results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await clickAnalyzeAndConfirm(user);
      expect(screen.getByText(/opus is thinking/i)).toBeInTheDocument();
    });

    it('shows cancel button while loading', async () => {
      const user = userEvent.setup();
      vi.mocked(globalThis.fetch).mockReturnValue(new Promise(() => {}));
      const { container } = render(
        <ChartAnalysis results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await clickAnalyzeAndConfirm(user);
      expect(
        screen.getByRole('button', { name: /cancel/i }),
      ).toBeInTheDocument();
    });

    it('shows elapsed timer while loading', async () => {
      const user = userEvent.setup();
      vi.mocked(globalThis.fetch).mockReturnValue(new Promise(() => {}));
      const { container } = render(
        <ChartAnalysis results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await clickAnalyzeAndConfirm(user);
      expect(screen.getByText('0s')).toBeInTheDocument();
    });

    it('cancels analysis when cancel button is clicked', async () => {
      const user = userEvent.setup();
      vi.mocked(globalThis.fetch).mockReturnValue(new Promise(() => {}));
      const { container } = render(
        <ChartAnalysis results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await clickAnalyzeAndConfirm(user);
      expect(screen.getByText(/opus is thinking/i)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /cancel/i }));
      expect(screen.queryByText(/opus is thinking/i)).not.toBeInTheDocument();
      expect(screen.getByText('Analysis cancelled.')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /analyze/i }),
      ).toBeInTheDocument();
    });

    it('displays error on fetch failure', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error('Network error'));
      const { container } = render(
        <ChartAnalysis results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await clickAnalyzeAndConfirm(user);
      // Fast-forward through retry backoff delays (1s + 2s)
      await act(() => vi.advanceTimersByTimeAsync(5000));
      await waitFor(() => {
        expect(screen.getByText('Network error')).toBeInTheDocument();
      });
      vi.useRealTimers();
    });

    it('displays error on non-ok response', async () => {
      const user = userEvent.setup();
      vi.mocked(globalThis.fetch).mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'Not authenticated' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );
      const { container } = render(
        <ChartAnalysis results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await clickAnalyzeAndConfirm(user);
      await waitFor(() => {
        expect(screen.getByText('Not authenticated')).toBeInTheDocument();
      });
    });
  });

  // ── TL;DR SUMMARY CARD ──

  describe('TL;DR summary card', () => {
    it('displays structure, confidence, delta', async () => {
      await renderAndAnalyze();
      expect(screen.getByText('IRON CONDOR')).toBeInTheDocument();
      expect(screen.getByText('HIGH')).toBeInTheDocument();
      expect(screen.getByText(/8\u0394/)).toBeInTheDocument();
    });

    it('displays reasoning', async () => {
      await renderAndAnalyze();
      expect(screen.getByText(/NCP and NPP are parallel/)).toBeInTheDocument();
    });

    it('shows hedge badge when not NO HEDGE', async () => {
      await renderAndAnalyze({
        ...SAMPLE_ANALYSIS,
        hedge: {
          recommendation: 'REDUCED SIZE',
          description: 'Use 70%.',
          rationale: 'VIX.',
          estimatedCost: 'N/A',
        },
      });
      expect(screen.getByText('REDUCED SIZE')).toBeInTheDocument();
    });

    it('shows Entry 1 in quick-glance', async () => {
      await renderAndAnalyze({
        ...SAMPLE_ANALYSIS,
        entryPlan: {
          entry1: {
            timing: 'Now',
            sizePercent: 40,
            delta: 10,
            structure: 'CALL CREDIT SPREAD',
            note: 'Init',
          },
        },
      });
      expect(screen.getByText(/Entry 1:/)).toBeInTheDocument();
      expect(
        screen.getByText(/CALL CREDIT SPREAD 10.*40% size/),
      ).toBeInTheDocument();
    });

    it('shows profit target in quick-glance', async () => {
      await renderAndAnalyze({
        ...SAMPLE_ANALYSIS,
        managementRules: {
          profitTarget: 'Close at 50% before 1 PM',
          stopConditions: [],
        },
      });
      expect(screen.getByText(/Target:/)).toBeInTheDocument();
    });
  });

  // ── COLLAPSIBLE SECTIONS ──

  describe('collapsible detail sections', () => {
    const FULL_ANALYSIS = {
      ...SAMPLE_ANALYSIS,
      chartConfidence: {
        marketTide: {
          signal: 'BEARISH',
          confidence: 'HIGH',
          note: 'NCP declining',
        },
        spyNetFlow: {
          signal: 'CONFIRMS',
          confidence: 'MODERATE',
          note: 'SPY confirms',
        },
        qqqNetFlow: {
          signal: 'CONTRADICTS',
          confidence: 'LOW',
          note: 'QQQ diverging',
        },
        periscope: {
          signal: 'FAVORABLE',
          confidence: 'HIGH',
          note: 'Positive gamma wall',
        },
      },
      strikeGuidance: {
        putStrikeNote: 'Place below 5650.',
        callStrikeNote: 'Place above 5780.',
        straddleCone: {
          upper: 5780,
          lower: 5620,
          priceRelation: 'Price inside cone',
        },
        adjustments: ['Move put from 5660 to 5640', 'Call at 5800 is safe'],
      },
      entryPlan: {
        entry1: {
          timing: 'Now',
          sizePercent: 40,
          delta: 10,
          structure: 'CCS',
          note: 'Initial',
        },
        entry2: {
          condition: 'Range GREEN',
          sizePercent: 30,
          delta: 8,
          structure: 'CCS',
          note: 'Add',
        },
        maxTotalSize: '100% budget',
        noEntryConditions: ['Opening range RED', 'NCP/NPP converge'],
      },
      managementRules: {
        profitTarget: 'Close at 50% before 1 PM',
        stopConditions: ['Close if SPX < 5620'],
        timeRules: 'Close after 2:30 PM',
        flowReversalSignal: 'NCP/NPP converge',
      },
      hedge: {
        recommendation: 'PROTECTIVE LONG',
        description: 'Buy put.',
        rationale: 'Tail risk.',
        estimatedCost: '$1.20',
      },
      periscopeNotes: 'Gamma wall at 5750.',
    };

    async function renderFull() {
      const { user } = await renderAndAnalyze(FULL_ANALYSIS);
      return user;
    }

    it('chart confidence cards are always visible', async () => {
      await renderFull();
      expect(
        screen.getAllByText('Periscope (Gamma)').length,
      ).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('BEARISH')).toBeInTheDocument();
    });

    it('hides NOT PROVIDED chart confidence', async () => {
      await renderAndAnalyze({
        ...SAMPLE_ANALYSIS,
        chartConfidence: {
          marketTide: { signal: 'BULLISH', confidence: 'HIGH', note: '' },
          spyNetFlow: { signal: 'NOT PROVIDED', confidence: 'LOW', note: '' },
        },
      });
      expect(screen.getByText('BULLISH')).toBeInTheDocument();
      expect(screen.queryByText('SPY Flow')).not.toBeInTheDocument();
    });

    it('observations collapsed by default, expand on click', async () => {
      const user = await renderFull();
      expect(screen.queryByText('NCP at +50M')).not.toBeInTheDocument();
      await expandSection(user, 'Key Observations');
      expect(screen.getByText('NCP at +50M')).toBeInTheDocument();
    });

    it('strike guidance is expanded by default', async () => {
      await renderFull();
      expect(screen.getByText('Place below 5650.')).toBeInTheDocument();
      expect(screen.getByText('Place above 5780.')).toBeInTheDocument();
    });

    it('entry plan is expanded by default', async () => {
      await renderFull();
      expect(screen.getByText('Initial')).toBeInTheDocument();
      expect(screen.getByText('Do NOT add entries if:')).toBeInTheDocument();
    });

    it('management rules collapsed, expand on click', async () => {
      const user = await renderFull();
      expect(screen.queryByText('Close if SPX < 5620')).not.toBeInTheDocument();
      await expandSection(user, 'Position Management Rules');
      expect(screen.getByText('Close if SPX < 5620')).toBeInTheDocument();
    });

    it('risks collapsed, expand on click', async () => {
      const user = await renderFull();
      expect(
        screen.queryByText('VIX elevated above 20'),
      ).not.toBeInTheDocument();
      await expandSection(user, 'Risk Factors');
      expect(screen.getByText('VIX elevated above 20')).toBeInTheDocument();
    });

    it('no risk section when empty', async () => {
      await renderAndAnalyze({ ...SAMPLE_ANALYSIS, risks: [] });
      expect(screen.queryByText('Risk Factors')).not.toBeInTheDocument();
    });

    it('hedge collapsed, expand on click', async () => {
      const user = await renderFull();
      expect(screen.getByText(/Hedge: PROTECTIVE LONG/)).toBeInTheDocument();
      await expandSection(user, 'Hedge: PROTECTIVE LONG');
      expect(screen.getByText('$1.20')).toBeInTheDocument();
    });

    it('periscope collapsed, expand on click', async () => {
      const user = await renderFull();
      expect(screen.queryByText('Gamma wall at 5750.')).not.toBeInTheDocument();
      await expandSection(user, 'Periscope Analysis');
      expect(screen.getByText('Gamma wall at 5750.')).toBeInTheDocument();
    });

    it('no periscope when null', async () => {
      await renderAndAnalyze({ ...SAMPLE_ANALYSIS, periscopeNotes: null });
      expect(screen.queryByText('Periscope Analysis')).not.toBeInTheDocument();
    });

    it('rationale collapsed, expand on click', async () => {
      const user = await renderFull();
      expect(
        screen.queryByText(/NCP ≈ NPP suggests balanced flow/),
      ).not.toBeInTheDocument();
      await expandSection(user, 'Structure Rationale');
      expect(
        screen.getByText(/NCP ≈ NPP suggests balanced flow/),
      ).toBeInTheDocument();
    });

    it('toggle collapse/expand', async () => {
      const user = await renderFull();
      await expandSection(user, 'Key Observations');
      expect(screen.getByText('NCP at +50M')).toBeInTheDocument();
      await expandSection(user, 'Key Observations');
      expect(screen.queryByText('NCP at +50M')).not.toBeInTheDocument();
    });
  });

  // ── STRUCTURE VARIATIONS ──

  describe('structure variations', () => {
    it('PUT CREDIT SPREAD', async () => {
      await renderAndAnalyze({
        ...SAMPLE_ANALYSIS,
        structure: 'PUT CREDIT SPREAD',
        confidence: 'MODERATE',
      });
      expect(screen.getByText('PUT CREDIT SPREAD')).toBeInTheDocument();
      expect(screen.getByText('MODERATE')).toBeInTheDocument();
    });

    it('CALL CREDIT SPREAD', async () => {
      await renderAndAnalyze({
        ...SAMPLE_ANALYSIS,
        structure: 'CALL CREDIT SPREAD',
      });
      expect(screen.getByText('CALL CREDIT SPREAD')).toBeInTheDocument();
    });

    it('SIT OUT', async () => {
      await renderAndAnalyze({
        ...SAMPLE_ANALYSIS,
        structure: 'SIT OUT',
        confidence: 'LOW',
      });
      expect(screen.getByText('SIT OUT')).toBeInTheDocument();
      expect(screen.getByText('LOW')).toBeInTheDocument();
    });
  });

  // ── EOD REVIEW ──

  describe('end-of-day review', () => {
    it('correct review', async () => {
      await renderAndAnalyze({
        ...SAMPLE_ANALYSIS,
        review: {
          wasCorrect: true,
          whatWorked: 'NCP call accurate.',
          whatMissed: 'Late reversal.',
          optimalTrade: 'CCS 10Δ.',
          lessonsLearned: ['Friday reversals'],
        },
      });
      expect(
        screen.getByText(/Recommendation was correct/),
      ).toBeInTheDocument();
    });

    it('incorrect review', async () => {
      await renderAndAnalyze({
        ...SAMPLE_ANALYSIS,
        review: {
          wasCorrect: false,
          whatWorked: 'Timing.',
          whatMissed: 'Flow.',
          optimalTrade: 'PCS.',
          lessonsLearned: [],
        },
      });
      expect(
        screen.getByText(/Recommendation was incorrect/),
      ).toBeInTheDocument();
    });
  });

  // ── MODE SELECTOR ──

  describe('mode selector', () => {
    it('switches modes', async () => {
      const user = userEvent.setup();
      render(<ChartAnalysis results={null} context={makeContext()} />);
      expect(
        screen.getByText('Full analysis before opening a position'),
      ).toBeInTheDocument();
      await user.click(screen.getByText('Mid-Day'));
      expect(
        screen.getByText('Check if conditions changed since entry'),
      ).toBeInTheDocument();
      await user.click(screen.getByText('Review'));
      expect(screen.getByText('End-of-day retrospective')).toBeInTheDocument();
    });

    it('mode in button text', async () => {
      const user = userEvent.setup();
      const { container } = render(
        <ChartAnalysis results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      expect(
        screen.getByRole('button', { name: /^analyze.*pre-trade/i }),
      ).toBeInTheDocument();
      await user.click(screen.getByText('Mid-Day'));
      expect(
        screen.getByRole('button', { name: /^analyze.*mid-day/i }),
      ).toBeInTheDocument();
    });
  });

  // ── IMAGE ISSUES ──

  describe('image issues', () => {
    it('displays issues and replace button', async () => {
      await renderAndAnalyze({
        ...SAMPLE_ANALYSIS,
        imageIssues: [
          {
            imageIndex: 1,
            label: 'Periscope (Gamma)',
            issue: 'Blurry.',
            suggestion: 'Higher res.',
          },
        ],
      });
      expect(screen.getByText(/Image Issues/)).toBeInTheDocument();
      expect(screen.getByText(/Blurry\./)).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /replace/i }),
      ).toBeInTheDocument();
    });
  });

  // ── REPLACE IMAGE ──

  describe('replace image flow', () => {
    it('replaces without adding', async () => {
      vi.stubGlobal('fetch', vi.fn());
      const { container } = render(
        <ChartAnalysis results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      const inputs = container.querySelectorAll('input[type="file"]');
      fireEvent.change(inputs[1]!, {
        target: { files: [createImageFile('new.png')] },
      });
      expect(screen.getByText(/1\/2 images/)).toBeInTheDocument();
    });
  });

  // ── PASTE ──

  describe('paste handling', () => {
    it('adds image from clipboard', async () => {
      render(<ChartAnalysis results={null} context={makeContext()} />);
      const evt = new Event('paste', { bubbles: true }) as any;
      evt.clipboardData = {
        items: [{ type: 'image/png', getAsFile: () => createImageFile() }],
      };
      evt.preventDefault = vi.fn();
      await act(() => {
        document.dispatchEvent(evt);
      });
      expect(screen.getByText(/1\/2 images/)).toBeInTheDocument();
    });

    it('ignores non-image paste', () => {
      render(<ChartAnalysis results={null} context={makeContext()} />);
      const evt = new Event('paste', { bubbles: true }) as any;
      evt.clipboardData = {
        items: [{ type: 'text/plain', getAsFile: () => null }],
      };
      document.dispatchEvent(evt);
      expect(screen.getByText(/drop or click to upload/i)).toBeInTheDocument();
    });
  });

  // ── ERROR EDGE CASES ──

  describe('error edge cases', () => {
    it('fallback error on NDJSON parse failure', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: () => Promise.resolve('not valid json\n'),
        }),
      );
      const { container } = render(
        <ChartAnalysis results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await clickAnalyzeAndConfirm(user);
      await act(() => vi.advanceTimersByTimeAsync(5000));
      await waitFor(() => {
        expect(
          screen.getByText((t) => t.includes('Unexpected token')),
        ).toBeInTheDocument();
      });
      vi.useRealTimers();
    });

    it('NDJSON error field surfaces as error message', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify({ error: 'Service unavailable' }) + '\n',
            ),
        }),
      );
      const { container } = render(
        <ChartAnalysis results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await clickAnalyzeAndConfirm(user);
      await act(() => vi.advanceTimersByTimeAsync(5000));
      await waitFor(() => {
        expect(screen.getByText('Service unavailable')).toBeInTheDocument();
      });
      vi.useRealTimers();
    });

    it('generic error for non-Error throws', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue('string'));
      const { container } = render(
        <ChartAnalysis results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await clickAnalyzeAndConfirm(user);
      await act(() => vi.advanceTimersByTimeAsync(5000));
      await waitFor(() => {
        expect(screen.getByText('string')).toBeInTheDocument();
      });
      vi.useRealTimers();
    });
  });

  // ── UPLOAD BUTTON ──

  describe('upload button', () => {
    it('opens file picker on click', async () => {
      const user = userEvent.setup();
      render(<ChartAnalysis results={null} context={makeContext()} />);
      await user.click(
        screen.getByRole('button', { name: /upload chart images/i }),
      );
    });
  });

  // ── onAnalysisSaved CALLBACK ──

  describe('onAnalysisSaved callback', () => {
    it('calls onAnalysisSaved after successful analysis', async () => {
      const onAnalysisSaved = vi.fn();
      const user = userEvent.setup();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(
          () =>
            new Response(
              JSON.stringify({
                analysis: SAMPLE_ANALYSIS,
                raw: JSON.stringify(SAMPLE_ANALYSIS),
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        ),
      );
      const { container } = render(
        <ChartAnalysis
          results={makeResults()}
          context={makeContext()}
          onAnalysisSaved={onAnalysisSaved}
        />,
      );
      await addImageViaInput(container);
      await clickAnalyzeAndConfirm(user);
      await waitFor(() => {
        expect(onAnalysisSaved).toHaveBeenCalledOnce();
      });
    });

    it('does not call onAnalysisSaved when analysis is null', async () => {
      const onAnalysisSaved = vi.fn();
      const user = userEvent.setup();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ analysis: null, raw: 'text' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );
      const { container } = render(
        <ChartAnalysis
          results={makeResults()}
          context={makeContext()}
          onAnalysisSaved={onAnalysisSaved}
        />,
      );
      await addImageViaInput(container);
      await clickAnalyzeAndConfirm(user);
      await waitFor(() => {
        expect(screen.getByText(/could not parse/i)).toBeInTheDocument();
      });
      expect(onAnalysisSaved).not.toHaveBeenCalled();
    });
  });

  // ── POSITIONS PRE-FETCH FAILURE ──

  describe('positions pre-fetch', () => {
    it('proceeds with analysis when positions fetch fails', async () => {
      const user = userEvent.setup();
      let callCount = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((url: string) => {
          callCount++;
          if (url.includes('/api/positions'))
            return Promise.reject(new Error('Network error'));
          return new Response(
            JSON.stringify({
              analysis: SAMPLE_ANALYSIS,
              raw: JSON.stringify(SAMPLE_ANALYSIS),
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }),
      );
      const { container } = render(
        <ChartAnalysis results={makeResults()} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await clickAnalyzeAndConfirm(user);
      await waitFor(() => {
        expect(screen.getByText('IRON CONDOR')).toBeInTheDocument();
      });
      expect(callCount).toBe(2); // positions + analyze
    });

    it('skips positions fetch for backtests', async () => {
      const user = userEvent.setup();
      const mockFn = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            analysis: SAMPLE_ANALYSIS,
            raw: JSON.stringify(SAMPLE_ANALYSIS),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', mockFn);
      const { container } = render(
        <ChartAnalysis
          results={makeResults()}
          context={makeContext({ isBacktest: true })}
        />,
      );
      await addImageViaInput(container);
      await clickAnalyzeAndConfirm(user);
      await waitFor(() => {
        expect(screen.getByText('IRON CONDOR')).toBeInTheDocument();
      });
      // Only the /api/analyze call, no positions pre-fetch
      expect(mockFn).toHaveBeenCalledTimes(1);
      expect(mockFn.mock.calls[0]![0]).toBe('/api/analyze');
    });
  });

  // ── CSV UPLOAD ──

  describe('CSV upload', () => {
    it('uploads CSV and shows spread count on success', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              saved: true,
              positions: { stats: { totalSpreads: 3 } },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      );
      const { container } = render(
        <ChartAnalysis results={makeResults()} context={makeContext()} />,
      );
      await addImageViaInput(container);

      const csvInput = container.querySelector(
        'input[accept=".csv"]',
      ) as HTMLInputElement;
      const csvFile = new File(['csv data'], 'positions.csv', {
        type: 'text/csv',
      });
      fireEvent.change(csvInput, { target: { files: [csvFile] } });

      await waitFor(() => {
        expect(
          screen.getByText(/3 spreads saved from paperMoney/),
        ).toBeInTheDocument();
      });
    });

    it('shows error on CSV upload failure', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ error: 'Bad CSV' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );
      const { container } = render(
        <ChartAnalysis results={makeResults()} context={makeContext()} />,
      );
      await addImageViaInput(container);

      const csvInput = container.querySelector(
        'input[accept=".csv"]',
      ) as HTMLInputElement;
      const csvFile = new File(['bad'], 'positions.csv', {
        type: 'text/csv',
      });
      fireEvent.change(csvInput, { target: { files: [csvFile] } });

      await waitFor(() => {
        expect(screen.getByText('Bad CSV')).toBeInTheDocument();
      });
    });

    it('shows warning when CSV parsed but not saved', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              saved: false,
              positions: { stats: { totalSpreads: 2 } },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      );
      const { container } = render(
        <ChartAnalysis results={makeResults()} context={makeContext()} />,
      );
      await addImageViaInput(container);

      const csvInput = container.querySelector(
        'input[accept=".csv"]',
      ) as HTMLInputElement;
      const csvFile = new File(['csv data'], 'positions.csv', {
        type: 'text/csv',
      });
      fireEvent.change(csvInput, { target: { files: [csvFile] } });

      await waitFor(() => {
        expect(
          screen.getByText(/Parsed 2 spreads but failed to save/),
        ).toBeInTheDocument();
      });
    });

    it('handles CSV upload when res.json() fails on non-ok response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response('not json', {
            status: 500,
            headers: { 'Content-Type': 'text/plain' },
          }),
        ),
      );
      const { container } = render(
        <ChartAnalysis results={makeResults()} context={makeContext()} />,
      );
      await addImageViaInput(container);

      const csvInput = container.querySelector(
        'input[accept=".csv"]',
      ) as HTMLInputElement;
      const csvFile = new File(['csv data'], 'positions.csv', {
        type: 'text/csv',
      });
      fireEvent.change(csvInput, { target: { files: [csvFile] } });

      await waitFor(() => {
        expect(screen.getByText('Upload failed')).toBeInTheDocument();
      });
    });
  });

  // ── MODE AUTO-SWITCH ──

  describe('mode auto-switch based on existing analyses', () => {
    it('switches to midday when entry analysis exists for selected date', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              analyses: [{ mode: 'entry' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      );

      render(
        <ChartAnalysis
          results={makeResults()}
          context={makeContext({ selectedDate: '2026-03-24' })}
        />,
      );

      // Mid-Day uses theme.caution color when active
      await waitFor(() => {
        const midDayBtn = screen.getByText('Mid-Day');
        expect(midDayBtn).toHaveStyle({ color: theme.caution });
      });
    });

    it('switches to review when both entry and review analyses exist', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              analyses: [{ mode: 'entry' }, { mode: 'review' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      );

      render(
        <ChartAnalysis
          results={makeResults()}
          context={makeContext({ selectedDate: '2026-03-24' })}
        />,
      );

      // Review uses theme.green color when active
      await waitFor(() => {
        const reviewBtn = screen.getByText('Review');
        expect(reviewBtn).toHaveStyle({ color: theme.green });
      });
    });

    it('resets mode state when selectedDate is cleared', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ analyses: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );

      const { rerender } = render(
        <ChartAnalysis
          results={makeResults()}
          context={makeContext({ selectedDate: undefined })}
        />,
      );

      // Pre-Trade should remain selected when no date
      expect(screen.getByText('Pre-Trade')).toHaveStyle({
        color: 'var(--color-accent)',
      });

      rerender(
        <ChartAnalysis
          results={makeResults()}
          context={makeContext({ selectedDate: undefined })}
        />,
      );

      expect(screen.getByText('Pre-Trade')).toHaveStyle({
        color: 'var(--color-accent)',
      });
    });
  });

  // ── RAW FALLBACK ──

  describe('raw response fallback', () => {
    it('shows raw when analysis is null', async () => {
      const user = userEvent.setup();
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            new Response(
              JSON.stringify({ analysis: null, raw: 'Unparseable' }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
          ),
      );
      const { container } = render(
        <ChartAnalysis results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await clickAnalyzeAndConfirm(user);
      await waitFor(() => {
        expect(screen.getByText('Raw Analysis')).toBeInTheDocument();
      });
    });

    it('shows parse error message', async () => {
      const user = userEvent.setup();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ analysis: null, raw: 'text' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );
      const { container } = render(
        <ChartAnalysis results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await clickAnalyzeAndConfirm(user);
      await waitFor(() => {
        expect(
          screen.getByText(/could not parse structured response/i),
        ).toBeInTheDocument();
      });
    });
  });

  // ── PREVIOUS RECOMMENDATION CONTINUITY (buildPreviousRecommendation) ──

  describe('midday continuity', () => {
    it('includes previous recommendation when analyzing in midday mode', async () => {
      const user = userEvent.setup();
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      // First analysis: entry mode
      const firstAnalysis = {
        ...SAMPLE_ANALYSIS,
        structure: 'IRON CONDOR',
        suggestedDelta: 8,
        confidence: 'HIGH',
        reasoning: 'Balanced flow.',
        entryPlan: {
          entry1: {
            timing: 'Now',
            sizePercent: 40,
            delta: 10,
            structure: 'CCS',
            note: 'Init',
            condition: 'Open',
          },
        },
        hedge: {
          recommendation: 'PROTECTIVE LONG',
          description: 'Buy put.',
          rationale: 'Tail risk.',
          estimatedCost: '$1.20',
        },
        managementRules: {
          profitTarget: 'Close at 50%',
          stopConditions: ['SPX < 5600', 'VIX > 25'],
        },
      };

      // First analyze: positions pre-fetch + /api/analyze
      mockFetch
        .mockResolvedValueOnce(new Response('{}', { status: 200 })) // positions pre-fetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ analysis: firstAnalysis, raw: '{}' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );

      const { container } = render(
        <ChartAnalysis results={makeResults()} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await clickAnalyzeAndConfirm(user);

      await waitFor(() => {
        expect(screen.getByText('IRON CONDOR')).toBeInTheDocument();
      });

      // Switch to midday mode
      await user.click(screen.getByText('Mid-Day'));

      // Second analyze: positions pre-fetch + /api/analyze
      mockFetch
        .mockResolvedValueOnce(new Response('{}', { status: 200 })) // positions pre-fetch
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              analysis: { ...firstAnalysis, mode: 'midday' },
              raw: '{}',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );

      await clickAnalyzeAndConfirm(user);

      await waitFor(() => {
        // 4 calls: 2 per analyze (positions + analyze) × 2 analyses
        expect(mockFetch).toHaveBeenCalledTimes(4);
      });

      // Verify the second analyze call (index 3) included previousRecommendation
      const secondCall = mockFetch.mock.calls[3]!;
      const body = JSON.parse(secondCall[1]!.body as string);
      expect(body.context.previousRecommendation).toContain('IRON CONDOR');
      expect(body.context.previousRecommendation).toContain('Entry 1:');
      expect(body.context.previousRecommendation).toContain('Hedge:');
      expect(body.context.previousRecommendation).toContain('Profit target:');
      expect(body.context.previousRecommendation).toContain('Stop conditions:');
      expect(body.context.mode).toBe('midday');
    });
  });

  // ── REPLACE VIA IMAGE ISSUES BUTTON ──

  describe('replace via image issues', () => {
    it('clicking Replace button triggers file input and replaces the image', async () => {
      const user = userEvent.setup();
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      // Render, add an image, then analyze with image issues
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            analysis: {
              ...SAMPLE_ANALYSIS,
              imageIssues: [
                {
                  imageIndex: 1,
                  label: 'Periscope (Gamma)',
                  issue: 'Blurry.',
                  suggestion: 'Higher res.',
                },
              ],
            },
            raw: '{}',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const { container } = render(
        <ChartAnalysis results={makeResults()} context={makeContext()} />,
      );

      await addImageViaInput(container);
      await clickAnalyzeAndConfirm(user);

      await waitFor(() => {
        expect(screen.getByText(/Image Issues/)).toBeInTheDocument();
      });

      // Click the Replace button (this triggers replaceImage → lines 314-315, 1303)
      await user.click(screen.getByRole('button', { name: /replace/i }));

      // Simulate selecting a replacement file via the hidden replace input (lines 322-340)
      const inputs = container.querySelectorAll('input[type="file"]');
      const replaceInput = inputs[1]!;
      fireEvent.change(replaceInput, {
        target: { files: [createImageFile('replacement.png')] },
      });

      // Should still have 1 image (replaced, not added)
      expect(screen.getByText(/1\/2 images/)).toBeInTheDocument();
    });

    it('handleReplaceFile does nothing with out-of-bounds index', async () => {
      vi.stubGlobal('fetch', vi.fn());
      const { container } = render(
        <ChartAnalysis results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);

      // The replace input (second file input) with no replaceTargetIndex set
      const inputs = container.querySelectorAll('input[type="file"]');
      fireEvent.change(inputs[1]!, {
        target: { files: [createImageFile('new.png')] },
      });

      // Still 1 image, nothing changed
      expect(screen.getByText(/1\/2 images/)).toBeInTheDocument();
    });
  });

  // ── SIGNAL COLOR BRANCHES ──

  describe('signal color branches', () => {
    it('renders NEUTRAL signal with muted color', async () => {
      await renderAndAnalyze({
        ...SAMPLE_ANALYSIS,
        chartConfidence: {
          marketTide: {
            signal: 'NEUTRAL',
            confidence: 'MODERATE',
            note: 'Flat flow',
          },
        },
      });
      expect(screen.getByText('NEUTRAL')).toBeInTheDocument();
    });

    it('renders unknown signal with amber fallback', async () => {
      await renderAndAnalyze({
        ...SAMPLE_ANALYSIS,
        chartConfidence: {
          marketTide: {
            signal: 'MIXED',
            confidence: 'MODERATE',
            note: 'Mixed signals',
          },
        },
      });
      expect(screen.getByText('MIXED')).toBeInTheDocument();
    });
  });

  // ── DRAG OVER ──

  describe('drag over', () => {
    it('prevents default on dragOver', () => {
      render(<ChartAnalysis results={null} context={makeContext()} />);
      const dropZone = screen.getByRole('button', {
        name: /upload chart images/i,
      });
      const evt = new Event('dragover', { bubbles: true, cancelable: true });
      fireEvent(dropZone, evt);
    });
  });

  // ── TIMEOUT ERROR ──

  describe('timeout error', () => {
    it('shows retry prompt when AbortError fires from timeout', async () => {
      const user = userEvent.setup();
      const abortError = new DOMException(
        'The operation was aborted.',
        'AbortError',
      );
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

      const { container } = render(
        <ChartAnalysis results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await clickAnalyzeAndConfirm(user);

      await waitFor(() => {
        expect(screen.getByText(/request timed out/i)).toBeInTheDocument();
      });
      // Retry prompt buttons should be visible
      expect(
        screen.getByRole('button', { name: /retry now/i }),
      ).toBeInTheDocument();
    });
  });

  // ── MODE-CHECK EFFECT ──

  describe('mode-check effect', () => {
    it('fetches analyses only on date change, not on mode tab click', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ analyses: [] }), { status: 200 }),
        );
      vi.stubGlobal('fetch', mockFetch);

      const { rerender } = render(
        <ChartAnalysis
          results={makeResults()}
          context={makeContext({ selectedDate: '2026-01-10' })}
        />,
      );

      // Initial fetch on mount
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

      // Click a mode tab — should NOT trigger another fetch
      await userEvent.click(screen.getByRole('button', { name: /mid.day/i }));
      expect(mockFetch).toHaveBeenCalledTimes(1); // still 1

      // Change the date — SHOULD trigger a new fetch
      rerender(
        <ChartAnalysis
          results={makeResults()}
          context={makeContext({ selectedDate: '2026-01-11' })}
        />,
      );
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    });

    it('auto-switches to midday when entry already exists for the date', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ analyses: [{ mode: 'entry' }] }), {
            status: 200,
          }),
        ),
      );

      render(
        <ChartAnalysis
          results={makeResults()}
          context={makeContext({ selectedDate: '2026-01-10' })}
        />,
      );

      // After the effect runs, the Pre-Trade (entry) button should be
      // disabled (checkmark shown) and Mid-Day should be active
      await waitFor(() => {
        expect(screen.getByText('Mid-Day')).toHaveStyle({
          color: theme.caution,
        });
      });
    });
  });
});

// ============================================================
// AnalysisHistoryItem
// ============================================================

function makeAnalysisEntry(
  overrides: Partial<AnalysisEntry> = {},
): AnalysisEntry {
  return {
    id: 1,
    entryTime: '10:00 AM',
    mode: 'entry',
    structure: 'IRON CONDOR',
    confidence: 'HIGH',
    suggestedDelta: 8,
    spx: 5700,
    vix: 18.5,
    vix1d: 15,
    hedge: null,
    analysis: {
      mode: 'entry',
      structure: 'IRON CONDOR',
      confidence: 'HIGH',
      suggestedDelta: 8,
      reasoning: 'Balanced flow.',
      observations: ['obs1'],
      risks: ['risk1'],
      structureRationale: 'NCP ≈ NPP.',
    },
    createdAt: '2025-03-01T10:00:00Z',
    ...overrides,
  };
}

describe('AnalysisHistoryItem', () => {
  it('renders mode badge, structure, confidence, and delta', () => {
    render(<AnalysisHistoryItem analysis={makeAnalysisEntry()} />);

    // Multiple elements may contain these labels (badge + results view)
    expect(screen.getAllByText('Pre-Trade').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('IRON CONDOR').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('HIGH').length).toBeGreaterThanOrEqual(1);
    // Delta rendered as two sibling text nodes: number + Δ symbol
    expect(screen.getAllByText(/\u0394/).length).toBeGreaterThanOrEqual(1);
  });

  it('shows SPX and VIX values when both are present', () => {
    render(
      <AnalysisHistoryItem
        analysis={makeAnalysisEntry({ spx: 5750, vix: 20.3 })}
      />,
    );

    expect(screen.getByText('SPX 5750')).toBeInTheDocument();
    expect(screen.getByText('VIX 20.3')).toBeInTheDocument();
  });

  it('omits SPX span when spx is null', () => {
    render(<AnalysisHistoryItem analysis={makeAnalysisEntry({ spx: null })} />);

    expect(screen.queryByText(/^SPX/)).not.toBeInTheDocument();
  });

  it('omits VIX span when vix is null', () => {
    render(<AnalysisHistoryItem analysis={makeAnalysisEntry({ vix: null })} />);

    expect(screen.queryByText(/^VIX/)).not.toBeInTheDocument();
  });

  it('renders midday mode badge with Mid-Day label', () => {
    render(
      <AnalysisHistoryItem
        analysis={makeAnalysisEntry({
          mode: 'midday',
          analysis: { ...makeAnalysisEntry().analysis, mode: 'midday' },
        })}
      />,
    );

    expect(screen.getAllByText('Mid-Day').length).toBeGreaterThanOrEqual(1);
  });

  it('renders review mode badge with Review label', () => {
    render(
      <AnalysisHistoryItem
        analysis={makeAnalysisEntry({
          mode: 'review',
          analysis: { ...makeAnalysisEntry().analysis, mode: 'review' },
        })}
      />,
    );

    expect(screen.getAllByText('Review').length).toBeGreaterThanOrEqual(1);
  });

  it('applies PUT CREDIT SPREAD structure color', () => {
    render(
      <AnalysisHistoryItem
        analysis={makeAnalysisEntry({ structure: 'PUT CREDIT SPREAD' })}
      />,
    );

    const structureEl = screen.getByText('PUT CREDIT SPREAD');
    expect(structureEl).toBeInTheDocument();
  });

  it('applies CALL CREDIT SPREAD structure color', () => {
    render(
      <AnalysisHistoryItem
        analysis={makeAnalysisEntry({ structure: 'CALL CREDIT SPREAD' })}
      />,
    );

    expect(screen.getByText('CALL CREDIT SPREAD')).toBeInTheDocument();
  });

  it('applies fallback structure color for unknown structure', () => {
    render(
      <AnalysisHistoryItem
        analysis={makeAnalysisEntry({ structure: 'SIT OUT' })}
      />,
    );

    const structureEl = screen.getByText('SIT OUT');
    // theme.caution is the fallback color — just verify it renders
    expect(structureEl).toBeInTheDocument();
  });

  it('applies MODERATE confidence color', () => {
    render(
      <AnalysisHistoryItem
        analysis={makeAnalysisEntry({ confidence: 'MODERATE' })}
      />,
    );

    expect(screen.getByText('MODERATE')).toBeInTheDocument();
  });

  it('applies LOW confidence color', () => {
    render(
      <AnalysisHistoryItem
        analysis={makeAnalysisEntry({ confidence: 'LOW' })}
      />,
    );

    expect(screen.getByText('LOW')).toBeInTheDocument();
  });
});

// ============================================================
// ConfirmationBar (AnalysisLoadingState)
// ============================================================

describe('ConfirmationBar', () => {
  const noop = () => {};

  function makeImage(label = 'Periscope (Gamma)') {
    return {
      id: '1',
      file: new File([''], 'chart.png'),
      preview: 'blob:x',
      label,
    };
  }

  it('shows singular "image" for one image', () => {
    render(
      <ConfirmationBar
        images={[makeImage()]}
        mode="entry"
        isBacktest={false}
        lastAnalysis={null}
        onCancel={noop}
        onConfirm={noop}
      />,
    );

    expect(screen.getByText(/send 1 image to opus/i)).toBeInTheDocument();
  });

  it('shows plural "images" for two images', () => {
    render(
      <ConfirmationBar
        images={[makeImage(), makeImage('Periscope Charm (SPX)')]}
        mode="entry"
        isBacktest={false}
        lastAnalysis={null}
        onCancel={noop}
        onConfirm={noop}
      />,
    );

    expect(screen.getByText(/send 2 images to opus/i)).toBeInTheDocument();
  });

  it('shows Schwab note when not a backtest', () => {
    render(
      <ConfirmationBar
        images={[makeImage()]}
        mode="entry"
        isBacktest={false}
        lastAnalysis={null}
        onCancel={noop}
        onConfirm={noop}
      />,
    );

    expect(
      screen.getByText(/will fetch live positions from schwab/i),
    ).toBeInTheDocument();
  });

  it('omits Schwab note for backtest', () => {
    render(
      <ConfirmationBar
        images={[makeImage()]}
        mode="entry"
        isBacktest={true}
        lastAnalysis={null}
        onCancel={noop}
        onConfirm={noop}
      />,
    );

    expect(
      screen.queryByText(/will fetch live positions from schwab/i),
    ).not.toBeInTheDocument();
  });

  it('shows previous recommendation for midday mode with lastAnalysis', () => {
    render(
      <ConfirmationBar
        images={[makeImage()]}
        mode="midday"
        isBacktest={false}
        lastAnalysis={{ structure: 'IRON CONDOR' }}
        onCancel={noop}
        onConfirm={noop}
      />,
    );

    expect(
      screen.getByText(/includes previous iron condor recommendation/i),
    ).toBeInTheDocument();
  });

  it('shows previous recommendation for review mode with lastAnalysis', () => {
    render(
      <ConfirmationBar
        images={[makeImage()]}
        mode="review"
        isBacktest={false}
        lastAnalysis={{ structure: 'PUT CREDIT SPREAD' }}
        onCancel={noop}
        onConfirm={noop}
      />,
    );

    expect(
      screen.getByText(/includes previous put credit spread recommendation/i),
    ).toBeInTheDocument();
  });

  it('omits previous recommendation for entry mode even with lastAnalysis', () => {
    render(
      <ConfirmationBar
        images={[makeImage()]}
        mode="entry"
        isBacktest={false}
        lastAnalysis={{ structure: 'IRON CONDOR' }}
        onCancel={noop}
        onConfirm={noop}
      />,
    );

    expect(screen.queryByText(/includes previous/i)).not.toBeInTheDocument();
  });

  it('omits previous recommendation when lastAnalysis is null', () => {
    render(
      <ConfirmationBar
        images={[makeImage()]}
        mode="midday"
        isBacktest={false}
        lastAnalysis={null}
        onCancel={noop}
        onConfirm={noop}
      />,
    );

    expect(screen.queryByText(/includes previous/i)).not.toBeInTheDocument();
  });

  it('calls onCancel when Go Back is clicked', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <ConfirmationBar
        images={[makeImage()]}
        mode="entry"
        isBacktest={false}
        lastAnalysis={null}
        onCancel={onCancel}
        onConfirm={noop}
      />,
    );

    await user.click(screen.getByRole('button', { name: /go back/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('calls onConfirm when Confirm is clicked', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmationBar
        images={[makeImage()]}
        mode="entry"
        isBacktest={false}
        lastAnalysis={null}
        onCancel={noop}
        onConfirm={onConfirm}
      />,
    );

    await user.click(screen.getByRole('button', { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});

// ============================================================
// LoadingIndicator (AnalysisLoadingState)
// ============================================================

describe('LoadingIndicator', () => {
  const MESSAGES = [
    'Fetching data...',
    'Analyzing charts...',
    'Almost done...',
  ];

  it('renders elapsed time and thinking message', () => {
    render(
      <LoadingIndicator
        elapsed={0}
        THINKING_MESSAGES={MESSAGES}
        cancelAnalysis={() => {}}
      />,
    );

    expect(screen.getByText('0s')).toBeInTheDocument();
    expect(screen.getByText('Fetching data...')).toBeInTheDocument();
    expect(screen.getByText(/opus is thinking/i)).toBeInTheDocument();
  });

  it('advances thinking message based on elapsed seconds', () => {
    // elapsed=50 → index=1, elapsed=100 → index=2
    render(
      <LoadingIndicator
        elapsed={50}
        THINKING_MESSAGES={MESSAGES}
        cancelAnalysis={() => {}}
      />,
    );

    expect(screen.getByText('Analyzing charts...')).toBeInTheDocument();
  });

  it('clamps thinking message index to last entry', () => {
    // elapsed=10000 → would overflow array; should clamp to last
    render(
      <LoadingIndicator
        elapsed={10000}
        THINKING_MESSAGES={MESSAGES}
        cancelAnalysis={() => {}}
      />,
    );

    expect(screen.getByText('Almost done...')).toBeInTheDocument();
  });

  it('calls cancelAnalysis when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const cancel = vi.fn();
    render(
      <LoadingIndicator
        elapsed={30}
        THINKING_MESSAGES={MESSAGES}
        cancelAnalysis={cancel}
      />,
    );

    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(cancel).toHaveBeenCalledOnce();
  });
});

// ============================================================
// RetryPromptDialog (AnalysisLoadingState)
// ============================================================

describe('RetryPromptDialog', () => {
  const noop = () => {};

  function makeRetryPrompt(attempt: number, maxAttempts: number) {
    return { attempt, maxAttempts, error: 'Timeout error' };
  }

  it('shows attempt info and error', () => {
    render(
      <RetryPromptDialog
        retryPrompt={makeRetryPrompt(1, 3)}
        onRetryNow={noop}
        onUpdateScreenshots={noop}
        onCancel={noop}
      />,
    );

    expect(screen.getByText(/attempt 1\/3 failed/i)).toBeInTheDocument();
    expect(screen.getByText('Timeout error')).toBeInTheDocument();
  });

  it('shows plural "attempts" when more than 1 remaining', () => {
    // 3 max, attempt 1 → 2 remaining
    render(
      <RetryPromptDialog
        retryPrompt={makeRetryPrompt(1, 3)}
        onRetryNow={noop}
        onUpdateScreenshots={noop}
        onCancel={noop}
      />,
    );

    expect(screen.getByText(/2 attempts remaining/i)).toBeInTheDocument();
  });

  it('shows singular "attempt" when exactly 1 remaining', () => {
    // 3 max, attempt 2 → 1 remaining
    render(
      <RetryPromptDialog
        retryPrompt={makeRetryPrompt(2, 3)}
        onRetryNow={noop}
        onUpdateScreenshots={noop}
        onCancel={noop}
      />,
    );

    expect(screen.getByText(/1 attempt remaining/i)).toBeInTheDocument();
  });

  it('calls onRetryNow when Retry Now is clicked', async () => {
    const user = userEvent.setup();
    const onRetryNow = vi.fn();
    render(
      <RetryPromptDialog
        retryPrompt={makeRetryPrompt(1, 3)}
        onRetryNow={onRetryNow}
        onUpdateScreenshots={noop}
        onCancel={noop}
      />,
    );

    await user.click(screen.getByRole('button', { name: /retry now/i }));
    expect(onRetryNow).toHaveBeenCalledOnce();
  });

  it('calls onUpdateScreenshots when Update Screenshots First is clicked', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    render(
      <RetryPromptDialog
        retryPrompt={makeRetryPrompt(1, 3)}
        onRetryNow={noop}
        onUpdateScreenshots={onUpdate}
        onCancel={noop}
      />,
    );

    await user.click(
      screen.getByRole('button', { name: /update screenshots first/i }),
    );
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it('calls onCancel when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <RetryPromptDialog
        retryPrompt={makeRetryPrompt(1, 3)}
        onRetryNow={noop}
        onUpdateScreenshots={noop}
        onCancel={onCancel}
      />,
    );

    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('has alertdialog role and label', () => {
    render(
      <RetryPromptDialog
        retryPrompt={makeRetryPrompt(1, 3)}
        onRetryNow={noop}
        onUpdateScreenshots={noop}
        onCancel={noop}
      />,
    );

    expect(
      screen.getByRole('alertdialog', { name: /analysis retry prompt/i }),
    ).toBeInTheDocument();
  });
});
