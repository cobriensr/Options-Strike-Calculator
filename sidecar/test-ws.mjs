/**
 * Quick test script to manually verify Tradovate WS market data subscription.
 * Usage: node sidecar/test-ws.mjs
 *
 * Requires: TRADOVATE_BASE_URL, TRADOVATE_USERNAME, TRADOVATE_PASSWORD,
 *           TRADOVATE_APP_ID, TRADOVATE_CID, TRADOVATE_SECRET, TRADOVATE_DEVICE_ID
 *           in .env or environment
 */

import WebSocket from 'ws';
import { config } from 'dotenv';
config({ path: 'sidecar/.env' });

const BASE =
  process.env.TRADOVATE_BASE_URL || 'https://live.tradovateapi.com/v1';
const MD_URL =
  process.env.TRADOVATE_MD_URL || 'wss://md.tradovateapi.com/v1/websocket';

async function getToken() {
  const res = await fetch(`${BASE}/auth/accesstokenrequest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: process.env.TRADOVATE_USERNAME,
      password: process.env.TRADOVATE_PASSWORD,
      appId: process.env.TRADOVATE_APP_ID || 'strike-calculator-sidecar',
      appVersion: '1.0',
      deviceId: process.env.TRADOVATE_DEVICE_ID,
      cid: process.env.TRADOVATE_CID,
      sec: process.env.TRADOVATE_SECRET,
    }),
  });
  return res.json();
}

async function main() {
  console.log('Getting token...');
  const auth = await getToken();
  if (auth.errorText) {
    console.error('Auth failed:', auth.errorText);
    process.exit(1);
  }
  console.log(`Token acquired (userId: ${auth.userId})`);
  console.log(
    `accessToken ACL: ${JSON.parse(Buffer.from(auth.accessToken.split('.')[1], 'base64').toString()).acl}`,
  );

  const ws = new WebSocket(MD_URL);
  let reqId = 0;

  // Client heartbeat
  const hb = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send('[]');
  }, 2500);

  ws.on('open', () => console.log('WS connected'));

  ws.on('message', (data) => {
    const raw = data.toString();
    const prefix = raw[0];
    console.log(`< ${raw.slice(0, 300)}`);

    if (prefix === 'o') {
      // Use accessToken (as shown in Tradovate tutorial)
      reqId++;
      const tokenToUse = auth.accessToken;
      const msg = `authorize\n${reqId}\n\n${tokenToUse}`;
      console.log(
        `> authorize with accessToken (id=${reqId}, token=${tokenToUse.slice(0, 20)}...)`,
      );
      ws.send(msg);
    }

    if (prefix === 'a') {
      try {
        const arr = JSON.parse(raw.slice(1));
        for (const item of arr) {
          const obj = typeof item === 'string' ? JSON.parse(item) : item;

          // Auth response
          if (obj.s === 200 && obj.i === 1 && !obj.d?.errorText) {
            console.log('\n=== AUTH SUCCESS ===\n');

            // Try ES and MES to see which one the account allows
            const testSymbols = [
              'ES',
              'ESM6',
              'ESM2026',
              'MES2026',
              'MESM6',
              'MES',
            ];
            for (const sym of testSymbols) {
              reqId++;
              const msg = `md/subscribeQuote\n${reqId}\n\n{"symbol":"${sym}"}`;
              console.log(
                `> subscribe (id=${reqId}): md/subscribeQuote {"symbol":"${sym}"}`,
              );
              ws.send(msg);
            }
          }

          // Quote data
          if (obj.e === 'md') {
            console.log('\n=== QUOTE DATA RECEIVED ===');
            console.log(JSON.stringify(obj.d, null, 2));
          }
        }
      } catch {}
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`WS closed: ${code} ${reason}`);
    clearInterval(hb);
  });

  ws.on('error', (err) => console.error('WS error:', err.message));

  // Auto-close after 15 seconds
  setTimeout(() => {
    clearInterval(hb);
    ws.close();
    process.exit(0);
  }, 15000);
}

main();
