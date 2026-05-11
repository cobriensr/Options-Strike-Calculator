/**
 * Auto-playbook webhook — fires after each successful scrape tick.
 *
 * Phase 3 of docs/superpowers/specs/periscope-auto-playbook-2026-05-10.md.
 *
 * After `insertSnapshots(rows)` lands, the scraper POSTs to
 * `${VERCEL_BASE_URL}/api/periscope-auto-playbook` with a Bearer token
 * matching `PERISCOPE_WEBHOOK_SECRET`. The Vercel function inserts an
 * `in_progress` row, returns 202 immediately, and runs the Claude call
 * via `waitUntil` for the full 5-9 min Opus thinking budget.
 *
 * Failure policy:
 *   - 5xx / network errors / timeouts: retry once with 2s backoff,
 *     then give up. Sentry is captured by the caller.
 *   - 4xx (except 422): no retry. Auth/config issues need human attention.
 *   - 422: expected for pre-market or post-close slots, treated as success.
 *   - Missing env vars (VERCEL_BASE_URL or PERISCOPE_WEBHOOK_SECRET):
 *     skipped silently with `result.skipped = true`. Lets the scraper
 *     deploy before the env vars are configured in Railway.
 */

const TIMEOUT_MS = 5_000;
const RETRY_BACKOFF_MS = 2_000;

export interface WebhookInput {
  /** YYYY-MM-DD CT — the trading day the tick is for. */
  tradingDate: string;
  /** ISO 8601 — the row's `capturedAt` from periscope_snapshots. */
  capturedAt: string;
  /** "HH:MM - HH:MM" timeframe label parsed from the UW slot picker. */
  slotKey: string;
}

export interface WebhookResult {
  ok: boolean;
  status: number | null;
  attempts: number;
  /** True when env vars were missing — webhook silently no-op'd. */
  skipped: boolean;
  /** Populated on failure — concise human-readable reason. */
  error?: string;
}

export type Fetcher = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface WebhookConfig {
  baseUrl: string | null;
  secret: string | null;
  /** Optional injected fetch (default: global fetch). */
  fetcher?: Fetcher;
  /** Optional override for the timeout (test escape hatch). */
  timeoutMs?: number;
  /** Optional override for the retry backoff (test escape hatch). */
  retryBackoffMs?: number;
}

/**
 * Read webhook config from process.env. Returns nulls when either var
 * is missing — caller treats that as a skip rather than a failure.
 */
export function loadWebhookConfig(): WebhookConfig {
  const baseUrl = (process.env.VERCEL_BASE_URL ?? '').trim();
  const secret = (process.env.PERISCOPE_WEBHOOK_SECRET ?? '').trim();
  return {
    baseUrl: baseUrl !== '' ? baseUrl.replace(/\/+$/, '') : null,
    secret: secret !== '' ? secret : null,
  };
}

/**
 * POST the auto-playbook webhook. Single retry on 5xx / timeout / network
 * error; no retry on 4xx (configuration / contract issue, retry won't help).
 */
export async function postPlaybookWebhook(
  input: WebhookInput,
  config: WebhookConfig,
): Promise<WebhookResult> {
  if (config.baseUrl == null || config.secret == null) {
    return {
      ok: true,
      status: null,
      attempts: 0,
      skipped: true,
    };
  }

  const url = `${config.baseUrl}/api/periscope-auto-playbook`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.secret}`,
    'Content-Type': 'application/json',
  };
  const body = JSON.stringify({
    tradingDate: input.tradingDate,
    capturedAt: input.capturedAt,
    slotKey: input.slotKey,
  });

  const fetcher = config.fetcher ?? (globalThis.fetch as unknown as Fetcher);
  const timeoutMs = config.timeoutMs ?? TIMEOUT_MS;
  const backoff = config.retryBackoffMs ?? RETRY_BACKOFF_MS;

  let lastStatus: number | null = null;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetcher(url, {
        method: 'POST',
        headers,
        body,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      lastStatus = res.status;

      // 2xx — success. 422 is treated as success too: the endpoint
      // returns it for non-analyzable slots (pre-market, post-close,
      // missing SPX candle), and retrying won't help.
      if (res.ok || res.status === 422) {
        return {
          ok: true,
          status: res.status,
          attempts: attempt,
          skipped: false,
        };
      }

      // Non-422 4xx: no retry — auth or contract issue.
      if (res.status >= 400 && res.status < 500) {
        const errBody = await res.text().catch(() => '');
        return {
          ok: false,
          status: res.status,
          attempts: attempt,
          skipped: false,
          error: `HTTP ${res.status}${errBody ? `: ${errBody.slice(0, 200)}` : ''}`,
        };
      }

      // 5xx — retry path
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      clearTimeout(timer);
      lastError =
        err instanceof Error
          ? `${err.name}: ${err.message}`
          : `non-Error throw: ${String(err)}`;
    }

    if (attempt < 2) {
      await new Promise<void>((r) => setTimeout(r, backoff));
    }
  }

  return {
    ok: false,
    status: lastStatus,
    attempts: 2,
    skipped: false,
    error: lastError ?? 'unknown failure',
  };
}
