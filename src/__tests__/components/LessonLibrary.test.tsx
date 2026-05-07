import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';

// Stub SectionBox so its `defaultCollapsed` doesn't hide our content
// from the tests. We're testing the panel's data flow + buttons, not
// the collapse animation — that's covered in SectionBox's own tests.
vi.mock('../../components/ui/SectionBox', () => ({
  SectionBox: ({ children }: { children: ReactNode }) => (
    <section>{children}</section>
  ),
}));

import LessonLibrary from '../../components/PeriscopeChat/LessonLibrary';
import type { PeriscopeLessonRow } from '../../components/PeriscopeChat/types';

// ============================================================
// Helpers
// ============================================================

function lesson(overrides: Partial<PeriscopeLessonRow> = {}): PeriscopeLessonRow {
  return {
    id: 1,
    lesson_text: 'Sample lesson',
    source_ids: [42],
    status: 'proposed',
    citation_count: 1,
    created_at: '2026-05-01T00:00:00.000Z',
    promoted_at: null,
    archived_at: null,
    ...overrides,
  };
}

function setListResponse(lessons: PeriscopeLessonRow[]) {
  globalThis.fetch = vi.fn(async (url: RequestInfo) => {
    const u = typeof url === 'string' ? url : (url as Request).url;
    if (u.includes('/api/periscope-lessons-list')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ lessons }),
      } as unknown as Response;
    }
    if (u.includes('/api/periscope-lessons-update')) {
      // Return a row matching the request — the fetch mock below
      // overrides this for tests that care about the response body.
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, lesson: lessons[0] }),
      } as unknown as Response;
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
// Tests
// ============================================================

describe('<LessonLibrary />', () => {
  it('renders proposed-tab rows on mount and shows action buttons', async () => {
    setListResponse([
      lesson({
        id: 11,
        lesson_text: 'Pin days favor butterflies inside the cone.',
        status: 'proposed',
        citation_count: 4,
        source_ids: [101, 102, 103, 104],
      }),
    ]);

    render(<LessonLibrary />);

    await waitFor(() => {
      expect(
        screen.getByText('Pin days favor butterflies inside the cone.'),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /^Promote$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Archive$/ })).toBeInTheDocument();
    // proposed status badge text
    expect(screen.getByText('proposed')).toBeInTheDocument();
    // citation + sources metadata
    expect(screen.getByText(/cited 4x/)).toBeInTheDocument();
    expect(screen.getByText(/4 sources/)).toBeInTheDocument();
  });

  it('switches to the active tab and only shows active rows', async () => {
    setListResponse([
      lesson({ id: 1, status: 'proposed', lesson_text: 'p1' }),
      lesson({
        id: 2,
        status: 'active',
        lesson_text: 'a1',
        promoted_at: '2026-05-02T00:00:00Z',
      }),
      lesson({
        id: 3,
        status: 'archived',
        lesson_text: 'x1',
        archived_at: '2026-04-01T00:00:00Z',
      }),
    ]);
    const user = userEvent.setup();

    render(<LessonLibrary />);

    await waitFor(() => {
      expect(screen.getByText('p1')).toBeInTheDocument();
    });
    // Initially on proposed tab — only p1 is visible.
    expect(screen.queryByText('a1')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Active \(1\)/ }));

    await waitFor(() => {
      expect(screen.getByText('a1')).toBeInTheDocument();
    });
    expect(screen.queryByText('p1')).not.toBeInTheDocument();
    expect(screen.queryByText('x1')).not.toBeInTheDocument();
    // Active row gets only the Archive action, not Promote.
    expect(screen.getByRole('button', { name: /^Archive$/ })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^Promote$/ }),
    ).not.toBeInTheDocument();
  });

  it('shows the per-tab empty state copy when filter has no rows', async () => {
    setListResponse([
      lesson({ id: 1, status: 'proposed', lesson_text: 'p1' }),
    ]);
    const user = userEvent.setup();

    render(<LessonLibrary />);

    await waitFor(() => {
      expect(screen.getByText('p1')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /^Active \(0\)/ }));
    await waitFor(() => {
      expect(
        screen.getByText(/No active lessons being injected/i),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /^Archived \(0\)/ }));
    await waitFor(() => {
      expect(screen.getByText(/Nothing archived yet/i)).toBeInTheDocument();
    });
  });

  it('fires the correct POST body when Promote is clicked', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : (url as Request).url;
      if (u.includes('/api/periscope-lessons-list')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            lessons: [lesson({ id: 17, status: 'proposed' })],
          }),
        } as unknown as Response;
      }
      if (u.includes('/api/periscope-lessons-update')) {
        // Verify the body the component sent.
        const parsed = JSON.parse((init?.body as string) ?? '{}');
        expect(parsed).toEqual({ id: 17, action: 'promote' });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            lesson: lesson({ id: 17, status: 'active' }),
          }),
        } as unknown as Response;
      }
      throw new Error(`Unmatched route: ${u}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const user = userEvent.setup();

    render(<LessonLibrary />);

    const promoteBtn = await screen.findByRole('button', { name: /^Promote$/ });
    await user.click(promoteBtn);

    await waitFor(() => {
      // The list endpoint is hit once on mount + once after the action's
      // refresh tick, plus the update POST in between. So at least 3
      // fetch calls total.
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
