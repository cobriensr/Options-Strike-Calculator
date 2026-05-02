/**
 * Centralized failure diagnostics for the TRACE capture flow.
 *
 * `failWithDiagnostics` consolidates the 3 historically-duplicated
 * "screenshot to /tmp + throw with rich context" branches in
 * capture-script.ts (login form not visible, login redirect timeout,
 * chart-type combobox not visible / option not clickable).
 *
 * Each call captures a full-page screenshot and re-throws a single
 * Error whose message includes the URL, label, optional extra fields,
 * the original error, and the screenshot path so failures show up
 * actionable in the daemon's pino logs.
 */

import type { Page } from '@playwright/test';

export interface FailDiagnosticsOpts {
  /** Short label for the screenshot filename + log message. */
  label: string;
  /** The original error / wait-failure that triggered diagnostics. */
  originalErr?: unknown;
  /** Extra context fields to inline into the thrown message. */
  extra?: Record<string, unknown>;
}

/**
 * Capture a screenshot to `/tmp/${label}-${Date.now()}.png` and throw
 * an Error whose message includes the URL, label, extras, and original
 * error. Never returns — always throws.
 */
export async function failWithDiagnostics(
  page: Page,
  opts: FailDiagnosticsOpts,
): Promise<never> {
  const { label, originalErr, extra } = opts;
  const finalUrl = page.url();
  const screenshotPath = `/tmp/${label}-${Date.now()}.png`;
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {
    /* swallow screenshot errors so we still throw the original cause */
  });

  const extraStr = extra
    ? Object.entries(extra)
        .map(
          ([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`,
        )
        .join(' ')
    : '';

  const origStr =
    originalErr === undefined
      ? ''
      : `(originalErr: ${originalErr instanceof Error ? originalErr.message : String(originalErr)})`;

  throw new Error(
    [
      `${label}.`,
      `URL: ${finalUrl}`,
      extraStr,
      `Screenshot: ${screenshotPath}`,
      origStr,
    ]
      .filter((s) => s.length > 0)
      .join(' '),
  );
}
