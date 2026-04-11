import type { VIXDataMap } from '../types';

const STORAGE_KEY = 'strike-calc:vix-data';
const SOURCE_KEY = 'strike-calc:vix-source';
const STATIC_PATH = '/vix-data.json';

/**
 * Save VIX data to localStorage.
 * Returns true if successful, false if storage is full or unavailable.
 */
export function cacheVixData(data: VIXDataMap, source: string): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    localStorage.setItem(SOURCE_KEY, source);
    return true;
  } catch {
    // localStorage full or unavailable
    return false;
  }
}

/**
 * Load VIX data from localStorage cache.
 * Returns null if no cached data exists.
 */
export function loadCachedVixData(): {
  data: VIXDataMap;
  source: string;
} | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const source = localStorage.getItem(SOURCE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as VIXDataMap;
    if (Object.keys(data).length === 0) return null;
    return { data, source: source ?? 'cached' };
  } catch {
    return null;
  }
}

/**
 * Clear cached VIX data from localStorage.
 */
export function clearCachedVixData(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(SOURCE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Load the static VIX JSON that ships with the app.
 * Returns null if the file doesn't exist or can't be parsed.
 */
export async function loadStaticVixData(): Promise<{
  data: VIXDataMap;
  source: string;
} | null> {
  try {
    const response = await fetch(STATIC_PATH);
    if (!response.ok) return null;
    const data = (await response.json()) as VIXDataMap;
    if (Object.keys(data).length === 0) return null;
    return {
      data,
      source:
        Object.keys(data).length.toLocaleString() + ' days',
    };
  } catch {
    return null;
  }
}
