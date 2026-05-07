/**
 * LessonLibrary — review surface for the curate-periscope-lessons cron.
 *
 * The cron (api/cron/curate-periscope-lessons.ts) writes candidate
 * lessons extracted from past debriefs to `periscope_lessons` with
 * `status='proposed'`. Active rows get injected into the cached
 * references block on every periscope-chat call, so the user wants a
 * dashboard surface to triage candidates rather than running raw
 * UPDATE statements against the DB.
 *
 * Three tabs (Proposed / Active / Archived) filter the list. Each row
 * shows the lesson text, its citation count + source debrief count, a
 * relative timestamp tied to the row's lifecycle event, and one or
 * more action buttons:
 *
 *   - proposed → Promote, Archive
 *   - active   → Archive
 *   - archived → Unarchive
 *
 * Action click flow: optimistic local state update → POST → on success
 * refetch the canonical list (so any cross-tab moves and timestamp
 * updates from the server land cleanly) → on error roll back.
 *
 * Pattern parity with PeriscopeChatHistory.tsx — same SectionBox,
 * same mode-tab tinting, same fmtRelative + fetch-error display.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { SectionBox } from '../ui/SectionBox';
import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils.js';
import type { PeriscopeLessonRow } from './types.js';

// ============================================================
// Filter tabs
// ============================================================

type StatusTab = 'proposed' | 'active' | 'archived';

const STATUS_TABS: Array<{ key: StatusTab; label: string }> = [
  { key: 'proposed', label: 'Proposed' },
  { key: 'active', label: 'Active' },
  { key: 'archived', label: 'Archived' },
];

/** Per-tab tint color. Sky for proposed (candidates), emerald for active
 * (in use), slate for archived (parked). Mirrors the row badge palette
 * below so the active tab visually matches the rows it filters to. */
function tabColor(tab: StatusTab): string {
  if (tab === 'proposed') return '#38BDF8'; // sky-400
  if (tab === 'active') return '#34D399'; // emerald-400
  return '#94A3B8'; // slate-400
}

// ============================================================
// Status badge
// ============================================================

const STATUS_BADGE_STYLES: Record<StatusTab, string> = {
  proposed: 'bg-sky-900/50 text-sky-200',
  active: 'bg-emerald-900/50 text-emerald-200',
  archived: 'bg-slate-800/60 text-slate-300',
};

function statusBadge(status: StatusTab): string {
  return STATUS_BADGE_STYLES[status];
}

// ============================================================
// Relative timestamp
// ============================================================

/** "3h ago" / "5m ago" — relative timestamp; falls back to a date. */
function fmtRelative(iso: string): string {
  try {
    const t = new Date(iso).getTime();
    const diffMs = Date.now() - t;
    if (diffMs < 0) {
      return new Date(iso).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      });
    }
    const min = Math.floor(diffMs / 60_000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}d ago`;
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

/** Pick the lifecycle-relevant timestamp + verb for a row. */
function lifecycleLabel(lesson: PeriscopeLessonRow): string {
  if (lesson.status === 'active' && lesson.promoted_at != null) {
    return `promoted ${fmtRelative(lesson.promoted_at)}`;
  }
  if (lesson.status === 'archived' && lesson.archived_at != null) {
    return `archived ${fmtRelative(lesson.archived_at)}`;
  }
  return `proposed ${fmtRelative(lesson.created_at)}`;
}

// ============================================================
// Empty-state copy
// ============================================================

const EMPTY_STATE_COPY: Record<StatusTab, string> = {
  proposed:
    'No candidate lessons yet. The cron writes here every Sunday night.',
  active:
    'No active lessons being injected into reads. Promote a proposed one to start.',
  archived: 'Nothing archived yet.',
};

// ============================================================
// Component
// ============================================================

type Action = 'promote' | 'archive' | 'unarchive';

export default function LessonLibrary() {
  const [lessons, setLessons] = useState<PeriscopeLessonRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<StatusTab>('proposed');
  // Refetch tick — bumped after a successful action so we pick up the
  // canonical server-side ordering + timestamps. Optimistic local
  // updates handle the visual response between click and refetch.
  const [refreshTick, setRefreshTick] = useState(0);
  // Per-row pending action — disables the row's buttons mid-flight to
  // prevent double-clicks racing the same lesson.
  const [pending, setPending] = useState<Record<number, Action>>({});

  // Fetch the canonical lessons list on mount + after every successful
  // action.
  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const url =
          refreshTick === 0
            ? '/api/periscope-lessons-list'
            : `/api/periscope-lessons-list?_=${refreshTick}`;
        const res = await fetch(url, { signal: ac.signal });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as { lessons: PeriscopeLessonRow[] };
        if (ac.signal.aborted) return;
        setLessons(data.lessons);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Failed to load lessons');
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [refreshTick]);

  // Apply the active filter tab. Memoized so unrelated state changes
  // (loading flag, pending map) don't re-filter.
  const filtered = useMemo(
    () => lessons.filter((l) => l.status === tab),
    [lessons, tab],
  );

  const handleAction = useCallback(
    async (lesson: PeriscopeLessonRow, action: Action) => {
      setPending((p) => ({ ...p, [lesson.id]: action }));
      // Optimistic local update — flip the row's status immediately so
      // the row moves to the right tab without waiting for the network.
      // Rolled back below on error.
      const previous = lessons;
      const optimisticStatus: PeriscopeLessonRow['status'] =
        action === 'promote'
          ? 'active'
          : action === 'archive'
            ? 'archived'
            : 'proposed';
      setLessons((prev) =>
        prev.map((l) =>
          l.id === lesson.id ? { ...l, status: optimisticStatus } : l,
        ),
      );

      try {
        const res = await fetch('/api/periscope-lessons-update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: lesson.id, action }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        // Trigger a refetch so the canonical timestamps + status land.
        setRefreshTick((t) => t + 1);
      } catch (err) {
        // Roll back the optimistic update + surface the error.
        setLessons(previous);
        setError(err instanceof Error ? err.message : 'Action failed');
      } finally {
        setPending((p) => {
          const next = { ...p };
          delete next[lesson.id];
          return next;
        });
      }
    },
    [lessons],
  );

  // Per-status counts power the tab badges so the user can see at a
  // glance how much triage work is queued without switching tabs.
  const counts = useMemo(() => {
    const result: Record<StatusTab, number> = {
      proposed: 0,
      active: 0,
      archived: 0,
    };
    for (const l of lessons) result[l.status] += 1;
    return result;
  }, [lessons]);

  return (
    <SectionBox
      label="Periscope Lesson Library"
      badge={lessons.length > 0 ? `${lessons.length} total` : null}
      collapsible
      defaultCollapsed={true}
    >
      <div className="flex flex-col gap-3">
        {/* Status tab filter */}
        <div className="flex flex-wrap gap-1.5">
          {STATUS_TABS.map(({ key, label }) => {
            const active = tab === key;
            const color = tabColor(key);
            const count = counts[key];
            return (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className="cursor-pointer rounded-full px-3 py-1.5 font-mono text-[10px] font-semibold transition-all duration-100"
                style={{
                  backgroundColor: active ? tint(color, '15') : 'transparent',
                  color: active ? color : theme.textMuted,
                  border: `1.5px solid ${active ? color + '40' : theme.border}`,
                }}
                aria-pressed={active}
              >
                {label} ({count})
              </button>
            );
          })}
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-md border border-red-700/60 bg-red-950/30 p-2 text-xs text-red-300"
          >
            {error}
          </div>
        )}

        {loading && lessons.length === 0 && (
          <p className="text-muted text-xs">Loading…</p>
        )}

        {!loading && filtered.length === 0 && (
          <p className="text-muted text-xs">{EMPTY_STATE_COPY[tab]}</p>
        )}

        <ul className="flex flex-col gap-2">
          {filtered.map((lesson) => {
            const rowPending = pending[lesson.id];
            const isPending = rowPending != null;
            return (
              <li
                key={lesson.id}
                className="border-edge bg-surface/30 flex flex-col gap-2 rounded-lg border p-3"
              >
                {/* Header — status badge + meta */}
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span
                    className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wide uppercase ${statusBadge(
                      lesson.status,
                    )}`}
                  >
                    {lesson.status}
                  </span>
                  <span className="text-muted font-mono text-[10px]">
                    cited {lesson.citation_count}x
                  </span>
                  <span className="text-muted font-mono text-[10px]">
                    {lesson.source_ids.length} source
                    {lesson.source_ids.length === 1 ? '' : 's'}
                  </span>
                  <span className="text-muted ml-auto font-mono text-[10px]">
                    {lifecycleLabel(lesson)}
                  </span>
                  <span className="text-muted font-mono text-[9px] opacity-60">
                    #{lesson.id}
                  </span>
                </div>

                {/* Lesson text — pre-line so embedded newlines render */}
                <p className="text-secondary text-xs leading-relaxed whitespace-pre-line">
                  {lesson.lesson_text}
                </p>

                {/* Action buttons */}
                <div className="flex flex-wrap gap-1.5">
                  {lesson.status === 'proposed' && (
                    <>
                      <button
                        type="button"
                        onClick={() => handleAction(lesson, 'promote')}
                        disabled={isPending}
                        className="cursor-pointer rounded-md border border-emerald-700/60 bg-emerald-950/30 px-3 py-1 font-mono text-[10px] font-semibold text-emerald-200 transition hover:bg-emerald-900/40 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {rowPending === 'promote' ? 'Promoting…' : 'Promote'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleAction(lesson, 'archive')}
                        disabled={isPending}
                        className="cursor-pointer rounded-md border border-slate-700/60 bg-slate-800/40 px-3 py-1 font-mono text-[10px] font-semibold text-slate-200 transition hover:bg-slate-700/40 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {rowPending === 'archive' ? 'Archiving…' : 'Archive'}
                      </button>
                    </>
                  )}
                  {lesson.status === 'active' && (
                    <button
                      type="button"
                      onClick={() => handleAction(lesson, 'archive')}
                      disabled={isPending}
                      className="cursor-pointer rounded-md border border-slate-700/60 bg-slate-800/40 px-3 py-1 font-mono text-[10px] font-semibold text-slate-200 transition hover:bg-slate-700/40 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {rowPending === 'archive' ? 'Archiving…' : 'Archive'}
                    </button>
                  )}
                  {lesson.status === 'archived' && (
                    <button
                      type="button"
                      onClick={() => handleAction(lesson, 'unarchive')}
                      disabled={isPending}
                      className="cursor-pointer rounded-md border border-sky-700/60 bg-sky-950/30 px-3 py-1 font-mono text-[10px] font-semibold text-sky-200 transition hover:bg-sky-900/40 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {rowPending === 'unarchive'
                        ? 'Unarchiving…'
                        : 'Unarchive'}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </SectionBox>
  );
}
