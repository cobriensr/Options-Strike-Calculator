#!/usr/bin/env node

/**
 * Idempotently set the Railway per-replica MEMORY CEILING for the
 * `Classifier` service (project "Theta-Options", region us-west2).
 *
 * WHY THIS EXISTS
 * ---------------
 * The classifier OOM-restarts during the market-open request burst. The
 * platform-side mitigations that live in `classifier/railway.toml`
 * (`healthcheckPath` / `healthcheckTimeout`) recycle a wedged instance,
 * but the actual memory *ceiling* is NOT expressible in railway.toml —
 * Railway's config-as-code only covers the `build`/`deploy` sections.
 * The per-replica resource limit lives on a separate API surface
 * (dashboard: Service → Settings → Deploy → "Replica Limits"), so it
 * would otherwise be a forgettable manual click. This script makes it
 * reproducible.
 *
 * VERIFIED API SHAPE (2026-06-08)
 * -------------------------------
 * Read:  query  serviceInstanceLimits(serviceId, environmentId) -> JSON
 * Write: mutation serviceInstanceLimitsUpdate(input: ServiceInstanceLimitsUpdateInput!)
 *        input: { serviceId, environmentId, memoryGB, vCPUs? }
 *
 * NOTE: the limit is expressed in **GB** (`memoryGB`), NOT bytes. The
 * mutation name documented here was confirmed against a Railway-staff
 * "SOLVED" community thread (working 6 GB example), because the public
 * GraphQL docs only document the *read* (`serviceInstanceLimits`) query,
 * not the write mutation. If Railway renames the mutation, update the
 * GQL_SET_LIMITS constant below.
 *
 * USAGE
 * -----
 *   RAILWAY_API_TOKEN=... \
 *   RAILWAY_CLASSIFIER_SERVICE_ID=... \
 *   RAILWAY_CLASSIFIER_ENVIRONMENT_ID=... \
 *   node scripts/set-classifier-memory-limit.mjs
 *
 * Token env var: RAILWAY_API_TOKEN (preferred) or RAILWAY_TOKEN.
 * The token is NEVER printed or logged.
 *
 * Overrides (env or positional CLI args):
 *   --service-id=<id>      | RAILWAY_CLASSIFIER_SERVICE_ID
 *   --environment-id=<id>  | RAILWAY_CLASSIFIER_ENVIRONMENT_ID
 *   --memory-gb=<n>        | CLASSIFIER_MEMORY_GB (default 8)
 *   --memory-bytes=<n>     | CLASSIFIER_MEMORY_BYTES (converted to GB)
 *
 * Read-only by default? No — this MUTATES live infra. It is idempotent:
 * it reads current limits first and only issues the mutation if the
 * memory ceiling differs, exiting 0 on a no-op.
 */

const RAILWAY_GRAPHQL_URL = 'https://backboard.railway.app/graphql/v2';

// 8 GB recommended ceiling (see classifier/railway.toml rationale).
const DEFAULT_MEMORY_GB = 8;
const BYTES_PER_GB = 1024 * 1024 * 1024;

const GQL_GET_LIMITS = `
  query serviceInstanceLimits($serviceId: String!, $environmentId: String!) {
    serviceInstanceLimits(serviceId: $serviceId, environmentId: $environmentId)
  }
`;

const GQL_SET_LIMITS = `
  mutation serviceInstanceLimitsUpdate($input: ServiceInstanceLimitsUpdateInput!) {
    serviceInstanceLimitsUpdate(input: $input)
  }
`;

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

// ── Parse `--key=value` CLI args ────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const token = process.env.RAILWAY_API_TOKEN ?? process.env.RAILWAY_TOKEN;
if (!token) {
  fail(
    'No Railway API token. Set RAILWAY_API_TOKEN (or RAILWAY_TOKEN). ' +
      'Create one at https://railway.com/account/tokens. Never commit it.',
  );
}

const serviceId =
  args['service-id'] ?? process.env.RAILWAY_CLASSIFIER_SERVICE_ID;
const environmentId =
  args['environment-id'] ?? process.env.RAILWAY_CLASSIFIER_ENVIRONMENT_ID;

if (!serviceId) {
  fail(
    'Missing classifier serviceId. Pass --service-id=<id> or set ' +
      'RAILWAY_CLASSIFIER_SERVICE_ID. Find it in the Railway dashboard URL: ' +
      'project/<projectId>/service/<serviceId>.',
  );
}
if (!environmentId) {
  fail(
    'Missing environmentId. Pass --environment-id=<id> or set ' +
      'RAILWAY_CLASSIFIER_ENVIRONMENT_ID. Find it in the dashboard URL query ' +
      'param ?environmentId=<id> (production environment).',
  );
}

// ── Resolve target memory in GB (accept GB or bytes input) ──────
function resolveMemoryGB() {
  const bytesArg = args['memory-bytes'] ?? process.env.CLASSIFIER_MEMORY_BYTES;
  const gbArg = args['memory-gb'] ?? process.env.CLASSIFIER_MEMORY_GB;

  if (bytesArg != null && gbArg != null) {
    fail('Specify only one of --memory-bytes / --memory-gb, not both.');
  }
  if (bytesArg != null) {
    const bytes = Number(bytesArg);
    if (!Number.isFinite(bytes) || bytes <= 0) {
      fail(`Invalid memory bytes: ${bytesArg}`);
    }
    return bytes / BYTES_PER_GB;
  }
  if (gbArg != null) {
    const gb = Number(gbArg);
    if (!Number.isFinite(gb) || gb <= 0) {
      fail(`Invalid memory GB: ${gbArg}`);
    }
    return gb;
  }
  return DEFAULT_MEMORY_GB;
}

const targetMemoryGB = resolveMemoryGB();

// ── Railway GraphQL request (token never logged) ────────────────
async function railwayGraphQL(query, variables) {
  let response;
  try {
    response = await fetch(RAILWAY_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (networkError) {
    fail(`Network error calling Railway API: ${networkError.message}`);
  }

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    fail(
      `Non-JSON response from Railway API (HTTP ${response.status}): ` +
        text.slice(0, 300),
    );
  }

  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const messages = body.errors.map((e) => e.message).join('; ');
    fail(`Railway GraphQL error: ${messages}`);
  }
  if (!response.ok) {
    fail(`Railway API returned HTTP ${response.status}.`);
  }
  return body.data;
}

// `serviceInstanceLimits` returns a JSON object whose memory field has
// been observed under a few shapes across Railway API versions. Probe
// the common keys defensively rather than assuming one.
function extractCurrentMemoryGB(limits) {
  if (limits == null || typeof limits !== 'object') return null;
  const candidate =
    limits.memoryGB ??
    limits.memory ??
    limits.memoryLimitGB ??
    (typeof limits.memoryBytes === 'number'
      ? limits.memoryBytes / BYTES_PER_GB
      : undefined);
  return typeof candidate === 'number' ? candidate : null;
}

async function main() {
  console.log('Railway classifier memory-limit enforcer');
  console.log(`  serviceId:     ${serviceId}`);
  console.log(`  environmentId: ${environmentId}`);
  console.log(`  target:        ${targetMemoryGB} GB`);

  // 1. Read current limits (idempotency check).
  const readData = await railwayGraphQL(GQL_GET_LIMITS, {
    serviceId,
    environmentId,
  });
  const currentLimits = readData?.serviceInstanceLimits ?? null;
  const currentMemoryGB = extractCurrentMemoryGB(currentLimits);

  console.log(
    `  current limit: ${
      currentMemoryGB == null
        ? `unknown (raw: ${JSON.stringify(currentLimits)})`
        : `${currentMemoryGB} GB`
    }`,
  );

  // 2. No-op if already at the target.
  if (currentMemoryGB != null && currentMemoryGB === targetMemoryGB) {
    console.log(
      `No-op: classifier memory limit already ${targetMemoryGB} GB. Nothing to do.`,
    );
    process.exit(0);
  }

  // 3. Apply the new ceiling.
  await railwayGraphQL(GQL_SET_LIMITS, {
    input: {
      serviceId,
      environmentId,
      memoryGB: targetMemoryGB,
    },
  });

  // 4. Read back to confirm the change landed.
  const verifyData = await railwayGraphQL(GQL_GET_LIMITS, {
    serviceId,
    environmentId,
  });
  const newMemoryGB = extractCurrentMemoryGB(
    verifyData?.serviceInstanceLimits ?? null,
  );

  if (newMemoryGB != null && newMemoryGB !== targetMemoryGB) {
    fail(
      `Mutation applied but read-back shows ${newMemoryGB} GB, expected ` +
        `${targetMemoryGB} GB. Verify in the Railway dashboard.`,
    );
  }

  const before = currentMemoryGB == null ? 'unknown' : `${currentMemoryGB} GB`;
  console.log(
    `SUCCESS: classifier memory ceiling set to ${targetMemoryGB} GB ` +
      `(was ${before}).`,
  );
  process.exit(0);
}

main().catch((err) => {
  fail(err?.message ?? String(err));
});
