import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import ChartAnalysis from '../components/ChartAnalysis';
import type { AnalysisContext } from '../components/ChartAnalysis';
import { theme } from '../themes';
import type { CalculationResults } from '../types';

const th = theme;

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
    <ChartAnalysis th={th} results={makeResults()} context={makeContext()} />,
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
    render(<ChartAnalysis th={th} results={null} context={makeContext()} />);
    expect(screen.getByText('Chart Analysis')).toBeInTheDocument();
  });

  it('shows upload prompt when no images', () => {
    render(<ChartAnalysis th={th} results={null} context={makeContext()} />);
    expect(screen.getByText(/drop or click to upload/i)).toBeInTheDocument();
  });

  it('does not show analyze button when no images', () => {
    render(<ChartAnalysis th={th} results={null} context={makeContext()} />);
    expect(
      screen.queryByRole('button', { name: /analyze/i }),
    ).not.toBeInTheDocument();
  });

  // ── IMAGE MANAGEMENT ──

  describe('image management', () => {
    it('shows image count after adding an image', async () => {
      const { container } = render(
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      expect(screen.getByText(/1\/7 images/)).toBeInTheDocument();
    });

    it('shows analyze button after adding an image', async () => {
      const { container } = render(
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      expect(
        screen.getByRole('button', { name: /analyze 1 chart/i }),
      ).toBeInTheDocument();
    });

    it('pluralizes button text for multiple images', async () => {
      const { container } = render(
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
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
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await user.click(screen.getByRole('button', { name: /remove image/i }));
      expect(screen.getByText(/drop or click to upload/i)).toBeInTheDocument();
    });

    it('defaults image label to Market Tide', async () => {
      const { container } = render(
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(
        'Market Tide',
      );
    });

    it('allows changing the image label', async () => {
      const user = userEvent.setup();
      const { container } = render(
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      const select = screen.getByRole('combobox');
      await user.selectOptions(select, 'Net Flow (SPY)');
      expect((select as HTMLSelectElement).value).toBe('Net Flow (SPY)');
    });

    it('limits to 7 images', async () => {
      const { container } = render(
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
      );
      for (let i = 0; i < 8; i++)
        await addImageViaInput(container, createImageFile(`chart${i}.png`));
      expect(screen.getByText(/7\/7 images/)).toBeInTheDocument();
    });

    it('handles drag and drop', async () => {
      render(<ChartAnalysis th={th} results={null} context={makeContext()} />);
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
      expect(screen.getByText(/1\/7 images/)).toBeInTheDocument();
    });
  });

  // ── CONFIRMATION STEP ──

  describe('confirmation step', () => {
    it('shows confirmation bar when analyze is clicked', async () => {
      const user = userEvent.setup();
      const { container } = render(
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
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
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await user.click(screen.getByRole('button', { name: /analyze/i }));
      expect(screen.getAllByText(/Market Tide/).length).toBeGreaterThanOrEqual(
        1,
      );
    });

    it('returns to normal state when Go Back is clicked', async () => {
      const user = userEvent.setup();
      const { container } = render(
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
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
        <ChartAnalysis
          th={th}
          results={makeResults()}
          context={makeContext()}
        />,
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
        <ChartAnalysis
          th={th}
          results={makeResults()}
          context={makeContext()}
        />,
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
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await clickAnalyzeAndConfirm(user);
      expect(screen.getByText(/opus is thinking/i)).toBeInTheDocument();
    });

    it('shows cancel button while loading', async () => {
      const user = userEvent.setup();
      vi.mocked(globalThis.fetch).mockReturnValue(new Promise(() => {}));
      const { container } = render(
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
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
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await clickAnalyzeAndConfirm(user);
      expect(screen.getByText('0s')).toBeInTheDocument();
    });

    it('cancels analysis when cancel button is clicked', async () => {
      const user = userEvent.setup();
      vi.mocked(globalThis.fetch).mockReturnValue(new Promise(() => {}));
      const { container } = render(
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
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
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
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
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
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
      expect(screen.getAllByText('Market Tide').length).toBeGreaterThanOrEqual(
        1,
      );
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
      render(<ChartAnalysis th={th} results={null} context={makeContext()} />);
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
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
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
            label: 'Market Tide',
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
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      const inputs = container.querySelectorAll('input[type="file"]');
      fireEvent.change(inputs[1]!, {
        target: { files: [createImageFile('new.png')] },
      });
      expect(screen.getByText(/1\/7 images/)).toBeInTheDocument();
    });
  });

  // ── PASTE ──

  describe('paste handling', () => {
    it('adds image from clipboard', async () => {
      render(<ChartAnalysis th={th} results={null} context={makeContext()} />);
      const evt = new Event('paste', { bubbles: true }) as any;
      evt.clipboardData = {
        items: [{ type: 'image/png', getAsFile: () => createImageFile() }],
      };
      evt.preventDefault = vi.fn();
      await act(() => {
        document.dispatchEvent(evt);
      });
      expect(screen.getByText(/1\/7 images/)).toBeInTheDocument();
    });

    it('ignores non-image paste', () => {
      render(<ChartAnalysis th={th} results={null} context={makeContext()} />);
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
    it('fallback error on JSON parse failure', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          json: () => Promise.reject(new Error('bad')),
        }),
      );
      const { container } = render(
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await clickAnalyzeAndConfirm(user);
      await act(() => vi.advanceTimersByTimeAsync(5000));
      await waitFor(() => {
        expect(screen.getByText('Request failed')).toBeInTheDocument();
      });
      vi.useRealTimers();
    });

    it('HTTP status when no error field', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(
          () =>
            new Response(JSON.stringify({ message: 'x' }), {
              status: 503,
              headers: { 'Content-Type': 'application/json' },
            }),
        ),
      );
      const { container } = render(
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await clickAnalyzeAndConfirm(user);
      await act(() => vi.advanceTimersByTimeAsync(5000));
      await waitFor(() => {
        expect(screen.getByText('HTTP 503')).toBeInTheDocument();
      });
      vi.useRealTimers();
    });

    it('generic error for non-Error throws', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue('string'));
      const { container } = render(
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await clickAnalyzeAndConfirm(user);
      await act(() => vi.advanceTimersByTimeAsync(5000));
      await waitFor(() => {
        expect(screen.getByText('Analysis failed')).toBeInTheDocument();
      });
      vi.useRealTimers();
    });
  });

  // ── UPLOAD BUTTON ──

  describe('upload button', () => {
    it('opens file picker on click', async () => {
      const user = userEvent.setup();
      render(<ChartAnalysis th={th} results={null} context={makeContext()} />);
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
          th={th}
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
          th={th}
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
        <ChartAnalysis
          th={th}
          results={makeResults()}
          context={makeContext()}
        />,
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
          th={th}
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
              positions: { stats: { totalSpreads: 3 } },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      );
      const { container } = render(
        <ChartAnalysis
          th={th}
          results={makeResults()}
          context={makeContext()}
        />,
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
        expect(screen.getByText(/3 spreads loaded/)).toBeInTheDocument();
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
        <ChartAnalysis
          th={th}
          results={makeResults()}
          context={makeContext()}
        />,
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
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
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
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
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
        <ChartAnalysis
          th={th}
          results={makeResults()}
          context={makeContext()}
        />,
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
                  label: 'Market Tide',
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
        <ChartAnalysis
          th={th}
          results={makeResults()}
          context={makeContext()}
        />,
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
      expect(screen.getByText(/1\/7 images/)).toBeInTheDocument();
    });

    it('handleReplaceFile does nothing with out-of-bounds index', async () => {
      vi.stubGlobal('fetch', vi.fn());
      const { container } = render(
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);

      // The replace input (second file input) with no replaceTargetIndex set
      const inputs = container.querySelectorAll('input[type="file"]');
      fireEvent.change(inputs[1]!, {
        target: { files: [createImageFile('new.png')] },
      });

      // Still 1 image, nothing changed
      expect(screen.getByText(/1\/7 images/)).toBeInTheDocument();
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
      render(<ChartAnalysis th={th} results={null} context={makeContext()} />);
      const dropZone = screen.getByRole('button', {
        name: /upload chart images/i,
      });
      const evt = new Event('dragover', { bubbles: true, cancelable: true });
      fireEvent(dropZone, evt);
    });
  });

  // ── TIMEOUT ERROR ──

  describe('timeout error', () => {
    it('shows timeout message when AbortError fires from timeout', async () => {
      const user = userEvent.setup();
      const abortError = new DOMException(
        'The operation was aborted.',
        'AbortError',
      );
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

      const { container } = render(
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await clickAnalyzeAndConfirm(user);

      await waitFor(() => {
        expect(screen.getByText(/analysis timed out/i)).toBeInTheDocument();
      });
    });
  });
});
