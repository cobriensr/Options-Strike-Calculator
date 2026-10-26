/**
 * Axiom domain event reporting for cron jobs.
 *
 * Emits one structured event to Axiom after each cron run so data quality
 * issues (nulls, filtered records, partial fetches) are queryable over time.
 *
 * Column budget: every top-level key of an event becomes a dataset field,
 * and an Axiom dataset caps at 257 fields. The production dataset sits at
 * 258 fields, over the cap (snapshot 2026-10-25), and Axiom had been
 * rejecting the whole event of any cron that added a new key for weeks
 * before this change. So each event is an envelope of `job` plus primitive
 * values under AXIOM_TOP_LEVEL_KEYS (api/_lib/axiom-fields.ts: the columns
 * that already exist), and every other key is JSON-stringified into one
 * `meta` string field. Never add top-level keys; query per-cron fields in
 * APL instead, e.g.
 *
 *   | where job == 'archive-gexbot'
 *   | extend m = parse_json(meta) | where m.remainingDates > 0
 *
 * Rejections: the SDK catches HTTP errors itself (it calls `onError` and
 * resolves `{ ingested: 0, failed: 0 }`), so a rejection shows up as
 * `ingested === 0`, not as a throw. A rejected event that carried `meta` is
 * retried once as the bare envelope. Every rejection logs a pino warning
 * naming the job; the first one per instance also raises a Sentry warning
 * (the cause is dataset-wide). While the dataset has no room for a `meta`
 * column, every event carrying `meta` is rejected and only its envelope
 * lands (`retryIngested: 1`): point AXIOM_DATASET at a fresh dataset.
 * Vacuuming frees nothing when every field still holds data, which is the
 * case with infinite retention. Production did exactly that on 2026-10-25:
 * AXIOM_DATASET now names the `cron-runs` dataset (created empty for these
 * events); the original `vercel` dataset keeps the Vercel log drain. The
 * AXIOM_API_KEY token was rotated the same day to one with ingest on both
 * datasets (Axiom tokens are immutable, so the old vercel-only one was replaced).
 *
 * This shapes only the Axiom event. The cron's HTTP response is built
 * separately (api/_lib/cron-instrumentation.ts) and is unaffected.
 *
 * No-ops silently if AXIOM_API_KEY or AXIOM_DATASET are not configured,
 * so local dev works without Axiom credentials.
 *
 * Usage:
 *   await reportCronRun('fetch-darkpool', { status: 'ok', reqs: 3 });
 *   // sends { job: 'fetch-darkpool', status: 'ok', meta: '{"reqs":3}' }
 */

import { AxiomWithoutBatching } from '@axiomhq/js';
import { AXIOM_TOP_LEVEL_KEYS } from './axiom-fields.js';
import { optionalEnv } from './env.js';
import logger from './logger.js';
import { Sentry } from './sentry.js';

/** Upper bound on the serialized `meta` string. */
const MAX_META_CHARS = 16_000;

/** Upper bound on the SDK failure message copied into logs and Sentry. */
const MAX_FAILURE_SAMPLE_CHARS = 200;

let _client: AxiomWithoutBatching | null = null;

/**
 * Whether this instance has already sent a rejection to Sentry. The cause
 * (the dataset's field cap) is dataset-wide, so one warning per instance is
 * enough; pino still logs every rejection. A single boolean is the R1 bound
 * on this module state, which outlives a request under Fluid Compute.
 */
let rejectionReported = false;

/** Reset the singleton client and the Sentry flag. Exported for tests only. */
export function _resetClient(): void {
  _client = null;
  rejectionReported = false;
}

function getClient(): AxiomWithoutBatching | null {
  const token = optionalEnv('AXIOM_API_KEY');
  if (!token) return null;
  if (!_client) {
    // The SDK passes caught ingest errors to onError (default
    // console.error); route them to pino so the reason reaches the logs.
    _client = new AxiomWithoutBatching({
      token,
      onError: (err) => logger.warn({ err }, 'axiom: ingest error'),
    });
  }
  return _client;
}

function isPrimitive(
  value: unknown,
): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/** Serialize the overflow keys into the `meta` string. Never throws. */
function serializeMeta(overflow: Record<string, unknown>): string {
  const keys = Object.keys(overflow);
  let json: string;
  try {
    json = JSON.stringify(overflow);
  } catch {
    // A BigInt or a circular reference.
    return JSON.stringify({ unserializable: true, keys });
  }
  if (json.length > MAX_META_CHARS) {
    return JSON.stringify({ truncated: true, chars: json.length, keys });
  }
  return json;
}

interface CronEvent {
  /** `job` plus the allowed top-level scalars. Safe to send on its own. */
  envelope: Record<string, unknown>;
  /** Every other key as one JSON string; undefined when nothing overflowed. */
  meta: string | undefined;
  /** Payload keys that went into `meta`, in payload order. */
  overflowKeys: string[];
}

function buildEvent(job: string, payload: Record<string, unknown>): CronEvent {
  const envelope: Record<string, unknown> = { job };
  const overflow: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    // The job argument always wins over a payload key of the same name.
    if (value === undefined || key === 'job') continue;
    if (AXIOM_TOP_LEVEL_KEYS.has(key) && isPrimitive(value)) {
      envelope[key] = value;
    } else {
      overflow[key] = value;
    }
  }
  const overflowKeys = Object.keys(overflow);
  const meta = overflowKeys.length > 0 ? serializeMeta(overflow) : undefined;
  return { envelope, meta, overflowKeys };
}

function reportRejectionOnce(
  job: string,
  overflowKeys: string[],
  retried: boolean,
  failed: number,
  failureSample: string | undefined,
): void {
  if (rejectionReported) return;
  rejectionReported = true;
  Sentry.captureMessage('Axiom rejected cron event', {
    level: 'warning',
    tags: { job, 'axiom.retried': String(retried) },
    extra: { overflowKeys, failed, failureSample },
    fingerprint: ['axiom-ingest-rejected'],
  });
}

/**
 * Emit a structured domain event to Axiom for a completed cron run.
 *
 * The `job` field is always present and is the primary filter key in Axiom.
 * Payload keys are job-specific and documented at the call site; see the
 * header for which stay top-level and which go into `meta`.
 *
 * Never throws or rejects: Axiom reporting must never crash a cron job.
 */
export async function reportCronRun(
  job: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const client = getClient();
    const dataset = optionalEnv('AXIOM_DATASET');
    if (!client || !dataset) return;

    const { envelope, meta, overflowKeys } = buildEvent(job, payload);
    const event = meta === undefined ? envelope : { ...envelope, meta };
    const first = await client.ingest(dataset, event);
    if (first.ingested > 0) return;

    // The SDK reports little beyond a count, but include whatever it has so
    // a cap rejection can be told from a 401/429/network failure.
    const { failed } = first;
    const failureSample = first.failures?.[0]?.error?.slice(
      0,
      MAX_FAILURE_SAMPLE_CHARS,
    );
    const retried = meta !== undefined;
    if (retried) {
      const second = await client.ingest(dataset, envelope);
      logger.warn(
        {
          job,
          overflowKeys,
          retryIngested: second.ingested,
          failed,
          failureSample,
        },
        'axiom: event rejected; retried without meta',
      );
    } else {
      logger.warn({ job, failed, failureSample }, 'axiom: event rejected');
    }
    reportRejectionOnce(job, overflowKeys, retried, failed, failureSample);
  } catch (err) {
    logger.warn({ err }, 'axiom: reportCronRun failed');
  }
}
