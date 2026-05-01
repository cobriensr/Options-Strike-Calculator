/**
 * History list panel for past Periscope reads + debriefs.
 *
 * Fetches /api/periscope-chat-list (paginated by id-desc cursor),
 * renders compact rows, lets the user open one for full detail
 * inline, and supports clicking parent breadcrumbs (debrief →
 * underlying read).
 *
 * Pagination: load-more button uses the `nextBefore` cursor returned
 * by the list endpoint. No infinite scroll for now — explicit click
 * keeps pagination predictable on a manual-capture cadence (the user
 * will rarely have hundreds of rows).
 */

import { useCallback, useEffect, useState } from 'react';
import { SectionBox } from '../ui/SectionBox';
import PeriscopeChatDetail from './PeriscopeChatDetail.js';
import { PERISCOPE_DEBRIEF_EVENT } from './PeriscopeChat.js';
import { fmtTradingDate } from './format-utils.js';

/**
 * Dispatch a window event the chat panel listens for. We use a
 * window event rather than prop drilling / context because the two
 * panels are siblings lazy-loaded under separate Suspense boundaries
 * — lifting state to App.tsx would couple their lazy chunks.
 */
function emitStartDebrief(parentId: number) {
  window.dispatchEvent(
    new CustomEvent(PERISCOPE_DEBRIEF_EVENT, { detail: { parentId } }),
  );
  // Scroll the chat panel into view so the user sees the prefilled
  // form. Best-effort — silently no-ops if the anchor isn't in DOM.
  document
    .getElementById('sec-periscope-chat')
    ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

interface PeriscopeChatSummary {
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

interface ListResponse {
  items: PeriscopeChatSummary[];
  nextBefore: number | null;
}

const PAGE_SIZE = 20;

function fmtNum(n: number | null): string {
  return n == null
    ? '—'
    : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** "3h ago" / "5m ago" / "just now" — relative time of capture. */
function fmtRelative(iso: string): string {
  try {
    const t = new Date(iso).getTime();
    const diffMs = Date.now() - t;
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

/** Format duration_ms as "12s" / "2m 30s" — used to show analysis cost. */
function fmtDuration(ms: number | null): string | null {
  if (ms == null || ms <= 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Tailwind classes for each regime tag — chosen to evoke the trade
 * thesis quickly. Pin = blue (suppressive equilibrium), drift-and-cap
 * = emerald (mechanical drift), gap-and-rip = amber (vol expansion up),
 * trap = red (failed move), cone-breach = purple (vol extension),
 * chop = slate (no thesis), other = neutral.
 */
const REGIME_STYLES: Record<string, string> = {
  pin: 'bg-blue-900/40 text-blue-300',
  'drift-and-cap': 'bg-emerald-900/40 text-emerald-300',
  'gap-and-rip': 'bg-amber-900/40 text-amber-300',
  trap: 'bg-red-900/40 text-red-300',
  'cone-breach': 'bg-purple-900/40 text-purple-300',
  chop: 'bg-slate-800/60 text-slate-300',
  other: 'bg-slate-800/60 text-slate-300',
};

function regimeStyle(tag: string | null): string {
  if (!tag) return 'bg-slate-800/60 text-slate-300';
  return REGIME_STYLES[tag] ?? 'bg-slate-800/60 text-slate-300';
}

/**
 * Subtle mode-tinted background applied to the row card. Mirrors the
 * pattern in src/components/ChartAnalysis/AnalysisHistoryItem.tsx —
 * gives the row immediate visual identity without shouting.
 */
function modeTint(mode: 'read' | 'debrief'): string {
  return mode === 'debrief'
    ? 'border-purple-900/40 bg-purple-950/10'
    : 'border-emerald-900/30 bg-emerald-950/10';
}

export default function PeriscopeChatHistory() {
  const [items, setItems] = useState<PeriscopeChatSummary[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openRowId, setOpenRowId] = useState<number | null>(null);
  // Local override for annotations after a server-side update — the
  // detail view reports the persisted values back here so the list
  // row reflects new stars / regime without a refetch.
  const [annotationOverrides, setAnnotationOverrides] = useState<
    Record<
      number,
      { calibration_quality: number | null; regime_tag: string | null }
    >
  >({});

  const fetchPage = useCallback(
    async (before: number | null, signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (before != null) params.set('before', String(before));
        const res = await fetch(
          `/api/periscope-chat-list?${params.toString()}`,
          { signal },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as ListResponse;
        setItems((prev) =>
          before == null ? data.items : [...prev, ...data.items],
        );
        setNextBefore(data.nextBefore);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    const ac = new AbortController();
    void fetchPage(null, ac.signal);
    return () => ac.abort();
  }, [fetchPage]);

  const handleAnnotated = useCallback(
    (
      rowId: number,
      next: { calibration_quality: number | null; regime_tag: string | null },
    ) => {
      setAnnotationOverrides((prev) => ({ ...prev, [rowId]: next }));
    },
    [],
  );

  const merged = items.map((item) => {
    const override = annotationOverrides[item.id];
    return override ? { ...item, ...override } : item;
  });

  return (
    <SectionBox
      label="Periscope History"
      badge={items.length > 0 ? `${items.length} loaded` : null}
      collapsible
      defaultCollapsed={true}
    >
      <div className="flex flex-col gap-3">
        {error && (
          <div
            role="alert"
            className="rounded-md border border-red-700/60 bg-red-950/30 p-2 text-xs text-red-300"
          >
            {error}
          </div>
        )}

        {merged.length === 0 && !loading && !error && (
          <p className="text-muted text-xs">
            No saved analyses yet. Submit a read or debrief above to start
            building history.
          </p>
        )}

        <ul className="flex flex-col gap-2">
          {merged.map((item) => (
            <li
              key={item.id}
              className={`overflow-hidden rounded-lg border ${modeTint(item.mode)}`}
            >
              <div className="flex items-stretch">
                <button
                  type="button"
                  onClick={() =>
                    setOpenRowId((prev) => (prev === item.id ? null : item.id))
                  }
                  aria-expanded={openRowId === item.id}
                  className="hover:bg-surface/30 flex flex-1 flex-col gap-1.5 p-3 text-left transition focus:ring-1 focus:ring-[var(--color-accent)] focus:outline-none"
                >
                  {/* Row 1 — identity + spot */}
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span
                      className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wide uppercase ${
                        item.mode === 'debrief'
                          ? 'bg-purple-900/50 text-purple-200'
                          : 'bg-emerald-900/50 text-emerald-200'
                      }`}
                    >
                      {item.mode}
                    </span>
                    <span className="text-primary font-mono text-xs font-semibold">
                      {fmtTradingDate(item.trading_date)}
                    </span>
                    {item.regime_tag && (
                      <span
                        className={`rounded-full px-2 py-0.5 font-mono text-[10px] ${regimeStyle(item.regime_tag)}`}
                      >
                        {item.regime_tag}
                      </span>
                    )}
                    {item.calibration_quality != null &&
                      item.calibration_quality > 0 && (
                        <span
                          className="text-yellow-400"
                          title={`${item.calibration_quality}/5 stars`}
                        >
                          {'★'.repeat(item.calibration_quality)}
                        </span>
                      )}
                    <span className="text-muted ml-auto flex items-baseline gap-1.5 font-mono text-xs">
                      <span className="text-[10px] uppercase">spot</span>
                      <span className="text-primary text-sm font-semibold">
                        {fmtNum(item.spot)}
                      </span>
                    </span>
                  </div>

                  {/* Row 2 — triggers + linkage + meta */}
                  <div className="text-muted flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10px]">
                    {item.long_trigger != null && (
                      <span>
                        <span className="text-emerald-400">▲</span> long{' '}
                        <span className="text-secondary">
                          {fmtNum(item.long_trigger)}
                        </span>
                      </span>
                    )}
                    {item.short_trigger != null && (
                      <span>
                        <span className="text-red-400">▼</span> short{' '}
                        <span className="text-secondary">
                          {fmtNum(item.short_trigger)}
                        </span>
                      </span>
                    )}
                    {item.parent_id != null && (
                      <span className="text-purple-300">
                        ↳ debrief of #{item.parent_id}
                      </span>
                    )}
                    <span className="ml-auto flex items-center gap-2">
                      {fmtDuration(item.duration_ms) && (
                        <span>{fmtDuration(item.duration_ms)}</span>
                      )}
                      <span>{fmtRelative(item.captured_at)}</span>
                      <span className="text-[9px] opacity-60">#{item.id}</span>
                    </span>
                  </div>

                  {/* Row 3 — prose excerpt */}
                  {item.prose_excerpt && (
                    <p className="text-secondary line-clamp-3 text-xs leading-relaxed">
                      {item.prose_excerpt}
                    </p>
                  )}
                </button>
                {item.mode === 'read' && (
                  <button
                    type="button"
                    onClick={() => emitStartDebrief(item.id)}
                    className="border-edge text-secondary hover:bg-surface/40 hover:text-primary flex shrink-0 items-center border-l px-3 text-xs font-medium transition focus:ring-1 focus:ring-[var(--color-accent)] focus:outline-none"
                    title={`Start a debrief linked to read #${item.id}`}
                  >
                    Debrief →
                  </button>
                )}
              </div>

              {openRowId === item.id && (
                <div className="border-edge border-t p-2">
                  <PeriscopeChatDetail
                    rowId={item.id}
                    onClose={() => setOpenRowId(null)}
                    onSelectParent={(parentId) => setOpenRowId(parentId)}
                    onAnnotated={handleAnnotated}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>

        <div className="flex items-center justify-between text-xs">
          {nextBefore != null ? (
            <button
              type="button"
              onClick={() => void fetchPage(nextBefore)}
              disabled={loading}
              className="border-edge text-secondary hover:text-primary rounded-md border px-3 py-1 transition disabled:opacity-50"
            >
              {loading ? 'Loading…' : 'Load more'}
            </button>
          ) : (
            <span className="text-muted">{loading ? 'Loading…' : ''}</span>
          )}
          <button
            type="button"
            onClick={() => {
              setItems([]);
              setNextBefore(null);
              setAnnotationOverrides({});
              void fetchPage(null);
            }}
            disabled={loading}
            className="text-muted hover:text-primary disabled:opacity-50"
          >
            Refresh
          </button>
        </div>
      </div>
    </SectionBox>
  );
}
