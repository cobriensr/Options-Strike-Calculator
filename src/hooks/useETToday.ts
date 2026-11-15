/**
 * useETToday — today's ET calendar date (YYYY-MM-DD), re-rendering its
 * component when it changes. A tab left open across ET midnight gets the
 * new date without a user action, so a value derived from it in render
 * turns over at midnight, not at the next unrelated render.
 *
 * One clock for the whole app. Every caller reads the same store, so every
 * panel (memoized or not) re-renders in the same commit and no two of them
 * can disagree about which day it is. The store:
 *
 * - runs one timer while anyone is subscribed, armed for just past the next
 *   ET midnight and capped at an hour, so a DST day (the wall clock skips or
 *   repeats an hour) or a throttled background-tab timer can't leave it far
 *   past midnight;
 * - holds the date every subscriber reads, and moves it only when the timer
 *   fires or a re-check finds the wall clock past midnight. A sleeping laptop
 *   or a throttled tab can miss the timer, so the clock is also re-read when
 *   the tab becomes visible and when the window gains focus;
 * - notifies only when the date changed, so a check that finds the same date
 *   re-renders nothing and starts no network call;
 * - keeps nothing while nobody is subscribed: the first subscriber reads the
 *   clock and the last one leaves, and the timer, the listeners and the held
 *   date go with it. With no subscriber, a read is the wall clock itself.
 *
 * The selected date follows it: useVixData runs it and hands it on as
 * `etToday`, so App's "the selected date is past" flag and useAutoFill's
 * past-date checks turn in the same render as the date.
 */

import { useSyncExternalStore } from 'react';
import { getETToday, msUntilNextETMidnight } from '../utils/timezone';

/** The longest wait between checks. */
const MAX_WAIT_MS = 60 * 60 * 1000;

const listeners = new Set<() => void>();
/** The date every subscriber reads. null while nobody is subscribed. */
let current: string | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Move the held date to the wall clock's, telling subscribers if it moved. */
function refresh(): void {
  const next = getETToday();
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

function refreshIfVisible(): void {
  if (document.visibilityState === 'visible') refresh();
}

function arm(): void {
  const wait = Math.min(msUntilNextETMidnight(new Date()), MAX_WAIT_MS);
  timer = setTimeout(() => {
    arm();
    refresh();
  }, wait);
}

function start(): void {
  current = getETToday();
  arm();
  document.addEventListener('visibilitychange', refreshIfVisible);
  window.addEventListener('focus', refresh);
}

function stop(): void {
  clearTimeout(timer);
  timer = undefined;
  document.removeEventListener('visibilitychange', refreshIfVisible);
  window.removeEventListener('focus', refresh);
  current = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    if (listeners.delete(listener) && listeners.size === 0) stop();
  };
}

function getSnapshot(): string {
  return current ?? getETToday();
}

export function useETToday(): string {
  return useSyncExternalStore(subscribe, getSnapshot);
}
