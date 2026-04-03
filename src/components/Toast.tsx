/**
 * Toast notification system.
 *
 * Renders themed toast messages in the bottom-right corner via a portal.
 * Auto-dismisses after 4 seconds with a slide-out animation.
 * Max 3 visible toasts; newer ones push older ones out.
 */

import {
  createContext,
  memo,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

type ToastType = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  message: string;
  type: ToastType;
  exiting: boolean;
}

interface ToastContextValue {
  show: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

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
    borderColor:
      'color-mix(in srgb, var(--color-success) 25%, transparent)',
    color: 'var(--color-success)',
  },
  error: {
    backgroundColor:
      'color-mix(in srgb, var(--color-danger) 12%, var(--color-surface))',
    borderColor:
      'color-mix(in srgb, var(--color-danger) 25%, transparent)',
    color: 'var(--color-danger)',
  },
  info: {
    backgroundColor:
      'color-mix(in srgb, var(--color-accent) 12%, var(--color-surface))',
    borderColor:
      'color-mix(in srgb, var(--color-accent) 25%, transparent)',
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
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-center gap-2.5 rounded-lg border px-4 py-3 font-sans text-[13px] font-medium shadow-[var(--shadow-card)] backdrop-blur-sm ${
        toast.exiting ? 'animate-toast-out' : 'animate-toast-in'
      }`}
      style={TOAST_STYLES[toast.type]}
    >
      <span className="min-w-0 flex-1">{toast.message}</span>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
        className="shrink-0 cursor-pointer rounded p-0.5 opacity-60 transition-opacity hover:opacity-100"
        style={{ color: 'inherit' }}
      >
        &#x2715;
      </button>
    </div>
  );
});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counterRef = useRef(0);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

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
    (message: string, type: ToastType = 'info') => {
      const id = ++counterRef.current;
      const toast: Toast = { id, message, type, exiting: false };

      setToasts((prev) => {
        const next = [...prev, toast];
        // Evict oldest beyond max
        if (next.length > MAX_VISIBLE) {
          const evicted = next.slice(0, next.length - MAX_VISIBLE);
          for (const t of evicted) {
            dismiss(t.id);
          }
        }
        return next;
      });

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
    <ToastContext.Provider value={{ show }}>
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

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}
