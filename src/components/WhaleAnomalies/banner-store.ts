/**
 * Lightweight banner store for new live whale alerts.
 *
 * useWhaleAnomalies pushes a banner whenever a NEW live whale appears
 * (transition from "not seen" → "seen", once per id). The banner UI
 * subscribes to drain the queue. Banners auto-dismiss after BANNER_TTL_MS.
 */

import type { WhaleAnomaly } from './types.js';

const BANNER_TTL_MS = 30_000;

export interface WhaleBannerEntry {
  id: number;
  whale: WhaleAnomaly;
  shownAt: number;
}

type Listener = (entries: WhaleBannerEntry[]) => void;

class WhaleBannerStore {
  private entries: WhaleBannerEntry[] = [];
  private listeners = new Set<Listener>();
  private seen = new Set<number>();

  push(whale: WhaleAnomaly) {
    if (this.seen.has(whale.id)) return;
    this.seen.add(whale.id);
    const entry: WhaleBannerEntry = {
      id: whale.id,
      whale,
      shownAt: Date.now(),
    };
    this.entries = [...this.entries, entry];
    this.emit();
    setTimeout(() => this.dismiss(whale.id), BANNER_TTL_MS);
  }

  dismiss(id: number) {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length !== before) this.emit();
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    listener(this.entries);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit() {
    for (const l of this.listeners) l(this.entries);
  }
}

export const whaleBannerStore = new WhaleBannerStore();
