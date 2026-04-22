/**
 * useOtmFlowSettings — user-tunable settings for the OTM Flow Alerts card.
 *
 * Persisted to localStorage under a versioned key so future shape changes
 * can migrate or discard. On load: parse stored JSON, validate with a
 * shallow guard, and fall back to DEFAULTS on any failure (corruption,
 * missing keys, wrong types, etc.) — a bad settings blob should never
 * break the UI.
 *
 * Writes are synchronous on every update; the tradeoff is trivially small
 * (10 fields, fires on user-driven slider/toggle changes, not on renders).
 */

import { useCallback, useEffect, useState } from 'react';
import type { OtmFlowSettings } from '../../types/otm-flow';

const STORAGE_KEY = 'otm-flow-settings.v1';

export const DEFAULT_OTM_FLOW_SETTINGS: OtmFlowSettings = {
  windowMinutes: 30,
  minAskRatio: 0.6,
  minBidRatio: 0.6,
  minDistancePct: 0.005,
  minPremium: 50_000,
  sides: 'both',
  type: 'both',
  mode: 'live',
  historicalDate: '',
  historicalTime: '',
  audioOn: true,
  notificationsOn: false,
};

/**
 * Shallow validator — checks each field is present and of the right type.
 * Returns the merged object on success (takes stored values when valid,
 * defaults otherwise) or null if the input is not an object.
 */
function coerceSettings(raw: unknown): OtmFlowSettings | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Partial<OtmFlowSettings>;

  const merged: OtmFlowSettings = {
    ...DEFAULT_OTM_FLOW_SETTINGS,
    ...(typeof r.windowMinutes === 'number' &&
    [5, 15, 30, 60].includes(r.windowMinutes)
      ? { windowMinutes: r.windowMinutes as OtmFlowSettings['windowMinutes'] }
      : null),
    ...(typeof r.minAskRatio === 'number' &&
    r.minAskRatio >= 0.5 &&
    r.minAskRatio <= 0.95
      ? { minAskRatio: r.minAskRatio }
      : null),
    ...(typeof r.minBidRatio === 'number' &&
    r.minBidRatio >= 0.5 &&
    r.minBidRatio <= 0.95
      ? { minBidRatio: r.minBidRatio }
      : null),
    ...(typeof r.minDistancePct === 'number' &&
    r.minDistancePct >= 0.001 &&
    r.minDistancePct <= 0.02
      ? { minDistancePct: r.minDistancePct }
      : null),
    ...(typeof r.minPremium === 'number' && r.minPremium >= 10_000
      ? { minPremium: r.minPremium }
      : null),
    ...(r.sides === 'ask' || r.sides === 'bid' || r.sides === 'both'
      ? { sides: r.sides }
      : null),
    ...(r.type === 'call' || r.type === 'put' || r.type === 'both'
      ? { type: r.type }
      : null),
    ...(r.mode === 'live' || r.mode === 'historical' ? { mode: r.mode } : null),
    ...(typeof r.historicalDate === 'string'
      ? { historicalDate: r.historicalDate }
      : null),
    ...(typeof r.historicalTime === 'string'
      ? { historicalTime: r.historicalTime }
      : null),
    ...(typeof r.audioOn === 'boolean' ? { audioOn: r.audioOn } : null),
    ...(typeof r.notificationsOn === 'boolean'
      ? { notificationsOn: r.notificationsOn }
      : null),
  };
  return merged;
}

function loadFromStorage(): OtmFlowSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_OTM_FLOW_SETTINGS;
    const parsed: unknown = JSON.parse(raw);
    return coerceSettings(parsed) ?? DEFAULT_OTM_FLOW_SETTINGS;
  } catch {
    return DEFAULT_OTM_FLOW_SETTINGS;
  }
}

export interface UseOtmFlowSettingsResult {
  settings: OtmFlowSettings;
  updateSettings: (patch: Partial<OtmFlowSettings>) => void;
  resetSettings: () => void;
}

export function useOtmFlowSettings(): UseOtmFlowSettingsResult {
  const [settings, setSettings] = useState<OtmFlowSettings>(loadFromStorage);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Quota exceeded / storage disabled — silent, next run reverts to defaults.
    }
  }, [settings]);

  const updateSettings = useCallback((patch: Partial<OtmFlowSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const resetSettings = useCallback(() => {
    setSettings(DEFAULT_OTM_FLOW_SETTINGS);
  }, []);

  return { settings, updateSettings, resetSettings };
}
