/**
 * Lightweight pub-sub store for the Strike IV anomaly banner stack.
 *
 * The detection pipeline lives inside `useIVAnomalies`, but the banner is
 * mounted at the app root so it overlays every section. Rather than thread
 * an anomalies-prop through App → every section we just speak through a
 * module-scoped store. Both the hook (publisher) and the banner
 * (subscriber) import `ivAnomalyBannerStore` and stay decoupled.
 *
 * Invariants:
 *   - `push()` is idempotent per-id — re-pushing an existing anomaly is a
 *     no-op (prevents double-banner on poll race conditions).
 *   - Banner slots auto-dismiss after AUTO_DISMISS_MS unless the user
 *     clicks them away. The store tracks timers itself so consumers don't
 *     have to.
 *   - `maxVisible` caps the stack shown by the UI — older entries collapse
 *     into a `+N more` indicator exposed via `overflowCount`.
 *
 * The store is deliberately minimal — no framework, no context provider,
 * no React dep — so it can be imported by hooks / utils / components alike
 * and unit-tested in isolation.
 */

import type { IVAnomalyRow } from './types';

export const AUTO_DISMISS_MS = 10_000;
const DEFAULT_MAX_VISIBLE = 3;

export interface BannerEntry {
  /** Stable id — matches `iv_anomalies.id` to dedup across polls. */
  id: number;
  anomaly: IVAnomalyRow;
  /** Epoch ms when the entry was pushed — used for UI ordering. */
  pushedAt: number;
}

export interface BannerSnapshot {
  /** Entries visible in the stack, newest first. Length ≤ `maxVisible`. */
  visible: BannerEntry[];
  /** Count of older banners collapsed into `+N more`. */
  overflowCount: number;
}

type Listener = (snapshot: BannerSnapshot) => void;

interface StoreState {
  entries: BannerEntry[];
  maxVisible: number;
  timers: Map<number, ReturnType<typeof setTimeout>>;
  listeners: Set<Listener>;
}

function createState(): StoreState {
  return {
    entries: [],
    maxVisible: DEFAULT_MAX_VISIBLE,
    timers: new Map(),
    listeners: new Set(),
  };
}

const state: StoreState = createState();

function snapshot(): BannerSnapshot {
  const visible = state.entries.slice(0, state.maxVisible);
  const overflowCount = Math.max(0, state.entries.length - state.maxVisible);
  return { visible, overflowCount };
}

function notify(): void {
  const snap = snapshot();
  for (const listener of state.listeners) listener(snap);
}

function clearTimer(id: number): void {
  const timer = state.timers.get(id);
  if (timer != null) {
    clearTimeout(timer);
    state.timers.delete(id);
  }
}

function remove(id: number): void {
  const before = state.entries.length;
  state.entries = state.entries.filter((e) => e.id !== id);
  clearTimer(id);
  if (state.entries.length !== before) notify();
}

function push(anomaly: IVAnomalyRow): void {
  if (state.entries.some((e) => e.id === anomaly.id)) return;

  const entry: BannerEntry = {
    id: anomaly.id,
    anomaly,
    pushedAt: Date.now(),
  };
  // Newest first so the top slot holds the most recent anomaly.
  state.entries = [entry, ...state.entries];

  const timer = setTimeout(() => remove(anomaly.id), AUTO_DISMISS_MS);
  state.timers.set(anomaly.id, timer);

  notify();
}

function subscribe(listener: Listener): () => void {
  state.listeners.add(listener);
  // Prime the subscriber with the current snapshot so mount-time state is
  // consistent with whatever has already been pushed.
  listener(snapshot());
  return () => {
    state.listeners.delete(listener);
  };
}

function getSnapshot(): BannerSnapshot {
  return snapshot();
}

function dismiss(id: number): void {
  remove(id);
}

function setMaxVisible(n: number): void {
  if (n < 1 || n === state.maxVisible) return;
  state.maxVisible = n;
  notify();
}

/**
 * Full reset — intended for tests. Clears entries, timers, and listeners.
 * Production code should never need this.
 */
function __resetForTests(): void {
  for (const timer of state.timers.values()) clearTimeout(timer);
  state.timers.clear();
  state.entries = [];
  state.listeners.clear();
  state.maxVisible = DEFAULT_MAX_VISIBLE;
}

export const ivAnomalyBannerStore = {
  push,
  dismiss,
  subscribe,
  getSnapshot,
  setMaxVisible,
  __resetForTests,
};
