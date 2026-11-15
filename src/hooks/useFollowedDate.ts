/**
 * useFollowedDate — the date a panel is on: the owner's pick, else today's ET
 * date, which it follows across ET midnight. A panel that seeds its date once
 * (`useState(getETToday)`) keeps showing yesterday as "live" after midnight;
 * this one moves with the shared clock (useETToday) and re-renders in the
 * same commit as every other reader of it.
 *
 * Only the pick is state. `date = pickedDate ?? today`, so there is nothing to
 * sync at midnight. Judge "live" as `date === today`, not "nothing was
 * picked": a picked tomorrow turns live when midnight reaches it.
 *
 * `setDate('')` and `setDate(<today>)` clear the pick, so a date field the
 * owner empties, or sets back to today, follows today again. Any other date
 * stays put across midnight. The calculator's own date (useVixData) follows
 * the same rule, except that it keeps '' as a pick while a date is half typed.
 */

import { useCallback, useState } from 'react';
import { getETToday } from '../utils/timezone';
import { useETToday } from './useETToday';

export interface FollowedDate {
  /** The date the panel is on. */
  date: string;
  /** Pick a date. '' or today's ET date means following today again. */
  setDate: (date: string) => void;
  /** Today's ET date, from the shared clock `date` follows. */
  today: string;
}

export function useFollowedDate(): FollowedDate {
  const today = useETToday();
  const [pickedDate, setPickedDate] = useState<string | null>(null);
  // Compare with the clock at the pick, not the render's `today`: in the
  // second after midnight, before the clock ticks, a pick of the new today
  // must still follow. Stable, as the state setter it replaces was.
  const setDate = useCallback((date: string) => {
    setPickedDate(date === '' || date === getETToday() ? null : date);
  }, []);
  return { date: pickedDate ?? today, setDate, today };
}
