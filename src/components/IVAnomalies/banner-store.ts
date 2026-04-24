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

import type { IVAnomalyExitReason, IVAnomalyRow } from './types';

export const AUTO_DISMISS_MS = 10_000;
const DEFAULT_MAX_VISIBLE = 3;

export type BannerKind = 'entry' | 'exit';

export interface BannerPushOptions {
  /** Which banner variant to render (entry = new anomaly, exit = cooling/distributing). */
  kind?: BannerKind;
  /** Non-null only for exit banners — surfaces the specific exit signal reason. */
  exitReason?: IVAnomalyExitReason | null;
}

export interface BannerEntry {
  /**
   * Internal, stable id — combines the detector row id with the banner
   * kind so an entry banner and an exit banner for the same underlying
   * row can coexist in the stack without deduping each other.
   */
  id: string;
  /** Original detector row id (for tests and external correlation). */
  rowId: number;
  /** Which banner variant to render. */
  kind: BannerKind;
  /** Specific reason for exit banners (null for entry). */
  exitReason: IVAnomalyExitReason | null;
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
  timers: Map<string, ReturnType<typeof setTimeout>>;
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

function clearTimer(id: string): void {
  const timer = state.timers.get(id);
  if (timer != null) {
    clearTimeout(timer);
    state.timers.delete(id);
  }
}

function remove(id: string): void {
  const before = state.entries.length;
  state.entries = state.entries.filter((e) => e.id !== id);
  clearTimer(id);
  if (state.entries.length !== before) notify();
}

function bannerId(rowId: number, kind: BannerKind): string {
  return `${rowId}:${kind}`;
}

function push(anomaly: IVAnomalyRow, options: BannerPushOptions = {}): void {
  const kind: BannerKind = options.kind ?? 'entry';
  const id = bannerId(anomaly.id, kind);
  // Idempotent per (rowId, kind) pair — an entry banner and an exit banner
  // for the same anomaly row can coexist, but re-pushing the same kind
  // for the same row is a no-op.
  if (state.entries.some((e) => e.id === id)) return;

  const entry: BannerEntry = {
    id,
    rowId: anomaly.id,
    kind,
    exitReason: options.exitReason ?? null,
    anomaly,
    pushedAt: Date.now(),
  };
  // Newest first so the top slot holds the most recent anomaly.
  state.entries = [entry, ...state.entries];

  const timer = setTimeout(() => remove(id), AUTO_DISMISS_MS);
  state.timers.set(id, timer);

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

function dismiss(id: string): void {
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
