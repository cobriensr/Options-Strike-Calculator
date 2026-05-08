/**
 * State + submission hook for the Periscope Chat panel.
 *
 * Manages: mode (read|debrief), the per-kind staged image map, optional
 * parent_id, and the in-flight / response / error lifecycle for
 * `POST /api/periscope-chat`.
 *
 * Lifts the NDJSON-buffering pattern from `useChartAnalysis`: the
 * endpoint streams `{"ping":true}` keepalive lines + a single final
 * envelope; we `await res.text()` and take the last non-empty line.
 * No incremental rendering — the user sees a spinner until the call
 * completes (Opus can take 5-9 minutes on cold cache, so we surface
 * elapsed time as feedback).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  PeriscopeChatResponse,
  PeriscopeChatSuccess,
  PeriscopeImageKind,
  PeriscopeImageMediaType,
  PeriscopeMode,
  UploadedPeriscopeImage,
} from './types.js';

const ENDPOINT = '/api/periscope-chat';
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB raw — backend enforces too

const ACCEPTED_MEDIA_TYPES: readonly PeriscopeImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];

/**
 * Order in which clipboard-pasted images fill the slots. Matches the
 * user's typical capture sequence: take a Periscope chart screenshot
 * first, then the GEX heat map, then the charm heat map. Paste fills
 * the FIRST empty slot in this order, so removing a slot and pasting
 * replaces it (rather than appending to the end).
 */
const PASTE_FILL_ORDER: readonly PeriscopeImageKind[] = [
  'chart',
  'gex',
  'charm',
];

/** Read a `File` as a base64 string (no `data:` prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Unexpected reader result'));
        return;
      }
      // result is `data:image/png;base64,XXXX` — strip the prefix
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

function isAcceptedMediaType(value: string): value is PeriscopeImageMediaType {
  return ACCEPTED_MEDIA_TYPES.includes(value as PeriscopeImageMediaType);
}

export interface UsePeriscopeChatResult {
  // State
  mode: PeriscopeMode;
  images: Partial<Record<PeriscopeImageKind, UploadedPeriscopeImage>>;
  parentId: number | null;
  /** ISO YYYY-MM-DD the read is FOR. Defaults to today CT. */
  readDate: string;
  /** HH:MM 24-hour CT the read is FOR. Defaults to nearest-floor 10-min. */
  readTime: string;
  inFlight: boolean;
  elapsedMs: number;
  response: PeriscopeChatSuccess | null;
  error: string | null;
  // Setters
  setMode: (next: PeriscopeMode) => void;
  setParentId: (next: number | null) => void;
  setReadDate: (next: string) => void;
  setReadTime: (next: string) => void;
  setImage: (kind: PeriscopeImageKind, file: File | null) => void;
  // Actions
  submit: () => Promise<void>;
  reset: () => void;
}

/** Validate ISO YYYY-MM-DD before sending to the server. */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_PATTERN = /^\d{2}:\d{2}$/;

/** Today's CT calendar date (YYYY-MM-DD). */
function defaultReadDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Current CT wall clock floored to the nearest 10-min boundary, HH:MM. */
function defaultReadTime(): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const hh = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const hourNum = Number.parseInt(hh, 10) % 24;
  const minuteNum = Number.parseInt(mm, 10);
  const flooredMinute = Math.floor(minuteNum / 10) * 10;
  return `${hourNum.toString().padStart(2, '0')}:${flooredMinute.toString().padStart(2, '0')}`;
}

export function usePeriscopeChat(): UsePeriscopeChatResult {
  const [mode, setMode] = useState<PeriscopeMode>('intraday');
  const [images, setImages] = useState<
    Partial<Record<PeriscopeImageKind, UploadedPeriscopeImage>>
  >({});
  const [parentId, setParentId] = useState<number | null>(null);
  const [readDate, setReadDate] = useState<string>(defaultReadDate);
  const [readTime, setReadTime] = useState<string>(defaultReadTime);
  const [inFlight, setInFlight] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [response, setResponse] = useState<PeriscopeChatSuccess | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Track image objects for cleanup. We revoke object URLs on remove and
  // on unmount to avoid leaking blob memory.
  const imagesRef = useRef(images);
  imagesRef.current = images;

  // Tier 2 review fix: track parentId in a ref so the auto-link
  // useEffect can re-check it just before calling setParentId. The
  // effect short-circuits at the top when parentId is non-null, but
  // an in-flight fetch can still resolve AFTER the user (or a window
  // event from PeriscopeChatHistory) sets parentId explicitly — this
  // guard prevents the in-flight resolve from clobbering an explicit
  // choice with the auto-link candidate.
  const parentIdRef = useRef(parentId);
  parentIdRef.current = parentId;

  useEffect(() => {
    return () => {
      // Revoke any preview URLs still mounted at unmount.
      for (const img of Object.values(imagesRef.current)) {
        if (img) URL.revokeObjectURL(img.preview);
      }
    };
  }, []);

  // Tick a 1-second elapsed counter while a submission is in flight so
  // the UI can show "12s elapsed". Stops when inFlight goes false.
  useEffect(() => {
    if (!inFlight) {
      setElapsedMs(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(() => setElapsedMs(Date.now() - start), 1000);
    return () => clearInterval(id);
  }, [inFlight]);

  const setImage = useCallback(
    (kind: PeriscopeImageKind, file: File | null) => {
      // Side effects (URL revoke/create, setError, validation alerts)
      // must NOT live inside the setState updater — React StrictMode
      // invokes updaters twice in dev. So: do all imperative work first
      // against `imagesRef.current` (the latest committed state, even
      // mid-batch), THEN call setImages with a pure functional updater
      // that reads the freshest queued `prev` to handle batched calls.
      const previous = imagesRef.current[kind];

      // Removal
      if (file == null) {
        if (previous) URL.revokeObjectURL(previous.preview);
        setImages((prev) => {
          const next = { ...prev };
          delete next[kind];
          return next;
        });
        return;
      }

      // Validation gates — bail out without touching state on failure.
      if (file.size > MAX_FILE_BYTES) {
        setError(
          `${kind} image is too large (${(file.size / 1024 / 1024).toFixed(1)} MB; max 10 MB).`,
        );
        return;
      }
      if (!isAcceptedMediaType(file.type)) {
        setError(
          `${kind} image type not supported (${file.type || 'unknown'}). Use PNG, JPEG, GIF, or WEBP.`,
        );
        return;
      }

      // Replacement: revoke old URL imperatively (idempotent — fine if
      // StrictMode-double-invokes the setState below). Then pure
      // functional updater applies the swap.
      if (previous) URL.revokeObjectURL(previous.preview);
      const newImage: UploadedPeriscopeImage = {
        kind,
        file,
        preview: URL.createObjectURL(file),
      };
      setImages((prev) => ({ ...prev, [kind]: newImage }));
    },
    [],
  );

  // Auto-link parentId for intraday/debrief modes. The chain semantics
  // (intraday → previous intraday → ... → today's pre_trade; debrief →
  // last intraday → pre_trade) mean the user's intent is always
  // "chain to the most recent forward read on this date." Auto-fetching
  // saves them from a friction step where the submission errors out
  // because parentId starts as null. User can still override by clicking
  // "Debrief →" on a specific row in history (existing window-event
  // path); that path sets parentId via setParentId, which suppresses
  // the auto-link refetch via the `parentId != null` short-circuit.
  //
  // Silent on failure: if the list endpoint errors or returns no
  // forward reads for the date, parentId stays null and the existing
  // submit-time validation surfaces a clear message.
  useEffect(() => {
    if (mode === 'pre_trade') return;
    if (parentId != null) return;
    if (!ISO_DATE_PATTERN.test(readDate)) return;
    const ctrl = new AbortController();
    void (async () => {
      try {
        const res = await fetch(
          `/api/periscope-chat-list?date=${encodeURIComponent(readDate)}&limit=20`,
          { signal: ctrl.signal },
        );
        if (!res.ok) return;
        // periscope-chat-list returns { items, nextBefore } — see
        // api/periscope-chat-list.ts:219. `items` is ordered
        // created_at DESC, so the first forward-mode entry is the
        // most recent valid parent. Skip debriefs (chaining to a
        // debrief is never the intent).
        const body = (await res.json()) as {
          items?: Array<{ id: number; mode: string }>;
        };
        if (!Array.isArray(body.items)) return;
        const candidate = body.items.find(
          (r) => r.mode === 'pre_trade' || r.mode === 'intraday',
        );
        if (candidate && typeof candidate.id === 'number') {
          // Tier 2 review fix: re-check parentIdRef immediately before
          // setting. The mode/parentId top-of-effect guard runs once
          // when the effect mounts; a window event ("Debrief →" from
          // history) firing mid-fetch sets parentId via setParentId,
          // and we must not clobber that explicit choice with the
          // auto-link candidate when the fetch resolves.
          if (parentIdRef.current != null) return;
          setParentId(candidate.id);
        }
      } catch {
        // Aborted or network error — leave parentId null, submit
        // validation surfaces the message.
      }
    })();
    return () => ctrl.abort();
  }, [mode, readDate, parentId]);

  // Document-level paste listener — mirrors the pattern in
  // src/hooks/useImageUpload.ts. Picks the first image in the clipboard
  // payload and routes it to the next empty slot in PASTE_FILL_ORDER.
  // Non-image clipboard content is ignored (text paste into a real
  // textarea continues to work normally).
  //
  // We resolve the next empty slot from `imagesRef.current` rather
  // than a captured `images` value so the handler stays referentially
  // stable across renders without missing fast successive pastes.
  useEffect(() => {
    function handlePaste(e: ClipboardEvent) {
      // Bail when the user is pasting into a real input — only intercept
      // global / non-editable-target pastes for the Periscope slot fill.
      // Without this guard the listener calls preventDefault() on every
      // image clipboard paste anywhere on the page, hijacking pastes
      // intended for journal notes, comment textareas, etc.
      const target = e.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      const items = Array.from(e.clipboardData?.items ?? []);
      const imageItem = items.find((it) => it.type.startsWith('image/'));
      if (!imageItem) return;
      const file = imageItem.getAsFile();
      if (!file) return;
      const current = imagesRef.current;
      const targetKind = PASTE_FILL_ORDER.find((k) => current[k] == null);
      if (!targetKind) return; // all 3 slots full — silent no-op
      e.preventDefault();
      setImage(targetKind, file);
    }
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [setImage]);

  const reset = useCallback(() => {
    // Same purity rule as setImage: revoke imperatively, then setImages({}).
    for (const img of Object.values(imagesRef.current)) {
      if (img) URL.revokeObjectURL(img.preview);
    }
    setImages({});
    setMode('intraday');
    setParentId(null);
    setReadDate(defaultReadDate());
    setReadTime(defaultReadTime());
    setResponse(null);
    setError(null);
  }, []);

  const submit = useCallback(async () => {
    setError(null);
    setResponse(null);

    const stagedImages = Object.values(images).filter(
      (img): img is UploadedPeriscopeImage => img != null,
    );
    // 0 staged images is allowed — the backend synthesizes Pass 1A +
    // Pass 1B from periscope_snapshots + cone_levels for the requested
    // slot. The handler returns a 422 with a clear "no data for this
    // slot" message when the DB doesn't have rows for the chosen
    // (read_date, read_time), and that error surfaces here via the
    // streaming response.
    if (!ISO_DATE_PATTERN.test(readDate)) {
      setError('Read date must be ISO YYYY-MM-DD.');
      return;
    }
    if (!HHMM_PATTERN.test(readTime)) {
      setError('Read time must be HH:MM (24-hour CT).');
      return;
    }
    if ((mode === 'intraday' || mode === 'debrief') && parentId == null) {
      setError(
        mode === 'intraday'
          ? 'Intraday mode requires a parent — start a pre-trade read first.'
          : "Debrief mode requires a parent — link to today's last intraday or pre-trade read.",
      );
      return;
    }

    setInFlight(true);
    try {
      // Convert all files to base64 in parallel before sending. The
      // server-side schema caps total payload at 30 MB; we already
      // checked per-file at upload time.
      const imagesPayload = await Promise.all(
        stagedImages.map(async (img) => ({
          kind: img.kind,
          mediaType: img.file.type as PeriscopeImageMediaType,
          data: await fileToBase64(img.file),
        })),
      );

      const body = {
        mode,
        images: imagesPayload,
        read_date: readDate,
        read_time: readTime,
        ...(parentId != null && { parentId }),
      };

      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        // 4xx errors (auth, validation) come back as application/json
        // BEFORE the NDJSON streaming starts. Try to parse the body.
        let msg = `Request failed (${res.status})`;
        try {
          const errBody = (await res.json()) as { error?: string };
          if (errBody.error) msg = errBody.error;
        } catch {
          /* non-JSON body — keep status fallback */
        }
        setError(msg);
        return;
      }

      // The endpoint emits NDJSON: 0+ `{"ping":true}` keepalive lines
      // followed by a single final envelope. Parse the LAST non-empty,
      // non-ping line.
      const text = await res.text();
      const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.includes('"ping":true'));
      const last = lines.at(-1);
      if (!last) {
        setError('Empty response from analyze endpoint.');
        return;
      }
      const parsed = JSON.parse(last) as PeriscopeChatResponse;
      if (!parsed.ok) {
        setError(parsed.error);
        return;
      }
      setResponse(parsed);
      // Notify the history panel (sibling component) that a fresh row
      // was persisted so it can re-fetch dates + visible rows. The
      // history panel's date-aggregation useEffect runs only on mount,
      // so without this nudge, mid-day reads piled up in the DB invisible
      // to the picker until the user manually reloaded.
      window.dispatchEvent(new CustomEvent('periscope:submitted'));
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Unexpected analyze error.';
      setError(msg);
    } finally {
      setInFlight(false);
    }
  }, [images, mode, parentId, readDate, readTime]);

  return {
    mode,
    images,
    parentId,
    readDate,
    readTime,
    inFlight,
    elapsedMs,
    response,
    error,
    setMode,
    setParentId,
    setReadDate,
    setReadTime,
    setImage,
    submit,
    reset,
  };
}
