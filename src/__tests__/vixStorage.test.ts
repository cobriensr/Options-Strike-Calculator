import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cacheVixData, loadCachedVixData, clearCachedVixData, loadStaticVixData } from '../utils/vixStorage';
import type { VIXDataMap } from '../types';

const STORAGE_KEY = 'strike-calc:vix-data';
const SOURCE_KEY = 'strike-calc:vix-source';

const sampleData: VIXDataMap = {
  '2024-03-04': { open: 14.5, high: 15.2, low: 14.1, close: 14.8 },
  '2024-03-05': { open: 14.8, high: 16, low: 14.6, close: 15.5 },
};

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

// ============================================================
// cacheVixData
// ============================================================
describe('cacheVixData', () => {
  it('stores data and source in localStorage', () => {
    const result = cacheVixData(sampleData, 'test-source');
    expect(result).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    expect(localStorage.getItem(SOURCE_KEY)).toBe('test-source');
  });

  it('stored data is valid JSON matching input', () => {
    cacheVixData(sampleData, 'test');
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored['2024-03-04'].open).toBe(14.5);
    expect(stored['2024-03-05'].close).toBe(15.5);
  });

  it('returns false when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const result = cacheVixData(sampleData, 'test');
    expect(result).toBe(false);
  });

  it('overwrites existing data', () => {
    cacheVixData(sampleData, 'first');
    const newData: VIXDataMap = { '2025-01-01': { open: 20, high: 21, low: 19, close: 20.5 } };
    cacheVixData(newData, 'second');
    expect(localStorage.getItem(SOURCE_KEY)).toBe('second');
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored['2025-01-01']).toBeDefined();
    expect(stored['2024-03-04']).toBeUndefined();
  });
});

// ============================================================
// loadCachedVixData
// ============================================================
describe('loadCachedVixData', () => {
  it('returns null when no data is cached', () => {
    expect(loadCachedVixData()).toBeNull();
  });

  it('loads previously cached data', () => {
    cacheVixData(sampleData, 'my-source');
    const result = loadCachedVixData();
    expect(result).not.toBeNull();
    expect(result!.data['2024-03-04']!.open).toBe(14.5);
    expect(result!.source).toBe('my-source');
  });

  it('returns null when cached data is empty object', () => {
    localStorage.setItem(STORAGE_KEY, '{}');
    localStorage.setItem(SOURCE_KEY, 'test');
    expect(loadCachedVixData()).toBeNull();
  });

  it('defaults source to "cached" when source key is missing', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sampleData));
    // Intentionally not setting SOURCE_KEY
    const result = loadCachedVixData();
    expect(result).not.toBeNull();
    expect(result!.source).toBe('cached');
  });

  it('returns null when stored JSON is invalid', () => {
    localStorage.setItem(STORAGE_KEY, 'not valid json!!!');
    expect(loadCachedVixData()).toBeNull();
  });

  it('returns null when localStorage.getItem throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(loadCachedVixData()).toBeNull();
  });
});

// ============================================================
// clearCachedVixData
// ============================================================
describe('clearCachedVixData', () => {
  it('removes both storage keys', () => {
    cacheVixData(sampleData, 'test');
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    expect(localStorage.getItem(SOURCE_KEY)).not.toBeNull();

    clearCachedVixData();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(SOURCE_KEY)).toBeNull();
  });

  it('does not throw when keys do not exist', () => {
    expect(() => clearCachedVixData()).not.toThrow();
  });

  it('does not throw when localStorage.removeItem throws', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => clearCachedVixData()).not.toThrow();
  });
});

// ============================================================
// loadStaticVixData
// ============================================================
describe('loadStaticVixData', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches from /vix-data.json and returns parsed data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(sampleData),
    }));

    const result = await loadStaticVixData();
    expect(result).not.toBeNull();
    expect(result!.data['2024-03-04']!.open).toBe(14.5);
    expect(result!.source).toContain('built-in');
    expect(result!.source).toContain('2');  // 2 days
    expect(fetch).toHaveBeenCalledWith('/vix-data.json');
  });

  it('source string includes day count', async () => {
    const bigData: VIXDataMap = {};
    for (let i = 0; i < 100; i++) {
      bigData[`2024-01-${String(i + 1).padStart(2, '0')}`] = { open: 15, high: 16, low: 14, close: 15 };
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(bigData),
    }));

    const result = await loadStaticVixData();
    expect(result).not.toBeNull();
    expect(result!.source).toContain('100');
  });

  it('returns null when response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }));

    const result = await loadStaticVixData();
    expect(result).toBeNull();
  });

  it('returns null when response JSON is empty object', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    }));

    const result = await loadStaticVixData();
    expect(result).toBeNull();
  });

  it('returns null when fetch throws (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('NetworkError')));

    const result = await loadStaticVixData();
    expect(result).toBeNull();
  });

  it('returns null when json() parsing throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new Error('Invalid JSON')),
    }));

    const result = await loadStaticVixData();
    expect(result).toBeNull();
  });
});