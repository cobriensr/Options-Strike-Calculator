/**
 * useETToday — today's ET calendar date (YYYY-MM-DD), re-rendering its
 * component when it changes. A tab left open across ET midnight gets the
 * new date without a user action, so a value derived from it in render
 * (App's "the selected date is past" flag for the analysis) turns over at
 * midnight, not at the next unrelated render.
 *
 * One timer, armed for just past the next ET midnight and capped at an
 * hour, so a DST day (the wall clock skips or repeats an hour) or a
 * throttled background-tab timer can't leave it far past midnight. A
 * check that finds the same date sets the same string, which React skips:
 * no re-render, and no network.
 */

import { useEffect, useState } from 'react';
import { getETToday, msUntilNextETMidnight } from '../utils/timezone';

/** The longest wait between checks. */
const MAX_WAIT_MS = 60 * 60 * 1000;

export function useETToday(): string {
  const [today, setToday] = useState(getETToday);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      const wait = Math.min(msUntilNextETMidnight(new Date()), MAX_WAIT_MS);
      timer = setTimeout(() => {
        setToday(getETToday());
        arm();
      }, wait);
    };
    arm();
    return () => clearTimeout(timer);
  }, []);

  return today;
}
