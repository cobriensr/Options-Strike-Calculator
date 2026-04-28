/**
 * useAlertDispatcher — glue layer between the pure `detectAlertEdges`
 * engine and the three delivery channels (toast, browser Notification,
 * audio cue). Also owns:
 *
 *   - `AlertConfig` persistence in `localStorage` (defensive — access is
 *     wrapped in try/catch so private-browsing / disabled-storage modes
 *     don't crash the panel).
 *   - Per-type cooldown enforcement via a `useRef` keyed on
 *     `${type}:${key}` (e.g. `REGIME_FLIP:` or
 *     `LEVEL_APPROACH:CALL_WALL`). Cooldowns intentionally live in a
 *     ref rather than state — they are timing-only and should not
 *     cause re-renders.
 *   - A bounded `backtestAlerts` array (max 100) capturing every alert
 *     that WOULD have fired during scrub mode. Lets the trader see a
 *     timeline of historical alerts without being interrupted by toasts
 *     while replaying a session.
 *
 * ## Delivery channels
 *
 * - **Toast** — via the existing `useToast` hook. Severity maps: `info`
 *   and `warn` → `info` toast, `urgent` → `error` toast. Falls back
 *   gracefully if the hook throws (we render inside `ToastProvider`, but
 *   unit tests may mount standalone).
 * - **Browser Notification API** — only when permission is 'granted'
 *   AND `config.notification` is on. We never request permission
 *   automatically — the caller (`AlertConfig` component) wires a button
 *   click into `requestNotificationPermission`. Chrome rejects
 *   permission requests that aren't user-initiated.
 * - **Audio** — Web Audio API synth tone, 200ms sine wave, frequency
 *   varies by severity (660Hz info, 880Hz warn, 1040Hz urgent). Uses
 *   `new AudioContext()` inside a `try/catch` so autoplay-blocked
 *   browsers silently no-op.
 *
 * ## Backtest behavior
 *
 * When `isLive === false`, the dispatcher records every event to
 * `backtestAlerts` and skips all three delivery channels. Cooldowns are
 * still honored (same `type:key` won't duplicate in the log within the
 * window). When `isLive` flips back to true the log is NOT replayed —
 * historical events are history.
 */

import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ToastContext } from '../../hooks/useToast';
import { getAudioContextCtor } from '../../utils/audio-utils';
import type {
  AlertEvent,
  AlertState,
  AlertType,
} from '../../utils/futures-gamma/alerts';
import { detectAlertEdges } from '../../utils/futures-gamma/alerts';

// ── Public types ─────────────────────────────────────────────────────

export interface AlertConfig {
  /** Master on/off switch — when false the dispatcher is a no-op. */
  enabled: boolean;
  /** Emit toasts via `useToast`. */
  toast: boolean;
  /** Fire browser Notifications when permission is granted. */
  notification: boolean;
  /** Play the Web Audio synth tone on each alert. */
  audio: boolean;
  /** Per-type cooldown override in seconds. Missing key = default. */
  cooldownSeconds: Partial<Record<AlertType, number>>;
  /** Per-type enable flags. Missing key = enabled (safer default). */
  types: Record<AlertType, boolean>;
}

export interface UseAlertDispatcherReturn {
  config: AlertConfig;
  setConfig: (next: AlertConfig) => void;
  permission: NotificationPermission | 'unsupported';
  requestNotificationPermission: () => Promise<void>;
  /** In-session "would-have-fired" log (backtest only, bounded to 100). */
  backtestAlerts: AlertEvent[];
  clearBacktestAlerts: () => void;
}

// ── Constants ────────────────────────────────────────────────────────

const LOCAL_STORAGE_KEY = 'futures-playbook-alerts-v1';
const DEFAULT_COOLDOWN_SECONDS = 90;
const BACKTEST_LOG_MAX = 100;
const DEFAULT_CONFIG: AlertConfig = {
  enabled: true,
  toast: true,
  notification: false,
  audio: false,
  cooldownSeconds: {},
  types: {
    REGIME_FLIP: true,
    LEVEL_APPROACH: true,
    LEVEL_BREACH: true,
    TRIGGER_FIRE: true,
    PHASE_TRANSITION: true,
  },
};

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Merge a (possibly partial / old-schema) stored config with the current
 * defaults. Missing keys fall back to the default so schema additions are
 * backward-compatible without a version bump.
 */
function mergeConfig(partial: Partial<AlertConfig>): AlertConfig {
  return {
    enabled: partial.enabled ?? DEFAULT_CONFIG.enabled,
    toast: partial.toast ?? DEFAULT_CONFIG.toast,
    notification: partial.notification ?? DEFAULT_CONFIG.notification,
    audio: partial.audio ?? DEFAULT_CONFIG.audio,
    cooldownSeconds: {
      ...DEFAULT_CONFIG.cooldownSeconds,
      ...(partial.cooldownSeconds ?? {}),
    },
    types: {
      ...DEFAULT_CONFIG.types,
      ...(partial.types ?? {}),
    },
  };
}

function readConfigFromStorage(): AlertConfig {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return DEFAULT_CONFIG;
    }
    const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw) as Partial<AlertConfig>;
    return mergeConfig(parsed);
  } catch {
    return DEFAULT_CONFIG;
  }
}

function writeConfigToStorage(config: AlertConfig): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Private mode / quota exceeded / disabled storage — swallow and
    // keep running with the in-memory copy.
  }
}

/** Current permission, or 'unsupported' when the API doesn't exist. */
function readNotificationPermission(): NotificationPermission | 'unsupported' {
  if (typeof window === 'undefined') return 'unsupported';
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

/**
 * Play a short synth tone via Web Audio. Never throws — autoplay blocks
 * and missing API support both fail silently. Frequency varies by
 * severity so the trader can tell alerts apart without looking.
 */
function playAlertTone(severity: AlertEvent['severity']): void {
  try {
    if (typeof window === 'undefined') return;
    const AC = getAudioContextCtor();
    if (!AC) return;
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value =
      severity === 'urgent' ? 1040 : severity === 'warn' ? 880 : 660;
    gain.gain.value = 0.08;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
    // Close the context ~300ms later to release audio hardware.
    window.setTimeout(() => {
      ctx.close().catch(() => {
        /* swallow — closing a possibly-already-closed context */
      });
    }, 300);
  } catch {
    // Autoplay blocked / suspended context / any sync throw — silent.
  }
}

/**
 * Fire a browser Notification. Wrapped in try/catch because some
 * browsers throw synchronously when constructing a Notification before
 * permission is granted (Firefox on cross-origin iframes, for example).
 */
function fireBrowserNotification(event: AlertEvent): void {
  try {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    const n = new Notification(event.title, {
      body: event.body,
      tag: `${event.type}:${event.ts}`,
    });
    // Auto-close after 8 seconds so the tray doesn't fill up.
    window.setTimeout(() => {
      try {
        n.close();
      } catch {
        /* already closed */
      }
    }, 8_000);
  } catch {
    // Permission state race, focus constraints, browser-specific
    // quirks — swallow and fall through to the other channels.
  }
}

/**
 * Cooldown key: include the fine-grained subkey for the kinds where it
 * matters so each level kind / trigger id gets its own cooldown bucket.
 * REGIME_FLIP and PHASE_TRANSITION don't have a subkey (they're global
 * per type). We derive the subkey by splitting the event id, which is
 * always shaped `${type}:${subkey}:${ts}`.
 */
function cooldownKeyFor(event: AlertEvent): string {
  const parts = event.id.split(':');
  if (
    event.type === 'LEVEL_APPROACH' ||
    event.type === 'LEVEL_BREACH' ||
    event.type === 'TRIGGER_FIRE'
  ) {
    const subkey = parts[1] ?? '';
    return `${event.type}:${subkey}`;
  }
  return `${event.type}:`;
}

// ── Hook ─────────────────────────────────────────────────────────────

export interface UseAlertDispatcherInput {
  state: AlertState;
  /** True → deliver; false → record to `backtestAlerts` only. */
  isLive: boolean;
}

export function useAlertDispatcher(
  input: UseAlertDispatcherInput,
): UseAlertDispatcherReturn {
  const { state, isLive } = input;

  // Read the ToastContext directly rather than via `useToast()` so that
  // this hook degrades gracefully when mounted outside `ToastProvider`
  // (e.g. standalone in tests). `useToast` throws on a null context; we
  // want a silent no-op on the toast channel instead of a full crash
  // since the other delivery channels still work.
  const toastCtx = useContext(ToastContext);
  const toastShow = toastCtx?.show ?? null;

  const [config, setConfigState] = useState<AlertConfig>(() =>
    readConfigFromStorage(),
  );
  const [permission, setPermission] = useState<
    NotificationPermission | 'unsupported'
  >(() => readNotificationPermission());
  const [backtestAlerts, setBacktestAlerts] = useState<AlertEvent[]>([]);

  // Cooldown ring: lastFireEpochMs per `${type}:${key}`.
  const cooldownRef = useRef<Record<string, number>>({});
  // Previous state snapshot for edge detection.
  const prevStateRef = useRef<AlertState | null>(null);
  // De-dup the backtest log the same way live delivery is deduped.
  const backtestCooldownRef = useRef<Record<string, number>>({});

  const setConfig = useCallback((next: AlertConfig) => {
    setConfigState(next);
    writeConfigToStorage(next);
  }, []);

  const requestNotificationPermission = useCallback(async () => {
    if (typeof Notification === 'undefined') {
      setPermission('unsupported');
      return;
    }
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
    } catch {
      // Some browsers reject the promise on non-secure contexts.
      setPermission(readNotificationPermission());
    }
  }, []);

  const clearBacktestAlerts = useCallback(() => {
    setBacktestAlerts([]);
    backtestCooldownRef.current = {};
  }, []);

  // Main edge-detection + dispatch effect. Runs on every state change.
  // The dependency list pins just the scalars / identity of the state so
  // we don't re-fire on parent rerenders that hand us a new object with
  // identical content.
  useEffect(() => {
    if (!config.enabled) {
      prevStateRef.current = state;
      return;
    }

    const nowIso = new Date().toISOString();
    const events = detectAlertEdges(prevStateRef.current, state, nowIso);
    prevStateRef.current = state;

    if (events.length === 0) return;

    const nowMs = Date.now();
    const cooldownMap = isLive
      ? cooldownRef.current
      : backtestCooldownRef.current;

    for (const event of events) {
      if (!config.types[event.type]) continue;
      const cdSeconds =
        config.cooldownSeconds[event.type] ?? DEFAULT_COOLDOWN_SECONDS;
      const key = cooldownKeyFor(event);
      const lastFire = cooldownMap[key] ?? 0;
      if (nowMs - lastFire < cdSeconds * 1000) continue;
      cooldownMap[key] = nowMs;

      if (!isLive) {
        // Backtest — record to the bounded log and continue. No delivery.
        setBacktestAlerts((prev) => {
          const next = [...prev, event];
          return next.length > BACKTEST_LOG_MAX
            ? next.slice(next.length - BACKTEST_LOG_MAX)
            : next;
        });
        continue;
      }

      // Live delivery.
      if (config.toast && toastShow) {
        const toastType = event.severity === 'urgent' ? 'error' : 'info';
        toastShow(event.title, toastType);
      }
      if (config.notification && permission === 'granted') {
        fireBrowserNotification(event);
      }
      if (config.audio) {
        playAlertTone(event.severity);
      }
    }
    // `toastShow` is captured from the hook call above and is stable per
    // render. Including it in the deps would refire unnecessarily.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, config, isLive, permission]);

  return {
    config,
    setConfig,
    permission,
    requestNotificationPermission,
    backtestAlerts,
    clearBacktestAlerts,
  };
}
