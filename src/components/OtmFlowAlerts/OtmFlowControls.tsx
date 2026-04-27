/**
 * OtmFlowControls — threshold sliders + segmented toggles + live/historical picker.
 *
 * Local state mirrors the settings object on every render; a debounced
 * effect pushes the local state into `updateSettings`. This prevents
 * `useOtmFlowAlerts` from firing a fresh HTTP request on every slider
 * movement or keystroke — the hook's `settings` reference only changes
 * after the debounce window settles (250ms).
 *
 * Toggle-style controls (sides, type, mode, audio, notifications) commit
 * immediately since they don't fire on continuous motion.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useDebounced } from '../../hooks/useDebounced';
import type { OtmFlowSettings } from '../../types/otm-flow';
import { Chip } from '../ui';
import { TimeInputCT } from '../ui/TimeInputCT';

// ── Helpers ───────────────────────────────────────────────────

/** Format a distance-pct threshold as "0.50%" / "1.00%". */
function formatDistance(pct: number): string {
  return `${(pct * 100).toFixed(2)}%`;
}

function formatPremium(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${n}`;
}

function formatRatio(r: number): string {
  return `${Math.round(r * 100)}%`;
}

// ── Component ─────────────────────────────────────────────────

export interface OtmFlowControlsProps {
  settings: OtmFlowSettings;
  updateSettings: (patch: Partial<OtmFlowSettings>) => void;
  resetSettings: () => void;
  notificationPermission: NotificationPermission | 'unsupported';
  requestNotificationPermission: () => void;
}

export const OtmFlowControls = memo(function OtmFlowControls({
  settings,
  updateSettings,
  resetSettings,
  notificationPermission,
  requestNotificationPermission,
}: OtmFlowControlsProps) {
  // Local state for continuous sliders. Pushed to settings via debounce
  // below so the polling hook only refetches after the user stops moving.
  const [local, setLocal] = useState({
    minAskRatio: settings.minAskRatio,
    minBidRatio: settings.minBidRatio,
    minDistancePct: settings.minDistancePct,
    minPremium: settings.minPremium,
  });

  // Keep local in sync when settings mutate from elsewhere (resetSettings,
  // initial load from localStorage). The ref comparison avoids rewriting
  // local while the user is actively dragging — settings updates *from*
  // the debounce don't re-arm the local state.
  const lastPushedRef = useRef(local);
  useEffect(() => {
    if (
      settings.minAskRatio !== lastPushedRef.current.minAskRatio ||
      settings.minBidRatio !== lastPushedRef.current.minBidRatio ||
      settings.minDistancePct !== lastPushedRef.current.minDistancePct ||
      settings.minPremium !== lastPushedRef.current.minPremium
    ) {
      setLocal({
        minAskRatio: settings.minAskRatio,
        minBidRatio: settings.minBidRatio,
        minDistancePct: settings.minDistancePct,
        minPremium: settings.minPremium,
      });
    }
  }, [
    settings.minAskRatio,
    settings.minBidRatio,
    settings.minDistancePct,
    settings.minPremium,
  ]);

  const debounced = useDebounced(local, 250);
  useEffect(() => {
    lastPushedRef.current = debounced;
    updateSettings(debounced);
  }, [debounced, updateSettings]);

  const handleNotificationToggle = useCallback(() => {
    const next = !settings.notificationsOn;
    updateSettings({ notificationsOn: next });
    if (next && notificationPermission === 'default') {
      requestNotificationPermission();
    }
  }, [
    settings.notificationsOn,
    notificationPermission,
    updateSettings,
    requestNotificationPermission,
  ]);

  // Disable on both 'denied' (user actively refused) and 'unsupported'
  // (platform doesn't expose Notification API). In neither case can we
  // prompt the user successfully, so the button should be inert.
  const notifyDisabled =
    notificationPermission === 'denied' ||
    notificationPermission === 'unsupported';
  const notifyLabel =
    notificationPermission === 'denied'
      ? 'Notify blocked'
      : notificationPermission === 'unsupported'
        ? 'Notify n/a'
        : `Notify ${settings.notificationsOn ? 'on' : 'off'}`;

  return (
    <div className="border-edge flex flex-col gap-3 border-b pb-3">
      {/* Row 1 — mode toggle + historical date/time */}
      <div className="flex flex-wrap items-center gap-2">
        <Chip
          active={settings.mode === 'live'}
          onClick={() => updateSettings({ mode: 'live' })}
          label="Live"
        />
        <Chip
          active={settings.mode === 'historical'}
          onClick={() => updateSettings({ mode: 'historical' })}
          label="Historical"
        />

        {settings.mode === 'historical' && (
          <>
            <label className="flex items-center gap-1.5 font-mono text-[12px]">
              <span className="text-muted">Date</span>
              <input
                type="date"
                value={settings.historicalDate}
                // Native <input type="date"> fires `change` on a *complete*
                // valid date, not character-by-character. Chromium/Safari
                // delay until validity; Firefox similarly. Safe to commit
                // directly without debounce. If mobile Safari ever starts
                // emitting per-spinner-step events, route through local
                // state + debounced push like the sliders do.
                onChange={(e) =>
                  updateSettings({ historicalDate: e.target.value })
                }
                className="border-edge bg-surface-alt rounded border px-1.5 py-0.5"
                aria-label="Historical date"
              />
            </label>
            <span className="flex items-center gap-1.5 font-mono text-[12px]">
              <span className="text-muted">Time CT</span>
              <TimeInputCT
                label="Historical time"
                value={settings.historicalTime}
                onChange={(t) => updateSettings({ historicalTime: t })}
                labelVisible={false}
                className="border-edge bg-surface-alt rounded border px-1.5 py-0.5"
              />
            </span>
          </>
        )}

        <div className="ml-auto flex items-center gap-2">
          <Chip
            active={settings.audioOn}
            onClick={() => updateSettings({ audioOn: !settings.audioOn })}
            label={`Audio ${settings.audioOn ? 'on' : 'off'}`}
          />
          <button
            type="button"
            onClick={notifyDisabled ? undefined : handleNotificationToggle}
            disabled={notifyDisabled}
            aria-pressed={settings.notificationsOn}
            aria-label={notifyLabel}
            className={
              'rounded-full border-[1.5px] px-3.5 py-1.5 font-mono text-[13px] font-medium transition-all duration-100 ' +
              (notifyDisabled
                ? 'border-edge bg-surface text-muted cursor-not-allowed opacity-50'
                : settings.notificationsOn
                  ? 'border-chip-active-border bg-chip-active-bg text-chip-active-text cursor-pointer'
                  : 'border-chip-border bg-chip-bg text-chip-text hover:border-edge-heavy hover:bg-surface-alt cursor-pointer')
            }
          >
            {notifyLabel}
          </button>
          <button
            type="button"
            onClick={resetSettings}
            aria-label="Reset OTM flow settings to defaults"
            className="text-muted hover:text-foreground cursor-pointer font-mono text-[12px] underline-offset-2 hover:underline"
          >
            reset
          </button>
        </div>
      </div>

      {/* Row 2 — sides + type */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted font-mono text-[12px]">Sides</span>
        <Chip
          active={settings.sides === 'both'}
          onClick={() => updateSettings({ sides: 'both' })}
          label="Both"
        />
        <Chip
          active={settings.sides === 'ask'}
          onClick={() => updateSettings({ sides: 'ask' })}
          label="Ask-heavy"
        />
        <Chip
          active={settings.sides === 'bid'}
          onClick={() => updateSettings({ sides: 'bid' })}
          label="Bid-heavy"
        />

        <span className="text-muted ml-3 font-mono text-[12px]">Type</span>
        <Chip
          active={settings.type === 'both'}
          onClick={() => updateSettings({ type: 'both' })}
          label="Both"
        />
        <Chip
          active={settings.type === 'call'}
          onClick={() => updateSettings({ type: 'call' })}
          label="Calls"
        />
        <Chip
          active={settings.type === 'put'}
          onClick={() => updateSettings({ type: 'put' })}
          label="Puts"
        />
      </div>

      {/* Row 3 — sliders */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <Slider
          label="Ask threshold"
          value={local.minAskRatio}
          min={0.5}
          max={0.95}
          step={0.01}
          displayValue={formatRatio(local.minAskRatio)}
          onChange={(v) => setLocal((s) => ({ ...s, minAskRatio: v }))}
          ariaLabel="Minimum ask-side ratio to qualify as ask-heavy"
        />
        <Slider
          label="Bid threshold"
          value={local.minBidRatio}
          min={0.5}
          max={0.95}
          step={0.01}
          displayValue={formatRatio(local.minBidRatio)}
          onChange={(v) => setLocal((s) => ({ ...s, minBidRatio: v }))}
          ariaLabel="Minimum bid-side ratio to qualify as bid-heavy"
        />
        <Slider
          label="Far-OTM ≥"
          value={local.minDistancePct}
          min={0.001}
          max={0.02}
          step={0.0005}
          displayValue={formatDistance(local.minDistancePct)}
          onChange={(v) => setLocal((s) => ({ ...s, minDistancePct: v }))}
          ariaLabel="Minimum absolute distance from spot, as a fraction"
        />
        <Slider
          label="Min premium"
          value={local.minPremium}
          min={10_000}
          max={500_000}
          step={5_000}
          displayValue={formatPremium(local.minPremium)}
          onChange={(v) => setLocal((s) => ({ ...s, minPremium: v }))}
          ariaLabel="Minimum total premium floor"
        />
      </div>
    </div>
  );
});

// ── Slider sub-component ──────────────────────────────────────

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  displayValue: string;
  onChange: (value: number) => void;
  ariaLabel: string;
}

const Slider = memo(function Slider({
  label,
  value,
  min,
  max,
  step,
  displayValue,
  onChange,
  ariaLabel,
}: SliderProps) {
  return (
    <label className="flex flex-col gap-1 font-mono text-[12px]">
      <span className="text-muted flex items-center justify-between">
        <span>{label}</span>
        <span className="text-foreground font-semibold">{displayValue}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number.parseFloat(e.target.value))}
        aria-label={ariaLabel}
        // Screen readers announce aria-valuetext instead of the raw numeric
        // aria-valuenow — so SR users hear "65%" / "0.50%" / "$50K" as they
        // drag, not the decimal value 0.65 / 0.005 / 50000.
        aria-valuetext={displayValue}
        className="accent-accent cursor-pointer"
      />
    </label>
  );
});
