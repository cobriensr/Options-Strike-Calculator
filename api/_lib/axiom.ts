/**
 * Axiom domain event reporting for cron jobs.
 *
 * Emits structured metrics to Axiom after each cron run so data quality
 * issues (nulls, filtered records, partial fetches) are queryable over time.
 *
 * No-ops silently if AXIOM_API_KEY or AXIOM_DATASET are not configured,
 * so local dev works without Axiom credentials.
 *
 * Usage:
 *   await reportCronRun('fetch-darkpool', { status: 'ok', trades: 142, levels: 38 });
 */

import { AxiomWithoutBatching } from '@axiomhq/js';
import { optionalEnv } from './env.js';
import logger from './logger.js';

let _client: AxiomWithoutBatching | null = null;

function getClient(): AxiomWithoutBatching | null {
  const token = optionalEnv('AXIOM_API_KEY');
  if (!token) return null;
  if (!_client) _client = new AxiomWithoutBatching({ token });
  return _client;
}

/**
 * Emit a structured domain event to Axiom for a completed cron run.
 *
 * The `job` field is always present and is the primary filter key in Axiom.
 * All other fields are job-specific and documented at the call site.
 *
 * Errors are swallowed — Axiom reporting must never crash a cron job.
 */
export async function reportCronRun(
  job: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const client = getClient();
  const dataset = optionalEnv('AXIOM_DATASET');
  if (!client || !dataset) return;

  try {
    await client.ingest(dataset, { job, ...payload });
  } catch (err) {
    logger.warn({ err }, 'axiom: reportCronRun failed');
  }
}
