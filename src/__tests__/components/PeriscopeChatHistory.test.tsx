import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';

// Stub SectionBox so its `defaultCollapsed` doesn't hide our content
// from the tests. We're testing the panel's data flow, not the
// collapse animation — that's covered in SectionBox's own tests.
vi.mock('../../components/ui/SectionBox', () => ({
  SectionBox: ({ children }: { children: ReactNode }) => (
    <section>{children}</section>
  ),
}));

import PeriscopeChatHistory from '../../components/PeriscopeChat/PeriscopeChatHistory';
import PeriscopeChatDetail from '../../components/PeriscopeChat/PeriscopeChatDetail';
import PeriscopeChatAnnotations from '../../components/PeriscopeChat/PeriscopeChatAnnotations';

// ============================================================
// Fixtures + helpers
// ============================================================

interface ListItem {
  id: number;
  trading_date: string;
  captured_at: string;
  mode: 'read' | 'debrief';
  parent_id: number | null;
  spot: number | null;
  long_trigger: number | null;
  short_trigger: number | null;
  regime_tag: string | null;
  calibration_quality: number | null;
  prose_excerpt: string;
  duration_ms: number | null;
}

function makeListItem(overrides: Partial<ListItem> = {}): ListItem {
  return {
    id: 1,
    trading_date: '2026-04-30',
    captured_at: '2026-04-30T13:30:00Z',
    mode: 'read',
    parent_id: null,
    spot: 7120,
    long_trigger: 7125,
    short_trigger: 7115,
    regime_tag: null,
    calibration_quality: null,
    prose_excerpt: 'A short read excerpt for testing.',
    duration_ms: 4500,
    ...overrides,
  };
}

const detailFixture = {
  id: 42,
  trading_date: '2026-04-30',
  captured_at: '2026-04-30T13:30:00Z',
  mode: 'read' as const,
  parent_id: null,
  user_context: 'morning open',
  prose_text: 'Pin day at 7120. Floor at 7100.',
  spot: 7120,
  cone_lower: 7095,
  cone_upper: 7150,
  long_trigger: 7125,
  short_trigger: 7115,
  regime_tag: null,
  calibration_quality: null,
  image_urls: [{ kind: 'chart', url: 'https://b/c.png' }],
  model: 'claude-opus-4-7',
  input_tokens: 1000,
  output_tokens: 500,
  cache_read_tokens: 800,
  cache_write_tokens: 0,
  duration_ms: 4500,
  created_at: '2026-04-30T13:30:05Z',
};

/**
 * Routes mock fetch responses by URL pattern. Each call to
 * setRoutes() replaces the route map. Routes return either a
 * function (so the test can assert on the request) or a static body.
 */
function setRoutes(
  routes: Record<
    string,
    | { status?: number; body: unknown }
    | ((init?: RequestInit) => {
        status?: number;
        body: unknown;
      })
  >,
) {
  globalThis.fetch = vi.fn(async (url: RequestInfo, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : (url as Request).url;
    for (const [pattern, handler] of Object.entries(routes)) {
      if (u.includes(pattern)) {
        const resolved =
          typeof handler === 'function' ? handler(init) : handler;
        const status = resolved.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => resolved.body,
          text: async () =>
            typeof resolved.body === 'string'
              ? resolved.body
              : JSON.stringify(resolved.body),
        } as unknown as Response;
      }
    }
    throw new Error(`Unmatched route: ${u}`);
  }) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ============================================================
// PeriscopeChatHistory
// ============================================================

/**
 * Routes the orchestrator hits on mount + when the date selection
 * changes. The dates endpoint is the picker's source of truth; the
 * date-filtered endpoint returns the rows for the selected day.
 */
function setStandardRoutes(args: {
  dates: Array<{ date: string; total: number; reads: number; debriefs: number }>;
  rowsByDate: Record<string, ListItem[]>;
}) {
  setRoutes({
    '/api/periscope-chat-list?dates=true': {
      body: { dates: args.dates },
    },
    '/api/periscope-chat-list?date=': () => {
      const urlString = String(
        (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
          .at(-1)?.[0] ?? '',
      );
      const match = /date=(\d{4}-\d{2}-\d{2})/.exec(urlString);
      const date = match?.[1] ?? '';
      return { body: { items: args.rowsByDate[date] ?? [] } };
    },
  });
}

describe('<PeriscopeChatHistory />', () => {
  it('fetches dates on mount + rows for the most recent date', async () => {
    setStandardRoutes({
      dates: [
        { date: '2026-04-30', total: 2, reads: 1, debriefs: 1 },
        { date: '2026-04-29', total: 1, reads: 1, debriefs: 0 },
      ],
      rowsByDate: {
        '2026-04-30': [
          makeListItem({ id: 5, prose_excerpt: 'First read of the day.' }),
          makeListItem({
            id: 4,
            mode: 'debrief',
            parent_id: 3,
            prose_excerpt: 'Long fired at 11:15 AM.',
          }),
        ],
      },
    });

    render(<PeriscopeChatHistory />);

    await waitFor(() => {
      expect(screen.getByText('First read of the day.')).toBeInTheDocument();
    });
    expect(screen.getByText('Long fired at 11:15 AM.')).toBeInTheDocument();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('shows empty state when no dates exist', async () => {
    setStandardRoutes({ dates: [], rowsByDate: {} });

    render(<PeriscopeChatHistory />);

    await waitFor(() => {
      expect(screen.getByText(/no saved analyses yet/i)).toBeInTheDocument();
    });
  });

  it('surfaces an error when the dates endpoint fails', async () => {
    setRoutes({
      '/api/periscope-chat-list?dates=true': {
        status: 500,
        body: { error: 'Internal error' },
      },
    });

    render(<PeriscopeChatHistory />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/failed to load/i);
    });
  });

  it('dispatches a window event with parentId when Debrief is clicked on a read row', async () => {
    setStandardRoutes({
      dates: [{ date: '2026-04-30', total: 2, reads: 1, debriefs: 1 }],
      rowsByDate: {
        '2026-04-30': [
          makeListItem({ id: 5, mode: 'read', prose_excerpt: 'Read 5 prose.' }),
          makeListItem({
            id: 4,
            mode: 'debrief',
            parent_id: 5,
            prose_excerpt: 'Debrief 4 prose.',
          }),
        ],
      },
    });
    const user = userEvent.setup();
    const listener = vi.fn();
    window.addEventListener('periscope:start-debrief', listener);

    render(<PeriscopeChatHistory />);
    await waitFor(() => {
      expect(screen.getByText('Read 5 prose.')).toBeInTheDocument();
    });

    // Read rows have a Debrief button; debrief rows do not.
    const debriefButtons = screen.queryAllByRole('button', {
      name: /^debrief →$/i,
    });
    expect(debriefButtons).toHaveLength(1); // only on the read row
    await user.click(debriefButtons[0]!);

    expect(listener).toHaveBeenCalledOnce();
    const event = listener.mock.calls[0]![0] as CustomEvent<{
      parentId: number;
    }>;
    expect(event.detail.parentId).toBe(5);

    window.removeEventListener('periscope:start-debrief', listener);
  });

  it('filters rows when a mode tab is clicked', async () => {
    setStandardRoutes({
      dates: [{ date: '2026-04-30', total: 2, reads: 1, debriefs: 1 }],
      rowsByDate: {
        '2026-04-30': [
          makeListItem({ id: 5, mode: 'read', prose_excerpt: 'Read row.' }),
          makeListItem({
            id: 4,
            mode: 'debrief',
            parent_id: 5,
            prose_excerpt: 'Debrief row.',
          }),
        ],
      },
    });
    const user = userEvent.setup();

    render(<PeriscopeChatHistory />);
    await waitFor(() => {
      expect(screen.getByText('Read row.')).toBeInTheDocument();
    });
    expect(screen.getByText('Debrief row.')).toBeInTheDocument();

    // Click the Reads tab — only the read row should remain.
    await user.click(screen.getByRole('button', { name: /^reads$/i }));
    expect(screen.getByText('Read row.')).toBeInTheDocument();
    expect(screen.queryByText('Debrief row.')).not.toBeInTheDocument();
  });
});

// ============================================================
// PeriscopeChatDetail
// ============================================================

describe('<PeriscopeChatDetail />', () => {
  it('fetches the row and renders prose, structured fields, and images', async () => {
    setRoutes({
      '/api/periscope-chat-detail': { body: detailFixture },
    });

    render(
      <PeriscopeChatDetail
        rowId={42}
        onClose={vi.fn()}
        onSelectParent={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/pin day at 7120/i)).toBeInTheDocument();
    });
    // Spot value in structured grid
    expect(screen.getByText('7,120')).toBeInTheDocument();
    // Image
    const img = screen.getByAltText(/chart screenshot/i);
    expect(img).toHaveAttribute('src', 'https://b/c.png');
    // User context
    expect(screen.getByText(/morning open/i)).toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', async () => {
    const user = userEvent.setup();
    setRoutes({
      '/api/periscope-chat-detail': { body: detailFixture },
    });
    const onClose = vi.fn();

    render(
      <PeriscopeChatDetail
        rowId={42}
        onClose={onClose}
        onSelectParent={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText(/close detail view/i)).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText(/close detail view/i));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows parent breadcrumb and fires onSelectParent', async () => {
    const user = userEvent.setup();
    setRoutes({
      '/api/periscope-chat-detail': {
        body: { ...detailFixture, parent_id: 7, mode: 'debrief' },
      },
    });
    const onSelectParent = vi.fn();

    render(
      <PeriscopeChatDetail
        rowId={42}
        onClose={vi.fn()}
        onSelectParent={onSelectParent}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/parent #7/i)).toBeInTheDocument();
    });
    await user.click(screen.getByText(/parent #7/i));
    expect(onSelectParent).toHaveBeenCalledWith(7);
  });

  it('shows an error when detail fetch fails', async () => {
    setRoutes({
      '/api/periscope-chat-detail': {
        status: 404,
        body: { error: 'Read not found' },
      },
    });

    render(
      <PeriscopeChatDetail
        rowId={999}
        onClose={vi.fn()}
        onSelectParent={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/read not found/i);
    });
  });
});

// ============================================================
// PeriscopeChatAnnotations
// ============================================================

describe('<PeriscopeChatAnnotations />', () => {
  it('renders 5 stars and the regime dropdown', () => {
    render(
      <PeriscopeChatAnnotations
        rowId={1}
        calibrationQuality={null}
        regimeTag={null}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getAllByRole('radio')).toHaveLength(5);
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('PATCHes calibration_quality on star click and reports persisted value', async () => {
    const user = userEvent.setup();
    setRoutes({
      '/api/periscope-chat-update': (init) => {
        const body = JSON.parse(String((init?.body ?? '{}') as string)) as {
          calibration_quality: number;
        };
        expect(init?.method).toBe('PATCH');
        expect(body.calibration_quality).toBe(4);
        return {
          body: { id: 1, calibration_quality: 4, regime_tag: null },
        };
      },
    });
    const onSaved = vi.fn();

    render(
      <PeriscopeChatAnnotations
        rowId={1}
        calibrationQuality={null}
        regimeTag={null}
        onSaved={onSaved}
      />,
    );

    const fourthStar = screen.getByLabelText('4 stars');
    await user.click(fourthStar);

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith({
        id: 1,
        calibration_quality: 4,
        regime_tag: null,
      });
    });
  });

  it('PATCHes regime_tag on dropdown change', async () => {
    const user = userEvent.setup();
    setRoutes({
      '/api/periscope-chat-update': (init) => {
        const body = JSON.parse(String((init?.body ?? '{}') as string)) as {
          regime_tag: string;
        };
        expect(body.regime_tag).toBe('pin');
        return {
          body: { id: 1, calibration_quality: null, regime_tag: 'pin' },
        };
      },
    });
    const onSaved = vi.fn();

    render(
      <PeriscopeChatAnnotations
        rowId={1}
        calibrationQuality={null}
        regimeTag={null}
        onSaved={onSaved}
      />,
    );

    await user.selectOptions(screen.getByRole('combobox'), 'pin');

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith({
        id: 1,
        calibration_quality: null,
        regime_tag: 'pin',
      });
    });
  });

  it('hides the (unset) option once a regime tag is set', () => {
    render(
      <PeriscopeChatAnnotations
        rowId={1}
        calibrationQuality={null}
        regimeTag="pin"
        onSaved={vi.fn()}
      />,
    );

    const select = screen.getByRole('combobox');
    const optionTexts = Array.from(select.querySelectorAll('option')).map(
      (o) => o.textContent,
    );
    expect(optionTexts).not.toContain('(unset)');
    expect(optionTexts).toContain('pin');
  });

  it('shows a clear button when a regime tag is set, hidden otherwise', () => {
    const { rerender } = render(
      <PeriscopeChatAnnotations
        rowId={1}
        calibrationQuality={null}
        regimeTag={null}
        onSaved={vi.fn()}
      />,
    );
    expect(
      screen.queryByLabelText(/clear regime tag/i),
    ).not.toBeInTheDocument();

    rerender(
      <PeriscopeChatAnnotations
        rowId={1}
        calibrationQuality={null}
        regimeTag="pin"
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/clear regime tag/i)).toBeInTheDocument();
  });

  it('PATCHes a clear directive when the regime clear button is clicked', async () => {
    const user = userEvent.setup();
    setRoutes({
      '/api/periscope-chat-update': (init) => {
        const body = JSON.parse(String((init?.body ?? '{}') as string)) as {
          clear: string[];
        };
        expect(body.clear).toEqual(['regime_tag']);
        return {
          body: { id: 1, calibration_quality: null, regime_tag: null },
        };
      },
    });
    const onSaved = vi.fn();

    render(
      <PeriscopeChatAnnotations
        rowId={1}
        calibrationQuality={null}
        regimeTag="pin"
        onSaved={onSaved}
      />,
    );

    await user.click(screen.getByLabelText(/clear regime tag/i));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith({
        id: 1,
        calibration_quality: null,
        regime_tag: null,
      });
    });
  });

  it('shows an error when the update endpoint fails', async () => {
    const user = userEvent.setup();
    setRoutes({
      '/api/periscope-chat-update': {
        status: 500,
        body: { error: 'Internal error' },
      },
    });

    render(
      <PeriscopeChatAnnotations
        rowId={1}
        calibrationQuality={null}
        regimeTag={null}
        onSaved={vi.fn()}
      />,
    );

    await user.click(screen.getByLabelText('5 stars'));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/internal error/i);
    });
  });

  it('renders filled stars matching calibrationQuality prop', () => {
    render(
      <PeriscopeChatAnnotations
        rowId={1}
        calibrationQuality={3}
        regimeTag={null}
        onSaved={vi.fn()}
      />,
    );

    // Each star button shows ★ when filled, ☆ when empty.
    const stars = screen.getAllByRole('radio');
    expect(stars[0]!.textContent).toBe('★');
    expect(stars[1]!.textContent).toBe('★');
    expect(stars[2]!.textContent).toBe('★');
    expect(stars[3]!.textContent).toBe('☆');
    expect(stars[4]!.textContent).toBe('☆');
  });
});
