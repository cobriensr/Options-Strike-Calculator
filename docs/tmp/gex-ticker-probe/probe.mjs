// UW websocket probe: gex_strike_expiry + gex channels for SPX/NDX/SPY/QQQ.
// Reads UW_API_KEY from .env.local. Never logs the token or full URL.
// Usage: node docs/tmp/gex-ticker-probe/probe.mjs

import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

function loadEnvVar(name) {
  const envPath = resolve(REPO_ROOT, '.env.local');
  const text = readFileSync(envPath, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (key !== name) continue;
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

const TOKEN = loadEnvVar('UW_API_KEY');
if (!TOKEN) {
  console.error('UW_API_KEY missing from .env.local');
  process.exit(1);
}

const TICKERS = ['SPX', 'NDX', 'SPY', 'QQQ'];
const CHANNEL_TYPES = ['gex_strike_expiry', 'gex'];
const CHANNELS = TICKERS.flatMap((t) => CHANNEL_TYPES.map((c) => `${c}:${t}`));

// Per-channel state: 'pending' | 'ok' | 'error' | 'no-ack'
const ackState = new Map(CHANNELS.map((c) => [c, 'pending']));
const ackError = new Map();
const samplePayload = new Map();
const messageCount = new Map(CHANNELS.map((c) => [c, 0]));

const WAIT_MS = 60_000;
const url = `wss://api.unusualwhales.com/socket?token=${TOKEN}`;

console.log(
  JSON.stringify({
    event: 'connecting',
    host: 'api.unusualwhales.com',
    channels: CHANNELS,
  }),
);

const ws = new WebSocket(url);

ws.on('open', () => {
  console.log(JSON.stringify({ event: 'open' }));
  for (const channel of CHANNELS) {
    const frame = { channel, msg_type: 'join' };
    ws.send(JSON.stringify(frame));
    console.log(JSON.stringify({ event: 'sent_join', channel }));
  }
});

ws.on('message', (raw) => {
  let parsed;
  try {
    parsed = JSON.parse(raw.toString());
  } catch (err) {
    console.log(
      JSON.stringify({
        event: 'parse_error',
        error: String(err),
        raw: raw.toString().slice(0, 200),
      }),
    );
    return;
  }

  // UW format: ["channel:TICKER", payloadObj]
  // Ack:        ["channel:TICKER", { response: {}, status: "ok" }]
  if (
    Array.isArray(parsed) &&
    parsed.length === 2 &&
    typeof parsed[0] === 'string'
  ) {
    const [channel, body] = parsed;
    if (body && typeof body === 'object' && 'status' in body) {
      // Ack frame
      const status = body.status;
      if (status === 'ok') {
        ackState.set(channel, 'ok');
        console.log(JSON.stringify({ event: 'ack_ok', channel }));
      } else {
        ackState.set(channel, 'error');
        ackError.set(channel, body);
        console.log(JSON.stringify({ event: 'ack_error', channel, body }));
      }
      return;
    }
    // Data payload
    const count = (messageCount.get(channel) ?? 0) + 1;
    messageCount.set(channel, count);
    if (!samplePayload.has(channel)) {
      samplePayload.set(channel, body);
      console.log(JSON.stringify({ event: 'sample_payload', channel, body }));
    }
    return;
  }

  // Anything else (heartbeat, unknown)
  console.log(JSON.stringify({ event: 'other_message', payload: parsed }));
});

ws.on('error', (err) => {
  console.log(JSON.stringify({ event: 'ws_error', error: String(err) }));
});

ws.on('close', (code, reason) => {
  console.log(
    JSON.stringify({
      event: 'closed',
      code,
      reason: reason?.toString?.() ?? '',
    }),
  );
});

setTimeout(() => {
  // Mark any still-pending channels
  for (const [channel, state] of ackState) {
    if (state === 'pending') ackState.set(channel, 'no-ack');
  }
  const summary = {
    event: 'summary',
    waited_ms: WAIT_MS,
    rows: CHANNELS.map((channel) => ({
      channel,
      ack: ackState.get(channel),
      ack_error: ackError.get(channel) ?? null,
      payloads_received: messageCount.get(channel) ?? 0,
      sample: samplePayload.get(channel) ?? null,
    })),
  };
  console.log(JSON.stringify(summary, null, 2));
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(0), 500);
}, WAIT_MS);
