import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
    T: 0.03,
    hoursRemaining: 7,
    deltaCeiling: 8,
    putSpreadCeiling: 10,
    callSpreadCeiling: 10,
    regimeZone: 'GREEN',
    clusterMult: 1.0,
    dowLabel: 'Friday',
    openingRangeSignal: 'neutral',
    vixTermSignal: 'contango',
    rvIvRatio: '0.85',
    overnightGap: '0.1',
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
  structure: 'IRON CONDOR',
  confidence: 'HIGH',
  suggestedDelta: 8,
  reasoning: 'NCP and NPP are parallel, indicating a ranging day.',
  observations: ['NCP at +50M', 'NPP at -40M', 'Lines trending parallel'],
  risks: ['VIX elevated above 20'],
  periscopeNotes: null as string | null,
  structureRationale: 'NCP ≈ NPP suggests balanced flow.',
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
        screen.getByRole('button', { name: /analyze 1 chart$/i }),
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
    });

    it('shows loading state while analyzing', async () => {
      const user = userEvent.setup();
      // Never resolve to keep loading state
      vi.mocked(globalThis.fetch).mockReturnValue(new Promise(() => {}));

      const { container } = render(
        <ChartAnalysis th={th} results={null} context={makeContext()} />,
      );
      await addImageViaInput(container);
      await user.click(screen.getByRole('button', { name: /analyze/i }));

      expect(screen.getByText(/analyzing charts/i)).toBeInTheDocument();
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
  // RESULTS DISPLAY
  // ============================================================

  describe('results display', () => {
    async function renderWithAnalysis(
      analysis: typeof SAMPLE_ANALYSIS = SAMPLE_ANALYSIS,
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
        <ChartAnalysis
          th={th}
          results={makeResults()}
          context={makeContext()}
        />,
      );
      await addImageViaInput(view.container);
      await user.click(screen.getByRole('button', { name: /analyze/i }));
      await waitFor(() => {
        expect(screen.getByText(analysis.structure)).toBeInTheDocument();
      });
    }

    it('displays structure recommendation', async () => {
      await renderWithAnalysis();
      expect(screen.getByText('IRON CONDOR')).toBeInTheDocument();
    });

    it('displays confidence badge', async () => {
      await renderWithAnalysis();
      expect(screen.getByText('HIGH')).toBeInTheDocument();
    });

    it('displays suggested delta', async () => {
      await renderWithAnalysis();
      expect(screen.getByText(/8\u0394/)).toBeInTheDocument();
    });

    it('displays reasoning', async () => {
      await renderWithAnalysis();
      expect(screen.getByText(/NCP and NPP are parallel/)).toBeInTheDocument();
    });

    it('displays observations', async () => {
      await renderWithAnalysis();
      expect(screen.getByText('Key Observations')).toBeInTheDocument();
      expect(screen.getByText('NCP at +50M')).toBeInTheDocument();
      expect(screen.getByText('NPP at -40M')).toBeInTheDocument();
      expect(screen.getByText('Lines trending parallel')).toBeInTheDocument();
    });

    it('displays risk factors', async () => {
      await renderWithAnalysis();
      expect(screen.getByText('Risk Factors')).toBeInTheDocument();
      expect(screen.getByText('VIX elevated above 20')).toBeInTheDocument();
    });

    it('does not show risk section when risks are empty', async () => {
      await renderWithAnalysis({ ...SAMPLE_ANALYSIS, risks: [] });
      expect(screen.queryByText('Risk Factors')).not.toBeInTheDocument();
    });

    it('displays periscope notes when provided', async () => {
      await renderWithAnalysis({
        ...SAMPLE_ANALYSIS,
        periscopeNotes: 'Positive gamma wall at 5750.',
      });
      expect(screen.getByText('Periscope Analysis')).toBeInTheDocument();
      expect(
        screen.getByText('Positive gamma wall at 5750.'),
      ).toBeInTheDocument();
    });

    it('does not show periscope section when notes are null', async () => {
      await renderWithAnalysis({ ...SAMPLE_ANALYSIS, periscopeNotes: null });
      expect(screen.queryByText('Periscope Analysis')).not.toBeInTheDocument();
    });

    it('displays structure rationale', async () => {
      await renderWithAnalysis();
      expect(
        screen.getByText(/NCP ≈ NPP suggests balanced flow/),
      ).toBeInTheDocument();
    });

    it('displays PUT CREDIT SPREAD result', async () => {
      await renderWithAnalysis({
        ...SAMPLE_ANALYSIS,
        structure: 'PUT CREDIT SPREAD',
        confidence: 'MODERATE',
      });
      expect(screen.getByText('PUT CREDIT SPREAD')).toBeInTheDocument();
      expect(screen.getByText('MODERATE')).toBeInTheDocument();
    });

    it('displays CALL CREDIT SPREAD result', async () => {
      await renderWithAnalysis({
        ...SAMPLE_ANALYSIS,
        structure: 'CALL CREDIT SPREAD',
      });
      expect(screen.getByText('CALL CREDIT SPREAD')).toBeInTheDocument();
    });

    it('displays SIT OUT result', async () => {
      await renderWithAnalysis({
        ...SAMPLE_ANALYSIS,
        structure: 'SIT OUT',
        confidence: 'LOW',
      });
      expect(screen.getByText('SIT OUT')).toBeInTheDocument();
      expect(screen.getByText('LOW')).toBeInTheDocument();
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
