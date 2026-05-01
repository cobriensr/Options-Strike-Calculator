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
  inFlight: boolean;
  elapsedMs: number;
  response: PeriscopeChatSuccess | null;
  error: string | null;
  // Setters
  setMode: (next: PeriscopeMode) => void;
  setParentId: (next: number | null) => void;
  setImage: (kind: PeriscopeImageKind, file: File | null) => void;
  // Actions
  submit: () => Promise<void>;
  reset: () => void;
}

export function usePeriscopeChat(): UsePeriscopeChatResult {
  const [mode, setMode] = useState<PeriscopeMode>('read');
  const [images, setImages] = useState<
    Partial<Record<PeriscopeImageKind, UploadedPeriscopeImage>>
  >({});
  const [parentId, setParentId] = useState<number | null>(null);
  const [inFlight, setInFlight] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [response, setResponse] = useState<PeriscopeChatSuccess | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Track image objects for cleanup. We revoke object URLs on remove and
  // on unmount to avoid leaking blob memory.
  const imagesRef = useRef(images);
  imagesRef.current = images;

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

  const reset = useCallback(() => {
    // Same purity rule as setImage: revoke imperatively, then setImages({}).
    for (const img of Object.values(imagesRef.current)) {
      if (img) URL.revokeObjectURL(img.preview);
    }
    setImages({});
    setMode('read');
    setParentId(null);
    setResponse(null);
    setError(null);
  }, []);

  const submit = useCallback(async () => {
    setError(null);
    setResponse(null);

    const stagedImages = Object.values(images).filter(
      (img): img is UploadedPeriscopeImage => img != null,
    );
    if (stagedImages.length === 0) {
      setError('Add at least one screenshot before submitting.');
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
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Unexpected analyze error.';
      setError(msg);
    } finally {
      setInFlight(false);
    }
  }, [images, mode, parentId]);

  return {
    mode,
    images,
    parentId,
    inFlight,
    elapsedMs,
    response,
    error,
    setMode,
    setParentId,
    setImage,
    submit,
    reset,
  };
}
