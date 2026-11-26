/**
 * The database host of DATABASE_URL, for the first line a script prints, and
 * the one test of whether a raw DATABASE_URL parses as it reads.
 *
 * That line comes before any query has run, so the host is read off the raw
 * URL, and a parse of a raw URL is not proof. An `@` inside the password, or a
 * `/`, `?` or `#` after it, can end the parsed userinfo early, so that the user
 * or part of the password lands where the host should be:
 * `postgres://owner:12/34@host/db` parses with the host `owner`, and
 * `postgres://owner:p@ss/34@host/db` with the host `ss`. A database driver
 * that takes such a URL would connect to that host and send the whole
 * connection string to it.
 *
 * So the parsed host is trusted only when it is exactly what follows the last
 * `@` in the raw string (or follows the scheme's `//`, when there is no `@`).
 * That is true of every URL whose userinfo parsed as written, including a
 * password with an `@` in it or a percent-encoded one. Anything else, and a URL
 * that does not parse or has no host, is not readable. The rule can refuse a URL
 * that is fine (an `@` in a query parameter after the host); a refused banner
 * costs nothing, and a leaked password does. No case folding: the host is
 * compared as the parser gave it.
 *
 * The parser also drops a tab, CR and LF inside a string without a word, so a
 * string that holds one parses as something it is not (a password with a line
 * break in it reads as one without). A tab, CR, LF or NUL anywhere but the two
 * ends is not readable either. A tab, LF, CR or space AT the ends is: a trailing
 * newline is what `echo "$URL" | vercel env add` leaves.
 *
 * `readableUrl` is that test. The stale-range tool's `databaseOf` takes it and
 * keeps one check of its own (an `@` with no user and no password parsed), so
 * `databaseOf` refuses everything `dbHost` refuses, and `postgres://@host/db`
 * besides: the host for `dbHost`, the sentinel for `databaseOf`, which is the
 * safe way round. This file imports one pure helper (`trimUrlEnds`) and no
 * database client, so a script and its CLI test can take it without one.
 */

import { trimUrlEnds } from '../../api/_lib/url-ends.js';

/**
 * What `dbHost` returns for a URL it will not read a host from. A script that
 * records or compares the host must treat it as matching nothing, itself
 * included: two unreadable URLs are not the same database.
 */
export const DB_HOST_UNREADABLE = '(DATABASE_URL not readable)';

/**
 * The parsed URL, when its host is what the raw string says it is; null for a
 * URL that is missing, does not parse, has no host, holds a tab, CR, LF or NUL
 * away from its two ends, or parses so that its host is not what follows the
 * last `@`.
 */
export function readableUrl(databaseUrl: string | undefined): URL | null {
  const raw = databaseUrl ?? '';
  if (/[\t\r\n\0]/.test(trimUrlEnds(raw))) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.hostname === '') return null;
    const lastAt = raw.lastIndexOf('@');
    const rest =
      lastAt === -1 ? raw.slice(raw.indexOf('//') + 2) : raw.slice(lastAt + 1);
    return rest.startsWith(parsed.host) ? parsed : null;
  } catch {
    return null;
  }
}

export function dbHost(databaseUrl: string | undefined): string {
  return readableUrl(databaseUrl)?.hostname ?? DB_HOST_UNREADABLE;
}
