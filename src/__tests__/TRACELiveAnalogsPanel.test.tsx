import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import TRACELiveAnalogsPanel from '../components/TRACELive/TRACELiveAnalogsPanel';
import type {
  TraceLiveDetail,
  TraceLiveAnalog,
} from '../components/TRACELive/types';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function makeDetail(id: number | null): TraceLiveDetail | null {
  if (id == null) return null;
  return {
    id,
    capturedAt: '2026-04-27T18:00:00Z',
    spot: 5800,
    stabilityPct: null,
    regime: null,
    predictedClose: 5810,
    confidence: 'medium',
    overrideApplied: false,
    headline: null,
    imageUrls: {},
    analysis: null,
    noveltyScore: null,
    actualClose: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    durationMs: null,
    createdAt: '2026-04-27T18:00:00Z',
  };
}

function makeAnalog(overrides: Partial<TraceLiveAnalog> = {}): TraceLiveAnalog {
  return {
    id: 100,
    capturedAt: '2026-04-20T18:00:00Z',
    spot: 5775,
    regime: 'range_bound_positive_gamma',
    predictedClose: 5780,
    actualClose: 5782,
    confidence: 'high',
    headline: null,
    distance: 0.0823,
    error: 2,
    ...overrides,
  };
}

describe('TRACELiveAnalogsPanel', () => {
  it('renders nothing when detail is null', () => {
    const { container } = render(<TRACELiveAnalogsPanel detail={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('does not fire a fetch when detail.id is null (defensive shape)', () => {
    // detail with id null should never happen per types, but guard the
    // memo dependency anyway.
    render(<TRACELiveAnalogsPanel detail={null} />);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('builds the request URL with id + k=10', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 7, k: 10, analogs: [] }),
    );
    render(<TRACELiveAnalogsPanel detail={makeDetail(7)} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/trace-live-analogs?id=7&k=10');
  });

  it('renders the loading state while the fetch is in flight', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<TRACELiveAnalogsPanel detail={makeDetail(7)} />);
    fireEvent.click(screen.getByText('Historical Analogs'));
    expect(screen.getByText(/Loading analogs/)).toBeInTheDocument();
  });

  it('renders rows from the analogs response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 7,
        k: 10,
        analogs: [
          makeAnalog({ id: 100, distance: 0.05 }),
          makeAnalog({ id: 101, distance: 0.12 }),
        ],
      }),
    );
    render(<TRACELiveAnalogsPanel detail={makeDetail(7)} />);
    fireEvent.click(screen.getByText('Historical Analogs'));
    await waitFor(() =>
      expect(screen.getByText('0.0500')).toBeInTheDocument(),
    );
    expect(screen.getByText('0.1200')).toBeInTheDocument();
  });

  it('renders the empty-state message when the response has zero analogs', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 7, k: 10, analogs: [] }),
    );
    render(<TRACELiveAnalogsPanel detail={makeDetail(7)} />);
    fireEvent.click(screen.getByText('Historical Analogs'));
    await waitFor(() =>
      expect(
        screen.getByText(/No historical analogs found yet/),
      ).toBeInTheDocument(),
    );
  });

  it('treats 404 as the empty state (no scary error string)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 404));
    render(<TRACELiveAnalogsPanel detail={makeDetail(7)} />);
    fireEvent.click(screen.getByText('Historical Analogs'));
    await waitFor(() =>
      expect(
        screen.getByText(/No historical analogs found yet/),
      ).toBeInTheDocument(),
    );
  });

  it('silently ignores 401 (non-owner path) — does not surface an error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));
    render(<TRACELiveAnalogsPanel detail={makeDetail(7)} />);
    fireEvent.click(screen.getByText('Historical Analogs'));
    // Wait for the fetch to settle.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByText(/Failed to load analogs/)).not.toBeInTheDocument();
  });

  it('renders an error message for other non-OK statuses', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500));
    render(<TRACELiveAnalogsPanel detail={makeDetail(7)} />);
    fireEvent.click(screen.getByText('Historical Analogs'));
    await waitFor(() =>
      expect(screen.getByText(/Failed to load analogs/)).toBeInTheDocument(),
    );
  });

  it('renders an error message when fetch rejects', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    render(<TRACELiveAnalogsPanel detail={makeDetail(7)} />);
    fireEvent.click(screen.getByText('Historical Analogs'));
    await waitFor(() =>
      expect(screen.getByText(/network down/)).toBeInTheDocument(),
    );
  });

  it('formats the delta (actualClose - predictedClose) with a + sign for positive errors', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 7,
        k: 10,
        analogs: [makeAnalog({ error: 7.5 })],
      }),
    );
    render(<TRACELiveAnalogsPanel detail={makeDetail(7)} />);
    fireEvent.click(screen.getByText('Historical Analogs'));
    await waitFor(() => expect(screen.getByText('+7.50')).toBeInTheDocument());
  });

  it('renders an em-dash for null error values', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 7,
        k: 10,
        analogs: [
          makeAnalog({ error: null, predictedClose: null, actualClose: null }),
        ],
      }),
    );
    render(<TRACELiveAnalogsPanel detail={makeDetail(7)} />);
    fireEvent.click(screen.getByText('Historical Analogs'));
    await waitFor(() => {
      // Three em-dashes show: predictedClose, actualClose, error.
      const dashes = screen.getAllByText('—');
      expect(dashes.length).toBeGreaterThanOrEqual(3);
    });
  });

  it('refetches when detail.id changes', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ id: 7, k: 10, analogs: [] }),
    );
    const { rerender } = render(
      <TRACELiveAnalogsPanel detail={makeDetail(7)} />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender(<TRACELiveAnalogsPanel detail={makeDetail(8)} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]![0]).toContain('id=8');
  });
});
