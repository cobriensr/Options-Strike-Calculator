/**
 * NotificationPermission — one-time prompt to enable browser notifications.
 *
 * Shows only for the site owner when Notification.permission === 'default'.
 * "Not now" suppresses the prompt for 24 hours via localStorage.
 */

import { useState } from 'react';

const STORAGE_KEY = 'notif-prompt-dismissed';
const DISMISS_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

function isDismissed(): boolean {
  try {
    const ts = localStorage.getItem(STORAGE_KEY);
    if (!ts) return false;
    return Date.now() - Number(ts) < DISMISS_DURATION_MS;
  } catch {
    return false;
  }
}

interface NotificationPermissionProps {
  permission: NotificationPermission | 'unsupported';
  onRequest: () => Promise<void>;
}

export default function NotificationPermission({
  permission,
  onRequest,
}: NotificationPermissionProps) {
  const [dismissed, setDismissed] = useState(isDismissed);

  if (permission !== 'default' || dismissed) return null;

  const handleDismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, String(Date.now()));
    } catch {
      // localStorage unavailable
    }
    setDismissed(true);
  };

  return (
    <div className="border-edge bg-surface mx-auto mt-2 flex max-w-2xl items-center gap-3 rounded-lg border p-2.5 px-4 font-sans text-xs">
      <span className="text-secondary flex-1">
        Enable desktop notifications for real-time market alerts
      </span>
      <button
        onClick={onRequest}
        className="bg-accent rounded px-3 py-1 font-semibold text-white transition-opacity hover:opacity-80"
      >
        Enable
      </button>
      <button
        onClick={handleDismiss}
        className="text-tertiary transition-opacity hover:opacity-80"
      >
        Not now
      </button>
    </div>
  );
}
