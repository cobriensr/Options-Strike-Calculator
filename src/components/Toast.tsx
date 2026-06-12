/**
 * Toast notification system.
 *
 * Renders themed toast messages in the bottom-right corner via a portal.
 * Auto-dismisses after 4 seconds with a slide-out animation.
 * Max 3 visible toasts; newer ones push older ones out.
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { ToastContext, type ToastShowOptions } from '../hooks/useToast';

type ToastType = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  message: string;
  type: ToastType;
  exiting: boolean;
  onClick?: () => void;
  actionLabel?: string;
}

const MAX_VISIBLE = 3;
const AUTO_DISMISS_MS = 4_000;
const EXIT_DURATION_MS = 200;

const TOAST_STYLES: Record<
  ToastType,
  { backgroundColor: string; borderColor: string; color: string }
> = {
  success: {
    backgroundColor:
      'color-mix(in srgb, var(--color-success) 12%, var(--color-surface))',
    borderColor: 'color-mix(in srgb, var(--color-success) 25%, transparent)',
    color: 'var(--color-success)',
  },
  error: {
    backgroundColor:
      'color-mix(in srgb, var(--color-danger) 12%, var(--color-surface))',
    borderColor: 'color-mix(in srgb, var(--color-danger) 25%, transparent)',
    color: 'var(--color-danger)',
  },
  info: {
    backgroundColor:
      'color-mix(in srgb, var(--color-accent) 12%, var(--color-surface))',
    borderColor: 'color-mix(in srgb, var(--color-accent) 25%, transparent)',
    color: 'var(--color-accent)',
  },
};

const ToastItem = memo(function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: number) => void;
}) {
  const hasAction = typeof toast.onClick === 'function';
  const actionLabel = toast.actionLabel ?? 'Open';
  // When the toast carries an onClick, fire it then dismiss. The dismiss
  // is implicit so the user doesn't have to click the X after clicking
  // the action.
  const fireAction = useCallback(() => {
    toast.onClick?.();
    onDismiss(toast.id);
  }, [onDismiss, toast]);

  return (
    <output
      aria-live="polite"
      className={`flex items-center gap-2.5 rounded-lg border px-4 py-3 font-sans text-[13px] font-medium shadow-[var(--shadow-card)] backdrop-blur-sm ${
        toast.exiting ? 'animate-toast-out' : 'animate-toast-in'
      }`}
      style={TOAST_STYLES[toast.type]}
    >
      <span className="min-w-0 flex-1">{toast.message}</span>
      {hasAction && (
        <button
          type="button"
          onClick={fireAction}
          aria-label={actionLabel}
          className="shrink-0 cursor-pointer rounded px-2 py-0.5 text-[12px] font-semibold underline-offset-2 transition-opacity hover:underline"
          style={{ color: 'inherit' }}
        >
          {actionLabel}
        </button>
      )}
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
        className="shrink-0 cursor-pointer rounded p-0.5 opacity-60 transition-opacity hover:opacity-100"
        style={{ color: 'inherit' }}
      >
        &#x2715;
      </button>
    </output>
  );
});

export function ToastProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counterRef = useRef(0);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  // Mirror of `toasts` so the stable `show` callback can read the current
  // toast list to compute evictions without depending on `toasts` (which
  // would re-create `show` on every toast change and churn the context
  // value). Kept in sync after each commit. See AUD-L5.
  const toastsRef = useRef<Toast[]>(toasts);
  useEffect(() => {
    toastsRef.current = toasts;
  }, [toasts]);

  const dismiss = useCallback((id: number) => {
    // Clear any pending auto-dismiss timer
    const existing = timersRef.current.get(id);
    if (existing) {
      clearTimeout(existing);
      timersRef.current.delete(id);
    }

    // Start exit animation
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)),
    );

    // Remove after exit animation completes
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, EXIT_DURATION_MS);
  }, []);

  const show = useCallback(
    (message: string, type: ToastType = 'info', opts?: ToastShowOptions) => {
      const id = ++counterRef.current;
      // Spread opts into the toast so existing 2-arg callers keep working
      // unchanged. When `opts` is undefined the optional fields stay
      // absent and ToastItem renders the original no-action layout.
      const toast: Toast = {
        id,
        message,
        type,
        exiting: false,
        onClick: opts?.onClick,
        actionLabel: opts?.actionLabel,
      };

      // Compute which toasts to evict from the current (committed) list up
      // front, then start their exit animations via dismiss() *after* the
      // state update. Running dismiss() inside the updater is impure and
      // double-fires under StrictMode (which intentionally invokes updaters
      // twice). dismiss() handles the actual removal + exit animation, so the
      // updater itself only appends the new toast. See AUD-L5.
      const current = toastsRef.current;
      const evictCount = Math.max(0, current.length + 1 - MAX_VISIBLE);
      const evictedIds = current.slice(0, evictCount).map((t) => t.id);

      setToasts((prev) => [...prev, toast]);

      for (const evictedId of evictedIds) {
        dismiss(evictedId);
      }

      // Auto-dismiss
      const timer = setTimeout(() => {
        timersRef.current.delete(id);
        dismiss(id);
      }, AUTO_DISMISS_MS);
      timersRef.current.set(id, timer);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={useMemo(() => ({ show }), [show])}>
      {children}
      {createPortal(
        <div className="fixed right-4 bottom-4 z-[70] flex flex-col gap-2">
          {toasts.map((t) => (
            <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}
