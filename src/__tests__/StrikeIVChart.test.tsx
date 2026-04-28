/**
 * StrikeIVChart — fetches per-strike IV bid/mid/ask history from
 * /api/iv-anomalies and renders it as three SVG polylines plus a
 * detection-time vertical reference line.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { StrikeIVChart } from '../components/IVAnomalies/StrikeIVChart';
import type { StrikeIVSample } from '../components/IVAnomalies/types';

// ============================================================
// HELPERS
// ============================================================

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function makeSample(overrides: Partial<StrikeIVSample> = {}): StrikeIVSample {
  return {
    ts: '2026-04-27T14:00:00Z',
    ivBid: 0.18,
    ivMid: 0.2,
    ivAsk: 0.22,
    ...overrides,
  } as StrikeIVSample;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================
// StrikeIVChart
// ============================================================

describe('StrikeIVChart', () => {
  it('renders the loading state while the fetch is in flight', () => {
    fetchMock.mockReturnValue(new Promise(() => {})); // never resolves
    render(
      <StrikeIVChart
        ticker="SPXW"
        strike={5800}
        side="call"
        expiry="2026-04-30"
        detectedAt="2026-04-27T14:00:00Z"
      />,
    );
    expect(screen.getByText(/Loading IV history/)).toBeInTheDocument();
  });

  it('builds the request URL from the props', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ticker: 'SPXW',
        strike: 5800,
        side: 'call',
        expiry: '2026-04-30',
        samples: [
          makeSample({ ts: '2026-04-27T14:00:00Z' }),
          makeSample({ ts: '2026-04-27T14:01:00Z' }),
        ],
      }),
    );
    render(
      <StrikeIVChart
        ticker="SPXW"
        strike={5800}
        side="call"
        expiry="2026-04-30"
        detectedAt="2026-04-27T14:00:30Z"
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/api/iv-anomalies?');
    expect(url).toContain('ticker=SPXW');
    expect(url).toContain('strike=5800');
    expect(url).toContain('side=call');
    expect(url).toContain('expiry=2026-04-30');
    expect(url).toContain('limit=240');
  });

  it('renders an error message when the API responds non-OK', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500));
    render(
      <StrikeIVChart
        ticker="SPXW"
        strike={5800}
        side="call"
        expiry="2026-04-30"
        detectedAt="2026-04-27T14:00:00Z"
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/IV history error/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/History API error 500/)).toBeInTheDocument();
  });

  it('renders an error message when the fetch rejects', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    render(
      <StrikeIVChart
        ticker="SPXW"
        strike={5800}
        side="call"
        expiry="2026-04-30"
        detectedAt="2026-04-27T14:00:00Z"
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/network down/)).toBeInTheDocument(),
    );
  });

  it('renders an "Insufficient IV history" message when fewer than 2 samples are returned', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ticker: 'SPXW',
        strike: 5800,
        side: 'call',
        expiry: '2026-04-30',
        samples: [makeSample()],
      }),
    );
    render(
      <StrikeIVChart
        ticker="SPXW"
        strike={5800}
        side="call"
        expiry="2026-04-30"
        detectedAt="2026-04-27T14:00:00Z"
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/Insufficient IV history/)).toBeInTheDocument(),
    );
  });

  it('renders the chart body with three polylines (bid/mid/ask) when there are 2+ samples', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ticker: 'SPXW',
        strike: 5800,
        side: 'call',
        expiry: '2026-04-30',
        samples: [
          makeSample({ ts: '2026-04-27T14:00:00Z' }),
          makeSample({
            ts: '2026-04-27T14:05:00Z',
            ivBid: 0.21,
            ivMid: 0.23,
            ivAsk: 0.25,
          }),
        ],
      }),
    );
    const { container } = render(
      <StrikeIVChart
        ticker="SPXW"
        strike={5800}
        side="call"
        expiry="2026-04-30"
        detectedAt="2026-04-27T14:02:30Z"
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(container.querySelector('svg')).toBeInTheDocument(),
    );
    expect(container.querySelectorAll('polyline')).toHaveLength(3);
  });

  it('renders the detection vertical reference line when detectedAt falls inside the sample range', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ticker: 'SPXW',
        strike: 5800,
        side: 'call',
        expiry: '2026-04-30',
        samples: [
          makeSample({ ts: '2026-04-27T14:00:00Z' }),
          makeSample({ ts: '2026-04-27T14:10:00Z' }),
        ],
      }),
    );
    const { container } = render(
      <StrikeIVChart
        ticker="SPXW"
        strike={5800}
        side="call"
        expiry="2026-04-30"
        detectedAt="2026-04-27T14:05:00Z"
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(container.querySelector('svg')).toBeInTheDocument(),
    );
    // The detection ref line carries a <title> with the timestamp.
    const titleEl = container.querySelector('line title');
    expect(titleEl?.textContent).toMatch(/Detected @ 2026-04-27T14:05:00Z/);
  });

  it('omits the detection reference line when detectedAt falls outside the sample range', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ticker: 'SPXW',
        strike: 5800,
        side: 'call',
        expiry: '2026-04-30',
        samples: [
          makeSample({ ts: '2026-04-27T14:00:00Z' }),
          makeSample({ ts: '2026-04-27T14:10:00Z' }),
        ],
      }),
    );
    const { container } = render(
      <StrikeIVChart
        ticker="SPXW"
        strike={5800}
        side="call"
        expiry="2026-04-30"
        detectedAt="2026-04-27T20:00:00Z" // way after maxT
      />,
    );
    await waitFor(() =>
      expect(container.querySelector('svg')).toBeInTheDocument(),
    );
    expect(container.querySelector('line title')).toBeNull();
  });

  it('renders the IV range as percentage labels on the Y axis', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ticker: 'SPXW',
        strike: 5800,
        side: 'call',
        expiry: '2026-04-30',
        samples: [
          makeSample({
            ts: '2026-04-27T14:00:00Z',
            ivMid: 0.2,
            ivBid: 0.18,
            ivAsk: 0.22,
          }),
          makeSample({
            ts: '2026-04-27T14:05:00Z',
            ivMid: 0.3,
            ivBid: 0.28,
            ivAsk: 0.32,
          }),
        ],
      }),
    );
    render(
      <StrikeIVChart
        ticker="SPXW"
        strike={5800}
        side="call"
        expiry="2026-04-30"
        detectedAt="2026-04-27T14:02:30Z"
      />,
    );
    // Bounds: minIV=0.18-pad, maxIV=0.32+pad with pad = (0.32-0.18)*0.1 = 0.014
    // → 0.166 to 0.334 → "16.6%" to "33.4%"
    await waitFor(() => expect(screen.getByText(/16\.6%/)).toBeInTheDocument());
    expect(screen.getByText(/33\.4%/)).toBeInTheDocument();
  });

  it('skips null IV values inside the polyline (does not crash on partial data)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ticker: 'SPXW',
        strike: 5800,
        side: 'call',
        expiry: '2026-04-30',
        samples: [
          makeSample({
            ts: '2026-04-27T14:00:00Z',
            ivBid: null,
            ivMid: 0.2,
            ivAsk: 0.22,
          } as unknown as StrikeIVSample),
          makeSample({ ts: '2026-04-27T14:05:00Z' }),
        ],
      }),
    );
    const { container } = render(
      <StrikeIVChart
        ticker="SPXW"
        strike={5800}
        side="call"
        expiry="2026-04-30"
        detectedAt="2026-04-27T14:02:30Z"
      />,
    );
    await waitFor(() =>
      expect(container.querySelector('svg')).toBeInTheDocument(),
    );
    // Bid polyline still renders (one valid point) — but no NaN points.
    const polylines = container.querySelectorAll('polyline');
    expect(polylines.length).toBeGreaterThan(0);
    for (const p of polylines) {
      expect(p.getAttribute('points') ?? '').not.toContain('NaN');
    }
  });

  it('renders the bid/mid/ask/detected legend captions', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ticker: 'SPXW',
        strike: 5800,
        side: 'call',
        expiry: '2026-04-30',
        samples: [
          makeSample({ ts: '2026-04-27T14:00:00Z' }),
          makeSample({ ts: '2026-04-27T14:05:00Z' }),
        ],
      }),
    );
    render(
      <StrikeIVChart
        ticker="SPXW"
        strike={5800}
        side="call"
        expiry="2026-04-30"
        detectedAt="2026-04-27T14:02:30Z"
      />,
    );
    await waitFor(() => expect(screen.getByText('bid')).toBeInTheDocument());
    expect(screen.getByText('mid')).toBeInTheDocument();
    expect(screen.getByText('ask')).toBeInTheDocument();
    expect(screen.getByText('detected')).toBeInTheDocument();
  });
});
