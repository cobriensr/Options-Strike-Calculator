/**
 * LessonLibrary × malformed /api/periscope-lessons-list payloads —
 * crash regression.
 *
 * Unlike LessonLibrary.test.tsx (happy paths), this file feeds the REAL
 * component shapeless/garbage bodies through a mocked `fetch`, because
 * the production crash lived at the parse seam:
 *
 *   const data = (await res.json()) as { lessons: PeriscopeLessonRow[] };
 *   setLessons(data.lessons); // {} → undefined → lessons.filter throws
 *
 * A `{}` body (5xx JSON blob, loosely-parsed HTML error page) put
 * `undefined` into `lessons` state, and the next render threw straight
 * into the section ErrorBoundary.
 *
 * Contract under test: on a malformed payload the panel settles into its
 * normal per-tab empty state with ZERO console errors; malformed rows
 * inside a valid envelope are dropped, never fatal.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { MockInstance } from 'vitest';
import type { ReactNode } from 'react';

// Stub SectionBox so its `defaultCollapsed` doesn't hide our content
// from the tests (same stub as LessonLibrary.test.tsx).
vi.mock('../../components/ui/SectionBox', () => ({
  SectionBox: ({ children }: { children: ReactNode }) => (
    <section>{children}</section>
  ),
}));

import LessonLibrary from '../../components/PeriscopeChat/LessonLibrary';

// ============================================================
// Fixtures + helpers
// ============================================================

const validLesson = {
  id: 11,
  lesson_text: 'Pin days favor butterflies inside the cone.',
  source_ids: [101, 102],
  status: 'proposed',
  citation_count: 4,
  created_at: '2026-05-01T00:00:00.000Z',
  promoted_at: null,
  archived_at: null,
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubListResponse(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse(body)),
  );
}

describe('<LessonLibrary /> — malformed payloads', () => {
  let consoleErrorSpy: MockInstance;

  beforeEach(() => {
    consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('settles into the empty state on a shapeless {} payload', async () => {
    stubListResponse({});

    render(<LessonLibrary />);

    await waitFor(() => {
      expect(screen.getByText(/no candidate lessons yet/i)).toBeInTheDocument();
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('settles into the empty state on a garbage string payload', async () => {
    stubListResponse('<html>Internal Server Error</html>');

    render(<LessonLibrary />);

    await waitFor(() => {
      expect(screen.getByText(/no candidate lessons yet/i)).toBeInTheDocument();
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('drops malformed lesson rows and keeps the valid ones', async () => {
    stubListResponse({
      lessons: [
        validLesson,
        null,
        'junk',
        { id: 12 }, // missing everything else
        { ...validLesson, id: 13, status: 'bogus' }, // unknown status
        { ...validLesson, id: 14, lesson_text: 42 }, // non-string text
        { ...validLesson, id: 15, source_ids: 'nope' }, // non-array sources
      ],
    });

    render(<LessonLibrary />);

    await waitFor(() => {
      expect(
        screen.getByText('Pin days favor butterflies inside the cone.'),
      ).toBeInTheDocument();
    });
    // Tab badges count only the surviving row.
    expect(
      screen.getByRole('button', { name: /^Proposed \(1\)/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^Active \(0\)/ }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
