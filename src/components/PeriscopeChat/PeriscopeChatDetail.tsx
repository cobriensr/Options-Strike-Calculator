/**
 * Detail view for a single Periscope read or debrief.
 *
 * Fetched from /api/periscope-chat-detail?id=N. Shows the prose,
 * structured fields (spot, cone bounds, triggers, regime), the
 * uploaded screenshots inline, parent-link breadcrumb (debriefs link
 * to their open read), Anthropic call metadata, and inline calibration
 * + regime-tag editing via PeriscopeChatAnnotations.
 *
 * Used inside PeriscopeChatHistory when a row is opened. The
 * onClose/onSelectParent callbacks let the parent control navigation
 * without this component owning the list state.
 */

import { useCallback, useEffect, useState } from 'react';
import PeriscopeChatAnnotations from './PeriscopeChatAnnotations.js';

interface PeriscopeImageEntry {
  kind: string;
  url: string;
}

interface PeriscopeChatDetailRow {
  id: number;
  trading_date: string;
  captured_at: string;
  mode: 'read' | 'debrief';
  parent_id: number | null;
  user_context: string | null;
  prose_text: string;
  spot: number | null;
  cone_lower: number | null;
  cone_upper: number | null;
  long_trigger: number | null;
  short_trigger: number | null;
  regime_tag: string | null;
  calibration_quality: number | null;
  image_urls: PeriscopeImageEntry[];
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  duration_ms: number | null;
  created_at: string;
}

interface PeriscopeChatDetailProps {
  rowId: number;
  onClose: () => void;
  onSelectParent: (parentId: number) => void;
  /** Called when annotations save successfully — parent updates its list cache. */
  onAnnotated?: (
    rowId: number,
    next: { calibration_quality: number | null; regime_tag: string | null },
  ) => void;
}

function fmtNum(n: number | null): string {
  if (n == null) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function PeriscopeChatDetail({
  rowId,
  onClose,
  onSelectParent,
  onAnnotated,
}: PeriscopeChatDetailProps) {
  const [row, setRow] = useState<PeriscopeChatDetailRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/periscope-chat-detail?id=${rowId}`, { signal: ac.signal })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return (await res.json()) as PeriscopeChatDetailRow;
      })
      .then((data) => {
        setRow(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Failed to load');
        setLoading(false);
      });
    return () => ac.abort();
  }, [rowId]);

  const handleAnnotated = useCallback(
    (next: {
      id: number;
      calibration_quality: number | null;
      regime_tag: string | null;
    }) => {
      setRow((prev) =>
        prev
          ? {
              ...prev,
              calibration_quality: next.calibration_quality,
              regime_tag: next.regime_tag,
            }
          : prev,
      );
      onAnnotated?.(next.id, {
        calibration_quality: next.calibration_quality,
        regime_tag: next.regime_tag,
      });
    },
    [onAnnotated],
  );

  if (loading) {
    return (
      <div className="border-edge bg-surface/40 text-muted rounded-md border p-4 text-xs">
        Loading detail…
      </div>
    );
  }
  if (error) {
    return (
      <div
        role="alert"
        className="rounded-md border border-red-700/60 bg-red-950/30 p-3 text-xs text-red-300"
      >
        {error}
        <button
          type="button"
          onClick={onClose}
          className="ml-3 underline hover:text-red-200"
        >
          Close
        </button>
      </div>
    );
  }
  if (!row) return null;

  // Capture parent_id once so the JSX click handler doesn't need a
  // non-null assertion (the narrowing inside the `if` widens out
  // when it crosses the JSX boundary).
  const parentId = row.parent_id;

  const triggerRows: Array<{ label: string; value: string }> = [
    { label: 'Spot', value: fmtNum(row.spot) },
    {
      label: 'Cone',
      value:
        row.cone_lower == null && row.cone_upper == null
          ? '—'
          : `${fmtNum(row.cone_lower)} – ${fmtNum(row.cone_upper)}`,
    },
    { label: 'Long trigger', value: fmtNum(row.long_trigger) },
    { label: 'Short trigger', value: fmtNum(row.short_trigger) },
    { label: 'Regime', value: row.regime_tag ?? '—' },
  ];

  return (
    <div className="border-edge bg-surface/40 flex flex-col gap-3 rounded-md border p-3">
      {/* Header row */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
        <span className="text-primary text-sm font-semibold">
          #{row.id} · {row.mode === 'debrief' ? 'Debrief' : 'Read'}
        </span>
        <span className="text-muted">{fmtTime(row.captured_at)}</span>
        <span className="text-muted">trading day {row.trading_date}</span>
        {parentId != null && (
          <button
            type="button"
            onClick={() => onSelectParent(parentId)}
            className="text-[var(--color-accent)] underline hover:opacity-80"
          >
            ← parent #{parentId}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="text-muted hover:text-primary ml-auto text-xs"
          aria-label="Close detail view"
        >
          ✕ Close
        </button>
      </div>

      {/* Structured fields */}
      <div className="border-edge bg-surface/60 grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border p-3 text-sm sm:grid-cols-5">
        {triggerRows.map((r) => (
          <div key={r.label} className="flex flex-col">
            <span className="text-muted text-[10px] tracking-wide uppercase">
              {r.label}
            </span>
            <span className="text-primary font-mono">{r.value}</span>
          </div>
        ))}
      </div>

      {/* User context if any */}
      {row.user_context && (
        <div className="text-secondary border-edge bg-surface/30 rounded-md border p-2 text-xs italic">
          User context: {row.user_context}
        </div>
      )}

      {/* Prose */}
      <div className="text-primary border-edge bg-surface/40 rounded-md border p-3 text-sm whitespace-pre-wrap">
        {row.prose_text}
      </div>

      {/* Image gallery */}
      {row.image_urls.length > 0 && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {row.image_urls.map((img) => (
            <figure
              key={img.kind}
              className="border-edge bg-surface/30 flex flex-col gap-1 rounded-md border p-2"
            >
              <figcaption className="text-muted text-[10px] tracking-wide uppercase">
                {img.kind}
              </figcaption>
              <a
                href={img.url}
                target="_blank"
                rel="noopener noreferrer"
                title="Open full size"
              >
                <img
                  src={img.url}
                  alt={`${img.kind} screenshot`}
                  className="max-h-48 w-full rounded object-contain"
                />
              </a>
            </figure>
          ))}
        </div>
      )}

      {/* Annotations */}
      <PeriscopeChatAnnotations
        rowId={row.id}
        calibrationQuality={row.calibration_quality}
        regimeTag={row.regime_tag}
        onSaved={handleAnnotated}
      />

      {/* Metadata footer */}
      <div className="text-muted flex flex-wrap gap-x-4 gap-y-1 text-[10px]">
        <span>model: {row.model}</span>
        <span>
          tokens: {row.input_tokens ?? '?'} in / {row.output_tokens ?? '?'} out
        </span>
        <span>
          cache: {row.cache_read_tokens ?? 0} read /{' '}
          {row.cache_write_tokens ?? 0} write
        </span>
        {row.duration_ms != null && (
          <span>duration: {Math.round(row.duration_ms / 100) / 10}s</span>
        )}
      </div>
    </div>
  );
}
