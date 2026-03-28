import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PreMarketInput from '../../components/PreMarketInput';

describe('PreMarketInput', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: null }),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Rendering ─────────────────────────────────────────────

  it('renders all input fields', () => {
    render(<PreMarketInput date="2026-03-28" />);

    expect(screen.getByLabelText(/Globex High/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Globex Low/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Globex Close/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Globex VWAP/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Cone Upper/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Cone Lower/)).toBeInTheDocument();
  });

  it('renders Save button initially', () => {
    render(<PreMarketInput date="2026-03-28" />);
    expect(screen.getByRole('button', { name: /Save/i })).toBeInTheDocument();
  });

  it('renders Pre-Market section heading', () => {
    render(<PreMarketInput date="2026-03-28" />);
    expect(screen.getByText('Pre-Market')).toBeInTheDocument();
  });

  // ── Loading existing data ─────────────────────────────────

  it('loads existing pre-market data on mount', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            globexHigh: 5720,
            globexLow: 5690,
            globexClose: 5710,
            globexVwap: 5705,
            straddleConeUpper: 5760,
            straddleConeLower: 5660,
            savedAt: '2026-03-28T12:00:00Z',
          },
        }),
    });

    render(<PreMarketInput date="2026-03-28" />);

    await waitFor(() => {
      expect(screen.getByLabelText(/Globex High/)).toHaveValue('5720');
      expect(screen.getByLabelText(/Globex Low/)).toHaveValue('5690');
      expect(screen.getByLabelText(/Globex Close/)).toHaveValue('5710');
      expect(screen.getByLabelText(/Globex VWAP/)).toHaveValue('5705');
      expect(screen.getByLabelText(/Cone Upper/)).toHaveValue('5760');
      expect(screen.getByLabelText(/Cone Lower/)).toHaveValue('5660');
    });

    // Should show Update button when data was loaded (savedAt present)
    expect(screen.getByRole('button', { name: /Update/i })).toBeInTheDocument();
  });

  it('fetches with correct date param', async () => {
    render(<PreMarketInput date="2026-03-28" apiBase="/test" />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/test/api/pre-market?date=2026-03-28',
      );
    });
  });

  it('handles fetch error gracefully', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network error'));

    render(<PreMarketInput date="2026-03-28" />);

    // Should not crash — inputs should still be empty
    await waitFor(() => {
      expect(screen.getByLabelText(/Globex High/)).toHaveValue('');
    });
  });

  it('handles non-ok response gracefully', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false });

    render(<PreMarketInput date="2026-03-28" />);

    await waitFor(() => {
      expect(screen.getByLabelText(/Globex High/)).toHaveValue('');
    });
  });

  // ── Validation ────────────────────────────────────────────

  it('shows error when required fields are empty', async () => {
    const user = userEvent.setup();
    render(<PreMarketInput date="2026-03-28" />);

    await user.click(screen.getByRole('button', { name: /Save/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/Globex High, Low, and Close are required/),
      ).toBeInTheDocument();
    });
  });

  it('shows error when high < low', async () => {
    const user = userEvent.setup();
    render(<PreMarketInput date="2026-03-28" />);

    await user.type(screen.getByLabelText(/Globex High/), '5690');
    await user.type(screen.getByLabelText(/Globex Low/), '5720');
    await user.type(screen.getByLabelText(/Globex Close/), '5710');

    await user.click(screen.getByRole('button', { name: /Save/i }));

    await waitFor(() => {
      expect(screen.getByText(/Globex High must be/)).toBeInTheDocument();
    });
  });

  // ── Saving ────────────────────────────────────────────────

  it('saves data and calls onSave callback', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(<PreMarketInput date="2026-03-28" onSave={onSave} />);

    // Wait for initial load
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // POST response
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ saved: true }),
    });

    await user.type(screen.getByLabelText(/Globex High/), '5720');
    await user.type(screen.getByLabelText(/Globex Low/), '5690');
    await user.type(screen.getByLabelText(/Globex Close/), '5710');

    await user.click(screen.getByRole('button', { name: /Save/i }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          globexHigh: 5720,
          globexLow: 5690,
          globexClose: 5710,
        }),
      );
    });

    // Button should switch to Update
    expect(screen.getByRole('button', { name: /Update/i })).toBeInTheDocument();
  });

  it('shows error on failed POST', async () => {
    const user = userEvent.setup();
    render(<PreMarketInput date="2026-03-28" />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'DB write failed' }),
    });

    await user.type(screen.getByLabelText(/Globex High/), '5720');
    await user.type(screen.getByLabelText(/Globex Low/), '5690');
    await user.type(screen.getByLabelText(/Globex Close/), '5710');

    await user.click(screen.getByRole('button', { name: /Save/i }));

    await waitFor(() => {
      expect(screen.getByText('DB write failed')).toBeInTheDocument();
    });
  });

  it('shows generic error on POST network failure', async () => {
    const user = userEvent.setup();
    render(<PreMarketInput date="2026-03-28" />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    fetchMock.mockRejectedValueOnce(new Error('Network error'));

    await user.type(screen.getByLabelText(/Globex High/), '5720');
    await user.type(screen.getByLabelText(/Globex Low/), '5690');
    await user.type(screen.getByLabelText(/Globex Close/), '5710');

    await user.click(screen.getByRole('button', { name: /Save/i }));

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });

  it('handles non-Error throws on save', async () => {
    const user = userEvent.setup();
    render(<PreMarketInput date="2026-03-28" />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    fetchMock.mockRejectedValueOnce('string error');

    await user.type(screen.getByLabelText(/Globex High/), '5720');
    await user.type(screen.getByLabelText(/Globex Low/), '5690');
    await user.type(screen.getByLabelText(/Globex Close/), '5710');

    await user.click(screen.getByRole('button', { name: /Save/i }));

    await waitFor(() => {
      expect(screen.getByText('Save failed')).toBeInTheDocument();
    });
  });

  // ── Gap preview ───────────────────────────────────────────

  it('shows gap preview when globexClose and prevClose are provided', async () => {
    const user = userEvent.setup();
    render(<PreMarketInput date="2026-03-28" prevClose={5700} />);

    await user.type(screen.getByLabelText(/Globex Close/), '5720');

    await waitFor(() => {
      expect(screen.getByText('+20.0')).toBeInTheDocument();
      expect(screen.getByText('UP')).toBeInTheDocument();
    });
  });

  it('shows gap preview using spxPrice when prevClose is not set', async () => {
    const user = userEvent.setup();
    render(<PreMarketInput date="2026-03-28" spxPrice={5700} />);

    await user.type(screen.getByLabelText(/Globex Close/), '5680');

    await waitFor(() => {
      expect(screen.getByText('-20.0')).toBeInTheDocument();
      expect(screen.getByText('DOWN')).toBeInTheDocument();
    });
  });

  // ── Overnight range preview ───────────────────────────────

  it('shows overnight range when high and low are entered', async () => {
    const user = userEvent.setup();
    render(<PreMarketInput date="2026-03-28" />);

    await user.type(screen.getByLabelText(/Globex High/), '5720');
    await user.type(screen.getByLabelText(/Globex Low/), '5690');

    await waitFor(() => {
      expect(screen.getByText('30.0 pts')).toBeInTheDocument();
    });
  });

  it('shows overnight range with cone percentage', async () => {
    const user = userEvent.setup();
    render(<PreMarketInput date="2026-03-28" />);

    await user.type(screen.getByLabelText(/Globex High/), '5720');
    await user.type(screen.getByLabelText(/Globex Low/), '5690');
    await user.type(screen.getByLabelText(/Cone Upper/), '5750');
    await user.type(screen.getByLabelText(/Cone Lower/), '5650');

    await waitFor(() => {
      expect(screen.getByText('30.0 pts (30% of cone)')).toBeInTheDocument();
    });
  });

  // ── Input typing ──────────────────────────────────────────

  it('allows typing in all fields', async () => {
    const user = userEvent.setup();
    render(<PreMarketInput date="2026-03-28" />);

    await user.type(screen.getByLabelText(/Globex High/), '5720.50');
    await user.type(screen.getByLabelText(/Globex Low/), '5690.25');
    await user.type(screen.getByLabelText(/Globex Close/), '5710.75');
    await user.type(screen.getByLabelText(/Globex VWAP/), '5705.00');
    await user.type(screen.getByLabelText(/Cone Upper/), '5760');
    await user.type(screen.getByLabelText(/Cone Lower/), '5650');

    expect(screen.getByLabelText(/Globex High/)).toHaveValue('5720.50');
    expect(screen.getByLabelText(/Globex Low/)).toHaveValue('5690.25');
    expect(screen.getByLabelText(/Globex Close/)).toHaveValue('5710.75');
    expect(screen.getByLabelText(/Globex VWAP/)).toHaveValue('5705.00');
    expect(screen.getByLabelText(/Cone Upper/)).toHaveValue('5760');
    expect(screen.getByLabelText(/Cone Lower/)).toHaveValue('5650');
  });
});
