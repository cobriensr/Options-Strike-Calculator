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

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
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

        <ul className="flex flex-col gap-1">
          {merged.map((item) => (
            <li
              key={item.id}
              className="border-edge bg-surface/40 rounded-md border"
            >
              <button
                type="button"
                onClick={() =>
                  setOpenRowId((prev) => (prev === item.id ? null : item.id))
                }
                aria-expanded={openRowId === item.id}
                className="hover:bg-surface/60 flex w-full flex-col gap-0.5 p-2 text-left transition focus:ring-1 focus:ring-[var(--color-accent)] focus:outline-none"
              >
                <div className="flex flex-wrap items-baseline gap-x-3 text-xs">
                  <span className="text-primary font-mono">#{item.id}</span>
                  <span
                    className={`rounded px-1.5 py-0 text-[10px] tracking-wide uppercase ${
                      item.mode === 'debrief'
                        ? 'bg-purple-900/40 text-purple-300'
                        : 'bg-emerald-900/40 text-emerald-300'
                    }`}
                  >
                    {item.mode}
                  </span>
                  <span className="text-muted">
                    {fmtTime(item.captured_at)}
                  </span>
                  {item.regime_tag && (
                    <span className="text-secondary font-mono">
                      {item.regime_tag}
                    </span>
                  )}
                  {item.calibration_quality != null && (
                    <span className="text-yellow-400">
                      {'★'.repeat(item.calibration_quality)}
                      {'☆'.repeat(5 - item.calibration_quality)}
                    </span>
                  )}
                  <span className="text-muted ml-auto font-mono">
                    spot {fmtNum(item.spot)}
                  </span>
                </div>
                {item.prose_excerpt && (
                  <p className="text-muted line-clamp-2 text-xs">
                    {item.prose_excerpt}
                  </p>
                )}
              </button>

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
