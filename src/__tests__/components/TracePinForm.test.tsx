import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from '@testing-library/react';
import TracePinForm from '../../components/ml-insights/TracePinForm';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makePrediction(overrides = {}) {
  return {
    date: '2026-01-15',
    predicted_close: 5900,
    confidence: 'high' as const,
    notes: null,
    actual_close: 5920.5,
    current_price: 5880,
    vix: null,
    vix1d: null,
    ...overrides,
  };
}

function mockFetch(responses: Array<Response | object>) {
  let call = 0;
  return vi.fn().mockImplementation(() => {
    const r = responses[call] ?? responses.at(-1)!;
    call++;
    if (r instanceof Response) return Promise.resolve(r);
    // plain object shorthand: { ok, json?, text? }
    const opts = r as { ok: boolean; json?: unknown };
    return Promise.resolve({
      ok: opts.ok,
      json: () => Promise.resolve(opts.json ?? {}),
    });
  });
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // Default: empty predictions list on mount
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }),
  );
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('TracePinForm: rendering', () => {
  it('renders the form heading', async () => {
    await act(async () => {
      render(<TracePinForm />);
    });
    expect(screen.getByText(/log trace pin prediction/i)).toBeInTheDocument();
  });

  it('renders date, predicted close, and confidence inputs', async () => {
    await act(async () => {
      render(<TracePinForm />);
    });
    expect(screen.getByLabelText(/date/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/predicted close/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confidence/i)).toBeInTheDocument();
  });

  it('renders the Save button', async () => {
    await act(async () => {
      render(<TracePinForm />);
    });
    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
  });

  it('renders the Refresh Actuals button', async () => {
    await act(async () => {
      render(<TracePinForm />);
    });
    expect(
      screen.getByRole('button', { name: /refresh actuals/i }),
    ).toBeInTheDocument();
  });

  it('shows "No predictions yet." when list is empty', async () => {
    await act(async () => {
      render(<TracePinForm />);
    });
    expect(screen.getByText(/no predictions yet/i)).toBeInTheDocument();
  });

  it('disables Save button when predicted close is empty', async () => {
    await act(async () => {
      render(<TracePinForm />);
    });
    const btn = screen.getByRole('button', { name: /save/i });
    expect(btn).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Predictions table
// ---------------------------------------------------------------------------

describe('TracePinForm: predictions table', () => {
  it('renders a row for each prediction', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([
            makePrediction({ date: '2026-01-15' }),
            makePrediction({
              date: '2026-01-14',
              actual_close: null,
              current_price: null,
            }),
          ]),
      }),
    );

    await act(async () => {
      render(<TracePinForm />);
    });

    expect(screen.getByText('2026-01-15')).toBeInTheDocument();
    expect(screen.getByText('2026-01-14')).toBeInTheDocument();
  });

  it('shows — for missing actual_close', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([
            makePrediction({ actual_close: null, current_price: null }),
          ]),
      }),
    );

    await act(async () => {
      render(<TracePinForm />);
    });

    // Error and Actual cells should both show —
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });

  it('shows a positive error in green when actual > predicted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([
            makePrediction({
              predicted_close: 5900,
              actual_close: 5920,
              current_price: 5880,
            }),
          ]),
      }),
    );

    await act(async () => {
      render(<TracePinForm />);
    });

    expect(screen.getByText('+20.0')).toBeInTheDocument();
  });

  it('shows a negative error when actual < predicted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([
            makePrediction({
              predicted_close: 5950,
              actual_close: 5920,
              current_price: 5880,
            }),
          ]),
      }),
    );

    await act(async () => {
      render(<TracePinForm />);
    });

    expect(screen.getByText('-30.0')).toBeInTheDocument();
  });

  it('renders a delete button for each row', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([makePrediction()]),
      }),
    );

    await act(async () => {
      render(<TracePinForm />);
    });

    expect(
      screen.getByRole('button', { name: /delete prediction for 2026-01-15/i }),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Form submission
// ---------------------------------------------------------------------------

describe('TracePinForm: form submission', () => {
  it('shows Saved confirmation after a successful POST', async () => {
    const fetchMock = mockFetch([
      { ok: true, json: [] }, // initial GET
      { ok: true, json: {} }, // POST
      { ok: true, json: [] }, // reload GET
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      render(<TracePinForm />);
    });

    fireEvent.change(screen.getByLabelText(/predicted close/i), {
      target: { value: '5900' },
    });
    await act(async () => {
      fireEvent.submit(
        screen.getByRole('button', { name: /save/i }).closest('form')!,
      );
    });

    await waitFor(() => expect(screen.getByText(/saved/i)).toBeInTheDocument());
  });

  it('shows error message on failed POST', async () => {
    const fetchMock = mockFetch([
      { ok: true, json: [] },
      { ok: false, json: { error: 'Save failed' } },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      render(<TracePinForm />);
    });

    fireEvent.change(screen.getByLabelText(/predicted close/i), {
      target: { value: '5900' },
    });
    await act(async () => {
      fireEvent.submit(
        screen.getByRole('button', { name: /save/i }).closest('form')!,
      );
    });

    await waitFor(() =>
      expect(screen.getByText(/save failed/i)).toBeInTheDocument(),
    );
  });

  it('shows "Network error" when fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) })
        .mockRejectedValueOnce(new Error('offline')),
    );

    await act(async () => {
      render(<TracePinForm />);
    });

    fireEvent.change(screen.getByLabelText(/predicted close/i), {
      target: { value: '5900' },
    });
    await act(async () => {
      fireEvent.submit(
        screen.getByRole('button', { name: /save/i }).closest('form')!,
      );
    });

    await waitFor(() =>
      expect(screen.getByText(/network error/i)).toBeInTheDocument(),
    );
  });
});

// ---------------------------------------------------------------------------
// Overwrite confirmation
// ---------------------------------------------------------------------------

describe('TracePinForm: overwrite confirmation', () => {
  it('shows Overwrite and Cancel buttons when date already exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([makePrediction({ date: '2026-01-15' })]),
      }),
    );

    await act(async () => {
      render(<TracePinForm />);
    });

    // Set the date input to the existing date
    fireEvent.change(screen.getByLabelText(/date/i), {
      target: { value: '2026-01-15' },
    });
    fireEvent.change(screen.getByLabelText(/predicted close/i), {
      target: { value: '5910' },
    });

    // First submit triggers overwrite confirm
    await act(async () => {
      fireEvent.submit(
        screen.getByRole('button', { name: /save/i }).closest('form')!,
      );
    });

    expect(
      screen.getByRole('button', { name: /overwrite/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });

  it('clears the confirm state when Cancel is clicked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([makePrediction({ date: '2026-01-15' })]),
      }),
    );

    await act(async () => {
      render(<TracePinForm />);
    });

    fireEvent.change(screen.getByLabelText(/date/i), {
      target: { value: '2026-01-15' },
    });
    fireEvent.change(screen.getByLabelText(/predicted close/i), {
      target: { value: '5910' },
    });

    await act(async () => {
      fireEvent.submit(
        screen.getByRole('button', { name: /save/i }).closest('form')!,
      );
    });

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    // Back to normal Save button
    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /overwrite/i }),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Refresh Actuals
// ---------------------------------------------------------------------------

describe('TracePinForm: refresh actuals', () => {
  it('calls the refresh endpoint and reloads predictions', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) }) // initial GET
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) }) // POST refresh
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) }); // reload GET
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      render(<TracePinForm />);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /refresh actuals/i }));
    });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/trace/refresh-actuals',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe('TracePinForm: delete row', () => {
  it('calls the DELETE endpoint and reloads predictions', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([makePrediction()]),
      }) // initial GET
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) }) // DELETE
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) }); // reload GET
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      render(<TracePinForm />);
    });

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', {
          name: /delete prediction for 2026-01-15/i,
        }),
      );
    });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/trace/prediction?date=2026-01-15',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
  });
});
