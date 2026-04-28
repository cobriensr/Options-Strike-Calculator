/**
 * AlertConfig — compact popover for tuning the playbook alert system.
 *
 * Rendered inside `SectionBox.headerRight` via a small gear-icon toggle
 * so the control sits alongside `ScrubControls` without stealing
 * vertical space in the panel body. The toggle uses the native
 * `<details>` / `<summary>` disclosure so it works without JS state and
 * gets keyboard accessibility (Space/Enter) for free.
 *
 * The panel itself contains:
 *   - Master on/off toggle
 *   - Per-channel toggles (toast, Notification API, audio)
 *   - Per-type toggles (one per `AlertType`)
 *   - Per-type cooldown numeric inputs (seconds)
 *   - Notification API permission button, only when the prompt would
 *     be meaningful (state is 'default' or 'denied'; hidden when
 *     'granted' or 'unsupported')
 *
 * All state is lifted to the dispatcher hook — this component is a
 * controlled view that calls `setConfig` with a new full-config object
 * on every change. Memoized so header re-renders don't churn it.
 */

import { memo, useCallback, useId, useMemo } from 'react';
import type {
  AlertConfig,
  UseAlertDispatcherReturn,
} from './useAlertDispatcher';
import type { AlertType } from '../../utils/futures-gamma/alerts';
import { usePushSubscription } from '../../hooks/usePushSubscription';
import type {
  PushPermission,
  UsePushSubscriptionReturn,
} from '../../hooks/usePushSubscription';
import { Tooltip } from '../ui/Tooltip';
import { TOOLTIP } from './copy/tooltips';

export interface AlertConfigPanelProps {
  config: AlertConfig;
  setConfig: (next: AlertConfig) => void;
  permission: UseAlertDispatcherReturn['permission'];
  requestPermission: () => Promise<void>;
}

// ── Per-type presentation metadata ───────────────────────────────────

const TYPE_LABELS: Record<AlertType, string> = {
  REGIME_FLIP: 'Regime flip',
  LEVEL_APPROACH: 'Level approach',
  LEVEL_BREACH: 'Level breach',
  TRIGGER_FIRE: 'Trigger fired',
  PHASE_TRANSITION: 'Phase transition',
};

const DEFAULT_COOLDOWN_SECONDS = 90;

const TYPE_ORDER: readonly AlertType[] = [
  'REGIME_FLIP',
  'LEVEL_APPROACH',
  'LEVEL_BREACH',
  'TRIGGER_FIRE',
  'PHASE_TRANSITION',
];

// ── Controlled sub-control ───────────────────────────────────────────

interface CheckboxRowProps {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

const CheckboxRow = memo(function CheckboxRow({
  id,
  label,
  checked,
  disabled = false,
  onChange,
}: CheckboxRowProps) {
  return (
    <label
      htmlFor={id}
      className={`flex items-center justify-between gap-3 py-1 font-mono text-[11px] ${
        disabled ? 'opacity-50' : ''
      }`}
      style={{ color: 'var(--color-secondary)' }}
    >
      <span>{label}</span>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-checked={checked}
        className="cursor-pointer disabled:cursor-default"
      />
    </label>
  );
});

// ── Push-subscription subsection ─────────────────────────────────────

/**
 * Returns true when the page is running inside an iOS Safari tab that
 * has NOT been installed as a PWA to the home screen. iOS only allows
 * Web Push in standalone mode, so we surface an install hint instead
 * of a broken Subscribe button.
 *
 * `navigator.standalone` is the legacy iOS-only flag; the matchMedia
 * query is the modern cross-browser standalone check. Either being
 * true means we're already a PWA and the hint should hide.
 */
function isIosBrowserNotStandalone(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    return false;
  }
  const ua = navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua);
  if (!isIos) return false;

  // Legacy Safari-only API — `navigator.standalone` is not in the TS
  // DOM lib but is still the canonical iOS detector. The cast is local
  // and contained.
  const navStandalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const mediaStandalone =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(display-mode: standalone)').matches
      : false;
  return !(navStandalone || mediaStandalone);
}

function pushStateLabel(
  permission: PushPermission,
  isSubscribed: boolean,
): string {
  if (permission === 'unsupported') return 'Not supported on this browser.';
  if (permission === 'denied') return 'Permission denied in browser.';
  return isSubscribed ? 'Subscribed on this device.' : 'Not subscribed.';
}

interface PushSubscriptionSectionProps {
  push: UsePushSubscriptionReturn;
  showIosHint: boolean;
}

const PushSubscriptionSection = memo(function PushSubscriptionSection({
  push,
  showIosHint,
}: PushSubscriptionSectionProps) {
  const {
    permission,
    isSubscribed,
    isSubscribing,
    error,
    subscribe,
    unsubscribe,
  } = push;

  const onSubscribe = useCallback(() => {
    void subscribe();
  }, [subscribe]);
  const onUnsubscribe = useCallback(() => {
    void unsubscribe();
  }, [unsubscribe]);

  const stateLabel = pushStateLabel(permission, isSubscribed);
  const showSubscribeButton =
    !isSubscribed && (permission === 'default' || permission === 'granted');
  const showUnsubscribeButton = isSubscribed && permission !== 'unsupported';

  return (
    <div
      className="border-edge mt-2 border-t pt-2"
      role="group"
      aria-label="Push notifications"
    >
      <div
        className="mb-1 font-mono text-[9px] font-semibold tracking-wider uppercase"
        style={{ color: 'var(--color-tertiary)' }}
      >
        Push notifications (persistent)
      </div>
      <p
        className="font-mono text-[11px]"
        style={{ color: 'var(--color-secondary)' }}
        role="status"
        aria-live="polite"
      >
        {stateLabel}
      </p>

      {showIosHint ? (
        <p
          className="mt-1 font-mono text-[10px] italic"
          style={{ color: 'var(--color-tertiary)' }}
        >
          Install this app to home screen to receive push alerts on iOS.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-danger mt-1 font-mono text-[10px]">
          {error}
        </p>
      ) : null}

      {showSubscribeButton ? (
        <button
          type="button"
          onClick={onSubscribe}
          disabled={isSubscribing}
          className="border-edge text-primary mt-1 w-full rounded border px-2 py-1 font-mono text-[10px] hover:bg-white/5 disabled:opacity-50"
          aria-label="Subscribe this device to push notifications"
        >
          {isSubscribing ? 'Subscribing…' : 'Subscribe this device'}
        </button>
      ) : null}

      {showUnsubscribeButton ? (
        <button
          type="button"
          onClick={onUnsubscribe}
          disabled={isSubscribing}
          className="border-edge text-primary mt-1 w-full rounded border px-2 py-1 font-mono text-[10px] hover:bg-white/5 disabled:opacity-50"
          aria-label="Unsubscribe this device from push notifications"
        >
          {isSubscribing ? 'Unsubscribing…' : 'Unsubscribe this device'}
        </button>
      ) : null}
    </div>
  );
});

// ── Component ────────────────────────────────────────────────────────

export const AlertConfigPanel = memo(function AlertConfigPanel({
  config,
  setConfig,
  permission,
  requestPermission,
}: AlertConfigPanelProps) {
  const idPrefix = useId();

  const toggleEnabled = useCallback(
    (checked: boolean) => setConfig({ ...config, enabled: checked }),
    [config, setConfig],
  );
  const toggleToast = useCallback(
    (checked: boolean) => setConfig({ ...config, toast: checked }),
    [config, setConfig],
  );
  const toggleNotification = useCallback(
    (checked: boolean) => setConfig({ ...config, notification: checked }),
    [config, setConfig],
  );
  const toggleAudio = useCallback(
    (checked: boolean) => setConfig({ ...config, audio: checked }),
    [config, setConfig],
  );

  const setTypeEnabled = useCallback(
    (type: AlertType, checked: boolean) =>
      setConfig({
        ...config,
        types: { ...config.types, [type]: checked },
      }),
    [config, setConfig],
  );

  const setTypeCooldown = useCallback(
    (type: AlertType, seconds: number) => {
      const safe = Number.isFinite(seconds)
        ? Math.max(0, Math.floor(seconds))
        : 0;
      setConfig({
        ...config,
        cooldownSeconds: { ...config.cooldownSeconds, [type]: safe },
      });
    },
    [config, setConfig],
  );

  const onRequestPermission = useCallback(() => {
    // Must be called from a user gesture; we just pass the click through.
    void requestPermission();
  }, [requestPermission]);

  // Push-subscription state lives alongside (not inside) the local-alert
  // dispatcher — they're independent systems (browser subscription vs
  // in-session alert routing). The hook owns all its own state.
  const push = usePushSubscription();
  const showIosHint = useMemo(() => isIosBrowserNotStandalone(), []);

  const childControlsDisabled = !config.enabled;
  const notificationDisabled = permission === 'unsupported';
  const showPermissionButton =
    permission === 'default' || permission === 'denied';

  return (
    <details className="relative">
      <summary
        className="border-edge text-secondary hover:text-primary flex cursor-pointer list-none items-center gap-1 rounded border px-2 py-0.5 font-mono text-[10px] tracking-wider uppercase select-none"
        aria-label="Alert settings"
      >
        <span aria-hidden="true">⚙</span>
        <span>Alerts</span>
      </summary>
      <div
        className="border-edge bg-surface absolute right-0 z-20 mt-1 w-[280px] rounded-lg border p-3 shadow-[var(--shadow-card)]"
        role="group"
        aria-label="Alert configuration"
      >
        {/* Master toggle */}
        <div className="border-edge mb-2 border-b pb-2">
          <CheckboxRow
            id={`${idPrefix}-enabled`}
            label="Enable alerts"
            checked={config.enabled}
            onChange={toggleEnabled}
          />
        </div>

        {/* Channels */}
        <div className="border-edge mb-2 border-b pb-2">
          <div
            className="mb-1 font-mono text-[9px] font-semibold tracking-wider uppercase"
            style={{ color: 'var(--color-tertiary)' }}
          >
            Channels
          </div>
          <CheckboxRow
            id={`${idPrefix}-toast`}
            label="In-app toast"
            checked={config.toast}
            disabled={childControlsDisabled}
            onChange={toggleToast}
          />
          <CheckboxRow
            id={`${idPrefix}-notification`}
            label="Browser notification"
            checked={config.notification}
            disabled={childControlsDisabled || notificationDisabled}
            onChange={toggleNotification}
          />
          <CheckboxRow
            id={`${idPrefix}-audio`}
            label="Audio cue"
            checked={config.audio}
            disabled={childControlsDisabled}
            onChange={toggleAudio}
          />

          {/* Permission state */}
          {notificationDisabled ? (
            <p
              className="mt-1 font-mono text-[10px] italic"
              style={{ color: 'var(--color-tertiary)' }}
            >
              Browser notifications not supported.
            </p>
          ) : permission === 'denied' ? (
            <p
              className="mt-1 font-mono text-[10px] italic"
              style={{ color: 'var(--color-danger)' }}
            >
              Browser notifications blocked — update site permissions.
            </p>
          ) : null}
          {showPermissionButton && (
            <button
              type="button"
              onClick={onRequestPermission}
              className="border-edge text-primary mt-1 w-full rounded border px-2 py-1 font-mono text-[10px] hover:bg-white/5"
              aria-label="Request browser notification permission"
            >
              {permission === 'denied'
                ? 'Retry permission'
                : 'Enable browser notifications'}
            </button>
          )}
        </div>

        {/* Per-type toggles + cooldowns */}
        <div>
          <div
            className="mb-1 font-mono text-[9px] font-semibold tracking-wider uppercase"
            style={{ color: 'var(--color-tertiary)' }}
          >
            Types & cooldowns (s)
          </div>
          <ul className="space-y-1">
            {TYPE_ORDER.map((type) => {
              const id = `${idPrefix}-type-${type}`;
              const cdId = `${idPrefix}-cd-${type}`;
              const cooldown =
                config.cooldownSeconds[type] ?? DEFAULT_COOLDOWN_SECONDS;
              const rowDisabled = childControlsDisabled || !config.types[type];
              return (
                <li
                  key={type}
                  className="grid grid-cols-[1fr_auto_60px] items-center gap-2"
                >
                  <Tooltip content={TOOLTIP.alertType[type]} side="left">
                    <label
                      htmlFor={id}
                      className={`cursor-help font-mono text-[11px] ${
                        childControlsDisabled ? 'opacity-50' : ''
                      }`}
                      style={{ color: 'var(--color-secondary)' }}
                    >
                      {TYPE_LABELS[type]}
                    </label>
                  </Tooltip>
                  <input
                    id={id}
                    type="checkbox"
                    checked={config.types[type]}
                    disabled={childControlsDisabled}
                    onChange={(e) => setTypeEnabled(type, e.target.checked)}
                    aria-checked={config.types[type]}
                    aria-label={`Enable ${TYPE_LABELS[type]} alerts`}
                    className="cursor-pointer disabled:cursor-default"
                  />
                  <input
                    id={cdId}
                    type="number"
                    min={0}
                    step={5}
                    value={cooldown}
                    disabled={rowDisabled}
                    onChange={(e) =>
                      setTypeCooldown(type, Number.parseInt(e.target.value, 10))
                    }
                    aria-label={`${TYPE_LABELS[type]} cooldown in seconds`}
                    className="border-edge bg-surface-alt rounded border px-1 py-0.5 text-right font-mono text-[10px] disabled:opacity-50"
                  />
                </li>
              );
            })}
          </ul>
        </div>

        {/* Push-subscription section — persistent delivery channel */}
        <PushSubscriptionSection push={push} showIosHint={showIosHint} />
      </div>
    </details>
  );
});

export default AlertConfigPanel;
