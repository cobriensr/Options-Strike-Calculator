import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  DEFAULT_OTM_FLOW_SETTINGS,
  useOtmFlowSettings,
} from '../../../components/OtmFlowAlerts/useOtmFlowSettings';

const STORAGE_KEY = 'otm-flow-settings.v1';

// Use jsdom's real localStorage but wipe between tests.
beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('useOtmFlowSettings — initial load', () => {
  it('returns defaults when localStorage is empty', () => {
    const { result } = renderHook(() => useOtmFlowSettings());
    expect(result.current.settings).toEqual(DEFAULT_OTM_FLOW_SETTINGS);
  });

  it('loads a valid blob from localStorage', () => {
    const stored = {
      ...DEFAULT_OTM_FLOW_SETTINGS,
      minAskRatio: 0.75,
      sides: 'ask' as const,
      mode: 'historical' as const,
      historicalDate: '2026-04-21',
      historicalTime: '10:30',
      audioOn: false,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));

    const { result } = renderHook(() => useOtmFlowSettings());
    expect(result.current.settings.minAskRatio).toBe(0.75);
    expect(result.current.settings.sides).toBe('ask');
    expect(result.current.settings.mode).toBe('historical');
    expect(result.current.settings.historicalDate).toBe('2026-04-21');
    expect(result.current.settings.historicalTime).toBe('10:30');
    expect(result.current.settings.audioOn).toBe(false);
  });

  it('falls back to DEFAULTS on JSON parse failure', () => {
    localStorage.setItem(STORAGE_KEY, '{ not valid json');

    const { result } = renderHook(() => useOtmFlowSettings());
    expect(result.current.settings).toEqual(DEFAULT_OTM_FLOW_SETTINGS);
  });

  it('falls back to DEFAULTS when stored value is not an object', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify('a string'));

    const { result } = renderHook(() => useOtmFlowSettings());
    expect(result.current.settings).toEqual(DEFAULT_OTM_FLOW_SETTINGS);
  });

  it('keeps good fields and drops bad ones from a partial blob', () => {
    // windowMinutes=999 is out of enum, minAskRatio=0.2 is below floor,
    // sides='middle' is invalid, audioOn='yes' is wrong type.
    // historicalDate=42 (number) is wrong type. Good fields: type='put',
    // minPremium=75_000, notificationsOn=true.
    const malformed = {
      windowMinutes: 999,
      minAskRatio: 0.2,
      sides: 'middle',
      audioOn: 'yes',
      historicalDate: 42,
      type: 'put',
      minPremium: 75_000,
      notificationsOn: true,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(malformed));

    const { result } = renderHook(() => useOtmFlowSettings());
    // Bad fields reverted to defaults:
    expect(result.current.settings.windowMinutes).toBe(
      DEFAULT_OTM_FLOW_SETTINGS.windowMinutes,
    );
    expect(result.current.settings.minAskRatio).toBe(
      DEFAULT_OTM_FLOW_SETTINGS.minAskRatio,
    );
    expect(result.current.settings.sides).toBe(DEFAULT_OTM_FLOW_SETTINGS.sides);
    expect(result.current.settings.audioOn).toBe(
      DEFAULT_OTM_FLOW_SETTINGS.audioOn,
    );
    expect(result.current.settings.historicalDate).toBe(
      DEFAULT_OTM_FLOW_SETTINGS.historicalDate,
    );
    // Good fields preserved:
    expect(result.current.settings.type).toBe('put');
    expect(result.current.settings.minPremium).toBe(75_000);
    expect(result.current.settings.notificationsOn).toBe(true);
  });

  it('rejects minAskRatio outside [0.5, 0.95] range', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_OTM_FLOW_SETTINGS, minAskRatio: 0.99 }),
    );
    const { result } = renderHook(() => useOtmFlowSettings());
    expect(result.current.settings.minAskRatio).toBe(
      DEFAULT_OTM_FLOW_SETTINGS.minAskRatio,
    );
  });

  it('rejects minDistancePct outside [0.001, 0.02] range', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_OTM_FLOW_SETTINGS, minDistancePct: 0.5 }),
    );
    const { result } = renderHook(() => useOtmFlowSettings());
    expect(result.current.settings.minDistancePct).toBe(
      DEFAULT_OTM_FLOW_SETTINGS.minDistancePct,
    );
  });

  it('rejects minPremium below the 10_000 floor', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_OTM_FLOW_SETTINGS, minPremium: 500 }),
    );
    const { result } = renderHook(() => useOtmFlowSettings());
    expect(result.current.settings.minPremium).toBe(
      DEFAULT_OTM_FLOW_SETTINGS.minPremium,
    );
  });
});

describe('useOtmFlowSettings — mutations', () => {
  it('updateSettings merges a partial patch without touching other fields', () => {
    const { result } = renderHook(() => useOtmFlowSettings());

    act(() => {
      result.current.updateSettings({ minAskRatio: 0.8, audioOn: false });
    });

    expect(result.current.settings.minAskRatio).toBe(0.8);
    expect(result.current.settings.audioOn).toBe(false);
    // Untouched:
    expect(result.current.settings.minBidRatio).toBe(
      DEFAULT_OTM_FLOW_SETTINGS.minBidRatio,
    );
    expect(result.current.settings.mode).toBe(DEFAULT_OTM_FLOW_SETTINGS.mode);
  });

  it('resetSettings restores DEFAULTS after a series of updates', () => {
    const { result } = renderHook(() => useOtmFlowSettings());

    act(() => {
      result.current.updateSettings({
        minAskRatio: 0.9,
        sides: 'ask',
        audioOn: false,
      });
    });
    expect(result.current.settings.minAskRatio).toBe(0.9);

    act(() => {
      result.current.resetSettings();
    });
    expect(result.current.settings).toEqual(DEFAULT_OTM_FLOW_SETTINGS);
  });

  it('persists updates to localStorage on every change', () => {
    const { result } = renderHook(() => useOtmFlowSettings());

    act(() => {
      result.current.updateSettings({ minAskRatio: 0.72, sides: 'bid' });
    });

    const stored = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? '{}',
    ) as Record<string, unknown>;
    expect(stored.minAskRatio).toBe(0.72);
    expect(stored.sides).toBe('bid');
  });

  it('survives a localStorage write failure without throwing', () => {
    const { result } = renderHook(() => useOtmFlowSettings());

    // Simulate quota-exceeded. The hook wraps setItem in try/catch.
    const spy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });

    // Must not throw.
    act(() => {
      result.current.updateSettings({ minAskRatio: 0.8 });
    });
    expect(result.current.settings.minAskRatio).toBe(0.8);

    spy.mockRestore();
  });
});

describe('useOtmFlowSettings — DEFAULTS sanity', () => {
  it('DEFAULTS are in-range for every validated field (no self-rejection on first load)', () => {
    // Store the DEFAULTS blob explicitly and reload — the coerce validator
    // should accept every default without falling back.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(DEFAULT_OTM_FLOW_SETTINGS),
    );
    const { result } = renderHook(() => useOtmFlowSettings());
    expect(result.current.settings).toEqual(DEFAULT_OTM_FLOW_SETTINGS);
  });
});
