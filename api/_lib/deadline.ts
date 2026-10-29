/**
 * Bound how long a run waits for one piece of work.
 *
 * Same shape as withDbRetry's per-attempt race (api/_lib/db.ts): the timer
 * is cleared once the race settles, so a fast answer doesn't leave it
 * armed and holding the function open. The work itself is not cancelled
 * (Neon's HTTP driver has no abort hook, and uwFetch aborts on its own
 * timer); a late result is ignored.
 */

/** Rejection from withDeadline, so callers can tell a timeout from an error. */
export class DeadlineError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} passed its ${ms} ms deadline`);
    this.name = 'DeadlineError';
  }
}

/**
 * Resolve or reject with `work`, or reject with a DeadlineError
 * ("<what> passed its <ms> ms deadline") once `ms` passes first.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new DeadlineError(what, ms)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timeoutHandle != null) clearTimeout(timeoutHandle);
  }
}
