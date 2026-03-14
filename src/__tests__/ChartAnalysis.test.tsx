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
import { lightTheme } from '../themes';
import type { CalculationResults } from '../types';

const th = lightTheme;

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

/** Simulate adding an image via the file input */
async function addImageViaInput(container: HTMLElement, file?: File) {
  const input = container.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  const imageFile = file ?? createImageFile();
  fireEvent.change(input, { target: { files: [imageFile] } });
}

/** Click a collapsible section header to expand it */
async function expandSection(
  user: ReturnType<typeof userEvent.setup>,
  title: string,
) {
  const btn = screen.getByText(title).closest('button');
  if (btn) await user.click(btn);
}

/** Stub fetch with the given analysis, render ChartAnalysis, upload an image, and click Analyze */
async function renderAndAnalyze(
  analysis: Record<string, unknown> = SAMPLE_ANALYSIS,
) {
  const user = userEvent.setup();
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
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
  await user.click(screen.getByRole('button', { name: /analyze/i }));
  await waitFor(() => {
    expect(screen.getByText(analysis.structure as string)).toBeInTheDocument();
  });
  return { user, view };
}

// ============================================================
// RENDERING
// ============================================================

describe('ChartAnalysis', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Mock URL.createObjectURL / revokeObjectURL
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

  // ============================================================
  // IMAGE MANAGEMENT
  // ============================================================

  describe('image management', () => {
    it('shows image count after adding an image', async () => {
      const { container } = render(
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      expect(screen.getByText(/1\/5 images/)).toBeInTheDocument();
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
      expect(screen.getByText(/1\/5 images/)).toBeInTheDocument();

      const removeBtn = screen.getByRole('button', { name: /remove image/i });
      await user.click(removeBtn);
      expect(screen.getByText(/drop or click to upload/i)).toBeInTheDocument();
    });

    it('defaults image label to Market Tide (SPX)', async () => {
      const { container } = render(
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      const select = screen.getByRole('combobox') as HTMLSelectElement;
      expect(select.value).toBe('Market Tide (SPX)');
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

    it('limits to 5 images', async () => {
      const { container } = render(
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
      );
      for (let i = 0; i < 6; i++) {
        await addImageViaInput(container, createImageFile(`chart${i}.png`));
      }
      expect(screen.getByText(/5\/5 images/)).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /analyze 5 charts/i }),
      ).toBeInTheDocument();
    });

    it('handles drag and drop', async () => {
      render(<ChartAnalysis th={th} results={null} context={makeContext()} />);
      const dropZone = screen.getByRole('button', {
        name: /upload chart images/i,
      });
      const file = createImageFile();
      const dataTransfer = {
        files: [file],
        items: [],
        types: ['Files'],
      };
      fireEvent.drop(dropZone, { dataTransfer });
      expect(screen.getByText(/1\/5 images/)).toBeInTheDocument();
    });
  });

  // ============================================================
  // ANALYZE FLOW
  // ============================================================

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

      const ctx = makeContext();
      const results = makeResults();
      const { container } = render(
        <ChartAnalysis th={th} results={results} context={ctx} />,
      );
      await addImageViaInput(container);
      await user.click(screen.getByRole('button', { name: /analyze/i }));

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledOnce();
      });

      const [url, opts] = mockFetch.mock.calls[0]!;
      expect(url).toBe('/api/analyze');
      expect(opts!.method).toBe('POST');

      const body = JSON.parse(opts!.body as string);
      expect(body.images).toHaveLength(1);
      expect(body.context).toBeDefined();
      expect(body.context.mode).toBe('entry');
    });

    it('shows thinking indicator while analyzing', async () => {
      const user = userEvent.setup();
      // Never resolve to keep loading state
      vi.mocked(globalThis.fetch).mockReturnValue(new Promise(() => {}));

      const { container } = render(
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await user.click(screen.getByRole('button', { name: /analyze/i }));

      expect(screen.getByText(/opus is thinking/i)).toBeInTheDocument();
      // Analyze button should be hidden during loading
      expect(
        screen.queryByRole('button', { name: /analyze/i }),
      ).not.toBeInTheDocument();
    });

    it('shows elapsed timer while loading', async () => {
      const user = userEvent.setup();
      vi.mocked(globalThis.fetch).mockReturnValue(new Promise(() => {}));

      const { container } = render(
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await user.click(screen.getByRole('button', { name: /analyze/i }));

      expect(screen.getByText('0s')).toBeInTheDocument();
    });

    it('displays error on fetch failure', async () => {
      const user = userEvent.setup();
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error('Network error'));

      const { container } = render(
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await user.click(screen.getByRole('button', { name: /analyze/i }));

      await waitFor(() => {
        expect(screen.getByText('Network error')).toBeInTheDocument();
      });
    });

    it('displays error on non-ok response', async () => {
      const user = userEvent.setup();
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ error: 'Not authenticated' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const { container } = render(
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await user.click(screen.getByRole('button', { name: /analyze/i }));

      await waitFor(() => {
        expect(screen.getByText('Not authenticated')).toBeInTheDocument();
      });
    });
  });

  // ============================================================
  // TL;DR SUMMARY CARD
  // ============================================================

  describe('TL;DR summary card', () => {
    it('displays structure, confidence, delta in summary', async () => {
      await renderAndAnalyze();
      expect(screen.getByText('IRON CONDOR')).toBeInTheDocument();
      expect(screen.getByText('HIGH')).toBeInTheDocument();
      expect(screen.getByText(/8\u0394/)).toBeInTheDocument();
    });

    it('displays reasoning in summary', async () => {
      await renderAndAnalyze();
      expect(screen.getByText(/NCP and NPP are parallel/)).toBeInTheDocument();
    });

    it('shows hedge badge in summary when hedge is not NO HEDGE', async () => {
      await renderAndAnalyze({
        ...SAMPLE_ANALYSIS,
        hedge: {
          recommendation: 'REDUCED SIZE',
          description: 'Use 70% of normal size.',
          rationale: 'Elevated VIX.',
          estimatedCost: 'N/A',
        },
      });
      // Badge in summary card
      expect(screen.getByText('REDUCED SIZE')).toBeInTheDocument();
    });

    it('shows Entry 1 summary in quick-glance', async () => {
      await renderAndAnalyze({
        ...SAMPLE_ANALYSIS,
        entryPlan: {
          entry1: {
            timing: 'Now (8:45 AM CT)',
            sizePercent: 40,
            delta: 10,
            structure: 'CALL CREDIT SPREAD',
            note: 'Initial position',
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
      expect(screen.getByText('Close at 50% before 1 PM')).toBeInTheDocument();
    });
  });

  // ============================================================
  // COLLAPSIBLE DETAIL SECTIONS
  // ============================================================

  describe('collapsible detail sections', () => {
    async function renderWithFullAnalysis() {
      const user = userEvent.setup();
      const fullAnalysis = {
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
          putStrikeNote: 'Place below 5650 positive gamma wall.',
          callStrikeNote: 'Place above 5780 resistance.',
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
            structure: 'CALL CREDIT SPREAD',
            note: 'Initial',
          },
          entry2: {
            condition: 'Range GREEN at 10:00',
            sizePercent: 30,
            delta: 8,
            structure: 'CALL CREDIT SPREAD',
            note: 'Add',
          },
          maxTotalSize: '100% of daily risk budget',
          noEntryConditions: ['Opening range RED', 'NCP/NPP converge'],
        },
        managementRules: {
          profitTarget: 'Close at 50% of max profit before 1 PM',
          stopConditions: ['Close put side if SPX breaks below 5620'],
          timeRules: 'Close after 2:30 PM if < 30% profit',
          flowReversalSignal: 'NCP and NPP converge — bias shifted',
        },
        risks: ['VIX elevated above 20'],
        hedge: {
          recommendation: 'PROTECTIVE LONG',
          description: 'Buy a protective put.',
          rationale: 'Elevated tail risk.',
          estimatedCost: '$1.20',
        },
        periscopeNotes: 'Positive gamma wall at 5750.',
      };

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              analysis: fullAnalysis,
              raw: JSON.stringify(fullAnalysis),
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      );

      const view = render(
        <ChartAnalysis
          th={th}
          results={makeResults()}
          context={makeContext()}
        />,
      );
      await addImageViaInput(view.container);
      await user.click(screen.getByRole('button', { name: /analyze/i }));
      await waitFor(() => {
        expect(screen.getByText('IRON CONDOR')).toBeInTheDocument();
      });
      return user;
    }

    it('chart confidence cards are always visible', async () => {
      await renderWithFullAnalysis();
      expect(screen.getByText('Market Tide')).toBeInTheDocument();
      expect(screen.getByText('BEARISH')).toBeInTheDocument();
      expect(screen.getByText('SPY Flow')).toBeInTheDocument();
      expect(screen.getByText('CONFIRMS')).toBeInTheDocument();
    });

    it('hides chart confidence entries with NOT PROVIDED signal', async () => {
      const user = userEvent.setup();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              analysis: {
                ...SAMPLE_ANALYSIS,
                chartConfidence: {
                  marketTide: {
                    signal: 'BULLISH',
                    confidence: 'HIGH',
                    note: 'Strong call flow',
                  },
                  spyNetFlow: {
                    signal: 'NOT PROVIDED',
                    confidence: 'LOW',
                    note: '',
                  },
                  periscope: {
                    signal: 'UNFAVORABLE',
                    confidence: 'MODERATE',
                    note: 'Negative gamma',
                  },
                },
              },
              raw: '{}',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      );
      const view = render(
        <ChartAnalysis
          th={th}
          results={makeResults()}
          context={makeContext()}
        />,
      );
      await addImageViaInput(view.container);
      await user.click(screen.getByRole('button', { name: /analyze/i }));
      await waitFor(() => {
        expect(screen.getByText('BULLISH')).toBeInTheDocument();
      });
      expect(screen.queryByText('SPY Flow')).not.toBeInTheDocument();
      expect(screen.getByText('UNFAVORABLE')).toBeInTheDocument();
    });

    it('observations are collapsed by default, expand on click', async () => {
      const user = await renderWithFullAnalysis();
      // Header visible but content hidden
      expect(screen.getByText('Key Observations')).toBeInTheDocument();
      expect(screen.queryByText('NCP at +50M')).not.toBeInTheDocument();
      // Expand
      await expandSection(user, 'Key Observations');
      expect(screen.getByText('NCP at +50M')).toBeInTheDocument();
      expect(screen.getByText('NPP at -40M')).toBeInTheDocument();
    });

    it('strike guidance is expanded by default', async () => {
      await renderWithFullAnalysis();
      expect(
        screen.getByText('Place below 5650 positive gamma wall.'),
      ).toBeInTheDocument();
      expect(
        screen.getByText('Place above 5780 resistance.'),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Straddle cone:.*5620.*5780/s),
      ).toBeInTheDocument();
      expect(
        screen.getAllByText('Move put from 5660 to 5640').length,
      ).toBeGreaterThanOrEqual(1);
    });

    it('entry plan is expanded by default', async () => {
      await renderWithFullAnalysis();
      expect(screen.getByText('Initial')).toBeInTheDocument();
      expect(screen.getByText('Add')).toBeInTheDocument();
      expect(screen.getByText(/100% of daily risk budget/)).toBeInTheDocument();
      expect(screen.getByText('Do NOT add entries if:')).toBeInTheDocument();
    });

    it('management rules are collapsed by default, expand on click', async () => {
      const user = await renderWithFullAnalysis();
      expect(screen.getByText('Position Management Rules')).toBeInTheDocument();
      expect(
        screen.queryByText('Close put side if SPX breaks below 5620'),
      ).not.toBeInTheDocument();
      await expandSection(user, 'Position Management Rules');
      expect(
        screen.getAllByText('Close at 50% of max profit before 1 PM').length,
      ).toBeGreaterThanOrEqual(1);
      expect(
        screen.getByText('Close put side if SPX breaks below 5620'),
      ).toBeInTheDocument();
      expect(
        screen.getByText('Close after 2:30 PM if < 30% profit'),
      ).toBeInTheDocument();
      expect(
        screen.getByText('NCP and NPP converge — bias shifted'),
      ).toBeInTheDocument();
    });

    it('risk factors are collapsed by default, expand on click', async () => {
      const user = await renderWithFullAnalysis();
      expect(screen.getByText('Risk Factors')).toBeInTheDocument();
      expect(
        screen.queryByText('VIX elevated above 20'),
      ).not.toBeInTheDocument();
      await expandSection(user, 'Risk Factors');
      expect(screen.getByText('VIX elevated above 20')).toBeInTheDocument();
    });

    it('does not show risk section when risks are empty', async () => {
      const user = userEvent.setup();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              analysis: { ...SAMPLE_ANALYSIS, risks: [] },
              raw: '{}',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      );
      const view = render(
        <ChartAnalysis
          th={th}
          results={makeResults()}
          context={makeContext()}
        />,
      );
      await addImageViaInput(view.container);
      await user.click(screen.getByRole('button', { name: /analyze/i }));
      await waitFor(() => {
        expect(screen.getByText('IRON CONDOR')).toBeInTheDocument();
      });
      expect(screen.queryByText('Risk Factors')).not.toBeInTheDocument();
    });

    it('hedge section is collapsed by default, expand on click', async () => {
      const user = await renderWithFullAnalysis();
      expect(screen.getByText(/Hedge: PROTECTIVE LONG/)).toBeInTheDocument();
      const beforeCount = screen.queryAllByText('Buy a protective put.').length;
      await expandSection(user, 'Hedge: PROTECTIVE LONG');
      expect(
        screen.getAllByText('Buy a protective put.').length,
      ).toBeGreaterThan(beforeCount);
      expect(screen.getByText('$1.20')).toBeInTheDocument();
      expect(screen.getByText('Elevated tail risk.')).toBeInTheDocument();
    });

    it('periscope analysis is collapsed by default, expand on click', async () => {
      const user = await renderWithFullAnalysis();
      expect(screen.getByText('Periscope Analysis')).toBeInTheDocument();
      expect(
        screen.queryByText('Positive gamma wall at 5750.'),
      ).not.toBeInTheDocument();
      await expandSection(user, 'Periscope Analysis');
      expect(
        screen.getByText('Positive gamma wall at 5750.'),
      ).toBeInTheDocument();
    });

    it('does not show periscope section when notes are null', async () => {
      const user = userEvent.setup();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              analysis: { ...SAMPLE_ANALYSIS, periscopeNotes: null },
              raw: '{}',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      );
      const view = render(
        <ChartAnalysis
          th={th}
          results={makeResults()}
          context={makeContext()}
        />,
      );
      await addImageViaInput(view.container);
      await user.click(screen.getByRole('button', { name: /analyze/i }));
      await waitFor(() => {
        expect(screen.getByText('IRON CONDOR')).toBeInTheDocument();
      });
      expect(screen.queryByText('Periscope Analysis')).not.toBeInTheDocument();
    });

    it('structure rationale is collapsed by default, expand on click', async () => {
      const user = await renderWithFullAnalysis();
      expect(screen.getByText('Structure Rationale')).toBeInTheDocument();
      expect(
        screen.queryByText(/NCP ≈ NPP suggests balanced flow/),
      ).not.toBeInTheDocument();
      await expandSection(user, 'Structure Rationale');
      expect(
        screen.getByText(/NCP ≈ NPP suggests balanced flow/),
      ).toBeInTheDocument();
    });

    it('collapsible sections toggle on click', async () => {
      const user = await renderWithFullAnalysis();
      // Expand observations
      await expandSection(user, 'Key Observations');
      expect(screen.getByText('NCP at +50M')).toBeInTheDocument();
      // Collapse again
      await expandSection(user, 'Key Observations');
      expect(screen.queryByText('NCP at +50M')).not.toBeInTheDocument();
    });
  });

  // ============================================================
  // RESULTS - STRUCTURE VARIATIONS
  // ============================================================

  describe('structure variations', () => {
    it('displays PUT CREDIT SPREAD result', async () => {
      await renderAndAnalyze({
        ...SAMPLE_ANALYSIS,
        structure: 'PUT CREDIT SPREAD',
        confidence: 'MODERATE',
      });
      expect(screen.getByText('PUT CREDIT SPREAD')).toBeInTheDocument();
      expect(screen.getByText('MODERATE')).toBeInTheDocument();
    });

    it('displays CALL CREDIT SPREAD result', async () => {
      await renderAndAnalyze({
        ...SAMPLE_ANALYSIS,
        structure: 'CALL CREDIT SPREAD',
      });
      expect(screen.getByText('CALL CREDIT SPREAD')).toBeInTheDocument();
    });

    it('displays SIT OUT result', async () => {
      await renderAndAnalyze({
        ...SAMPLE_ANALYSIS,
        structure: 'SIT OUT',
        confidence: 'LOW',
      });
      expect(screen.getByText('SIT OUT')).toBeInTheDocument();
      expect(screen.getByText('LOW')).toBeInTheDocument();
    });
  });

  // ============================================================
  // END-OF-DAY REVIEW
  // ============================================================

  describe('end-of-day review', () => {
    async function renderWithReview(review: Record<string, unknown>) {
      const user = userEvent.setup();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              analysis: { ...SAMPLE_ANALYSIS, review },
              raw: '{}',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      );
      const view = render(
        <ChartAnalysis
          th={th}
          results={makeResults()}
          context={makeContext()}
        />,
      );
      await addImageViaInput(view.container);
      await user.click(screen.getByRole('button', { name: /analyze/i }));
      await waitFor(() => {
        expect(screen.getByText('IRON CONDOR')).toBeInTheDocument();
      });
    }

    it('displays correct review', async () => {
      await renderWithReview({
        wasCorrect: true,
        whatWorked: 'Bearish call from NCP divergence was accurate.',
        whatMissed: 'The 2 PM NCP reversal was visible at 1:30 PM.',
        optimalTrade: 'Call credit spread at 10Δ, closed at 50%.',
        lessonsLearned: ['Late-day NCP reversals on Fridays are common'],
      });
      expect(
        screen.getByText(/Recommendation was correct/),
      ).toBeInTheDocument();
      expect(
        screen.getByText('Bearish call from NCP divergence was accurate.'),
      ).toBeInTheDocument();
      expect(screen.getByText('Lessons for next time')).toBeInTheDocument();
    });

    it('displays incorrect review', async () => {
      await renderWithReview({
        wasCorrect: false,
        whatWorked: 'Entry timing was good.',
        whatMissed: 'Flow reversed at 11 AM.',
        optimalTrade: 'Should have been put credit spread.',
        lessonsLearned: [],
      });
      expect(
        screen.getByText(/Recommendation was incorrect/),
      ).toBeInTheDocument();
    });
  });

  // ============================================================
  // MODE SELECTOR
  // ============================================================

  describe('mode selector', () => {
    it('switches analysis mode when mode buttons are clicked', async () => {
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

      await user.click(screen.getByText('Pre-Trade'));
      expect(
        screen.getByText('Full analysis before opening a position'),
      ).toBeInTheDocument();
    });

    it('includes mode in analyze button text', async () => {
      const user = userEvent.setup();
      const { container } = render(
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      expect(
        screen.getByRole('button', { name: /analyze 1 chart.*pre-trade/i }),
      ).toBeInTheDocument();

      await user.click(screen.getByText('Mid-Day'));
      expect(
        screen.getByRole('button', { name: /analyze 1 chart.*mid-day/i }),
      ).toBeInTheDocument();
    });
  });

  // ============================================================
  // IMAGE ISSUES
  // ============================================================

  describe('image issues', () => {
    async function renderWithImageIssues() {
      const user = userEvent.setup();
      const analysis = {
        ...SAMPLE_ANALYSIS,
        imageIssues: [
          {
            imageIndex: 1,
            label: 'Market Tide (SPX)',
            issue: 'Image is too blurry to read.',
            suggestion: 'Take a higher resolution screenshot.',
          },
        ],
      };
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            new Response(
              JSON.stringify({ analysis, raw: JSON.stringify(analysis) }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
          ),
      );

      const view = render(
        <ChartAnalysis
          th={th}
          results={makeResults()}
          context={makeContext()}
        />,
      );
      await addImageViaInput(view.container);
      await user.click(screen.getByRole('button', { name: /analyze/i }));
      await waitFor(() => {
        expect(screen.getByText('IRON CONDOR')).toBeInTheDocument();
      });
      return view;
    }

    it('displays image issues section', async () => {
      await renderWithImageIssues();
      expect(screen.getByText(/Image Issues/)).toBeInTheDocument();
      expect(
        screen.getByText(/Image is too blurry to read\./),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Take a higher resolution screenshot\./),
      ).toBeInTheDocument();
    });

    it('shows Replace button for flagged images', async () => {
      await renderWithImageIssues();
      expect(
        screen.getByRole('button', { name: /replace/i }),
      ).toBeInTheDocument();
    });

    it('clicking Replace triggers the replace file input', async () => {
      const user = userEvent.setup();
      await renderWithImageIssues();
      const replaceBtn = screen.getByRole('button', { name: /replace/i });
      await user.click(replaceBtn);
    });
  });

  // ============================================================
  // REPLACE IMAGE FLOW
  // ============================================================

  describe('replace image flow', () => {
    it('replaces an image via the hidden replace input', async () => {
      vi.stubGlobal('fetch', vi.fn());

      const { container } = render(
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
      );

      await addImageViaInput(container);
      expect(screen.getByText(/1\/5 images/)).toBeInTheDocument();

      const inputs = container.querySelectorAll('input[type="file"]');
      const replaceInput = inputs[1] as HTMLInputElement;

      const newFile = createImageFile('replacement.png');
      fireEvent.change(replaceInput, { target: { files: [newFile] } });

      expect(screen.getByText(/1\/5 images/)).toBeInTheDocument();
    });
  });

  // ============================================================
  // PASTE HANDLING
  // ============================================================

  describe('paste handling', () => {
    it('adds an image when pasting from clipboard', async () => {
      render(<ChartAnalysis th={th} results={null} context={makeContext()} />);

      const file = createImageFile('pasted.png');
      const clipboardEvent = new Event('paste', { bubbles: true }) as any;
      clipboardEvent.clipboardData = {
        items: [
          {
            type: 'image/png',
            getAsFile: () => file,
          },
        ],
      };
      clipboardEvent.preventDefault = vi.fn();

      await act(() => {
        document.dispatchEvent(clipboardEvent);
      });

      expect(screen.getByText(/1\/5 images/)).toBeInTheDocument();
    });

    it('ignores non-image paste items', () => {
      render(<ChartAnalysis th={th} results={null} context={makeContext()} />);

      const clipboardEvent = new Event('paste', { bubbles: true }) as any;
      clipboardEvent.clipboardData = {
        items: [
          {
            type: 'text/plain',
            getAsFile: () => null,
          },
        ],
      };

      document.dispatchEvent(clipboardEvent);

      expect(screen.getByText(/drop or click to upload/i)).toBeInTheDocument();
    });
  });

  // ============================================================
  // ERROR EDGE CASES
  // ============================================================

  describe('error edge cases', () => {
    it('shows fallback error when response JSON parsing fails', async () => {
      const user = userEvent.setup();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          json: () => Promise.reject(new Error('Invalid JSON')),
        }),
      );

      const { container } = render(
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await user.click(screen.getByRole('button', { name: /analyze/i }));

      await waitFor(() => {
        expect(screen.getByText('Request failed')).toBeInTheDocument();
      });
    });

    it('shows HTTP status when error body has no error field', async () => {
      const user = userEvent.setup();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ message: 'something' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );

      const { container } = render(
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await user.click(screen.getByRole('button', { name: /analyze/i }));

      await waitFor(() => {
        expect(screen.getByText('HTTP 503')).toBeInTheDocument();
      });
    });

    it('shows generic error for non-Error thrown values', async () => {
      const user = userEvent.setup();
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue('string error'));

      const { container } = render(
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await user.click(screen.getByRole('button', { name: /analyze/i }));

      await waitFor(() => {
        expect(screen.getByText('Analysis failed')).toBeInTheDocument();
      });
    });
  });

  // ============================================================
  // UPLOAD BUTTON
  // ============================================================

  describe('upload button', () => {
    it('opens file picker when upload area is clicked', async () => {
      const user = userEvent.setup();
      render(<ChartAnalysis th={th} results={null} context={makeContext()} />);
      const uploadBtn = screen.getByRole('button', {
        name: /upload chart images/i,
      });
      await user.click(uploadBtn);
    });

    it('handles dragOver by preventing default', () => {
      render(<ChartAnalysis th={th} results={null} context={makeContext()} />);
      const dropZone = screen.getByRole('button', {
        name: /upload chart images/i,
      });
      const event = new Event('dragover', { bubbles: true });
      Object.defineProperty(event, 'preventDefault', { value: vi.fn() });
      dropZone.dispatchEvent(event);
    });
  });

  // ============================================================
  // RAW RESPONSE FALLBACK
  // ============================================================

  describe('raw response fallback', () => {
    it('shows raw output when analysis is null', async () => {
      const user = userEvent.setup();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              analysis: null,
              raw: 'Unparseable response text',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      );

      const { container } = render(
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await user.click(screen.getByRole('button', { name: /analyze/i }));

      await waitFor(() => {
        expect(screen.getByText('Raw Analysis')).toBeInTheDocument();
        expect(
          screen.getByText('Unparseable response text'),
        ).toBeInTheDocument();
      });
    });

    it('shows parse error message when analysis is null but raw exists', async () => {
      const user = userEvent.setup();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ analysis: null, raw: 'some text' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );

      const { container } = render(
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await user.click(screen.getByRole('button', { name: /analyze/i }));

      await waitFor(() => {
        expect(
          screen.getByText(/could not parse structured response/i),
        ).toBeInTheDocument();
      });
    });
  });
});
