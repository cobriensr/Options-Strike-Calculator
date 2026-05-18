import { createContext, useContext } from 'react';

type ToastType = 'success' | 'error' | 'info';

export interface ToastShowOptions {
  /**
   * When provided, the toast surface becomes clickable (and renders an
   * action button labeled `actionLabel`). Used by `useTrackerAlerts` to
   * scroll-to-row and ack on click.
   */
  onClick?: () => void;
  /**
   * Label for the action button. Defaults to `'Open'` when `onClick` is
   * set. Ignored when `onClick` is undefined.
   */
  actionLabel?: string;
}

export interface ToastContextValue {
  show: (message: string, type?: ToastType, opts?: ToastShowOptions) => void;
}

export const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}
