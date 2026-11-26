/**
 * `url` without a tab, LF, CR or space at either end: the characters a URL
 * parser strips there, and only those. A trailing newline is what
 * `echo "$URL" | vercel env add` leaves after the value, so the checks that
 * refuse a line break inside a connection string must let it go.
 *
 * A loop, not `replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '')`: the trailing half of
 * that regex backtracks quadratically on a long run of the characters.
 *
 * Shared by `getDb` (api/_lib/db.ts) and `readableUrl`
 * (scripts/_lib/db-host.ts), and imports nothing.
 */
export function trimUrlEnds(url: string): string {
  const ends = '\t\n\r ';
  let start = 0;
  let end = url.length;
  while (start < end && ends.includes(url.charAt(start))) start += 1;
  while (end > start && ends.includes(url.charAt(end - 1))) end -= 1;
  return url.slice(start, end);
}
