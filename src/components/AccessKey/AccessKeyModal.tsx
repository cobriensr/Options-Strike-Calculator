/**
 * AccessKeyModal — three-state overlay driven by the current AccessMode.
 *
 *   public → input + submit ("Enter access key")
 *   guest  → "Signed in as guest" with Sign out
 *   owner  → informational ("you're already in")
 *
 * The owner state explains the feature instead of hiding the button — the
 * user explicitly asked for the key UI to be visible to everyone, including
 * the owner, to keep the mount point simple (single render, no conditional).
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { AccessMode } from '../../utils/auth';

interface Props {
  mode: AccessMode;
  onClose: () => void;
  onLoginSuccess: () => void;
  onLogout: () => Promise<void>;
}

export default function AccessKeyModal({
  mode,
  onClose,
  onLoginSuccess,
  onLogout,
}: Props) {
  const [keyInput, setKeyInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return (): void => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = useCallback(
    async (e: FormEvent): Promise<void> => {
      e.preventDefault();
      if (!keyInput || submitting) return;
      setSubmitting(true);
      setError(null);
      try {
        const res = await fetch('/api/auth/guest-key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: keyInput }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          setError(body.error ?? `Login failed (HTTP ${res.status})`);
          return;
        }
        onLoginSuccess();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Network error');
      } finally {
        setSubmitting(false);
      }
    },
    [keyInput, submitting, onLoginSuccess],
  );

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="access-key-title"
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 px-4"
      onClick={onClose}
    >
      <div
        className="bg-surface border-edge-strong w-full max-w-sm rounded-xl border p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {mode === 'public' && (
          <>
            <h2
              id="access-key-title"
              className="text-primary mb-2 font-serif text-lg font-bold"
            >
              Enter access key
            </h2>
            <p className="text-secondary mb-4 text-sm">
              Paste the key the owner shared with you to view the read-only
              owner views.
            </p>
            <form onSubmit={submit}>
              <input
                ref={inputRef}
                type="password"
                autoComplete="off"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                className="border-edge-strong text-primary focus:border-accent mb-3 w-full rounded-lg border bg-transparent px-3 py-2 font-mono text-sm focus:outline-none"
                placeholder="paste key"
                aria-label="Access key"
                disabled={submitting}
              />
              {error && (
                <p
                  className="mb-3 text-sm text-red-500"
                  role="alert"
                  aria-live="polite"
                >
                  {error}
                </p>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="border-edge-strong text-primary hover:bg-surface-alt flex-1 rounded-lg border px-4 py-2 text-sm font-semibold transition-colors"
                  disabled={submitting}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="bg-accent flex-1 rounded-lg px-4 py-2 text-sm font-semibold text-white transition-opacity disabled:opacity-50"
                  disabled={!keyInput || submitting}
                >
                  {submitting ? 'Checking…' : 'Sign in'}
                </button>
              </div>
            </form>
          </>
        )}

        {mode === 'guest' && (
          <>
            <h2
              id="access-key-title"
              className="text-primary mb-2 font-serif text-lg font-bold"
            >
              Signed in as guest
            </h2>
            <p className="text-secondary mb-4 text-sm">
              Read-only access to owner-gated views. The Chart Analysis submit
              button is owner-only.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="border-edge-strong text-primary hover:bg-surface-alt flex-1 rounded-lg border px-4 py-2 text-sm font-semibold transition-colors"
              >
                Close
              </button>
              <button
                type="button"
                onClick={async () => {
                  await onLogout();
                  onClose();
                }}
                className="border-edge-strong text-primary hover:bg-surface-alt flex-1 rounded-lg border px-4 py-2 text-sm font-semibold transition-colors"
              >
                Sign out
              </button>
            </div>
          </>
        )}

        {mode === 'owner' && (
          <>
            <h2
              id="access-key-title"
              className="text-primary mb-2 font-serif text-lg font-bold"
            >
              You&apos;re the owner
            </h2>
            <p className="text-secondary mb-4 text-sm">
              The access key is for sharing read-only views with trusted
              friends. Generate a key locally with{' '}
              <code className="bg-surface-alt rounded px-1 font-mono text-xs">
                openssl rand -base64 24
              </code>{' '}
              and add it to{' '}
              <code className="bg-surface-alt rounded px-1 font-mono text-xs">
                GUEST_ACCESS_KEYS
              </code>{' '}
              in Vercel.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="border-edge-strong text-primary hover:bg-surface-alt w-full rounded-lg border px-4 py-2 text-sm font-semibold transition-colors"
            >
              Close
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
