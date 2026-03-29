import logger from './logger.js';

interface AccessTokenResponse {
  accessToken?: string;
  mdAccessToken?: string;
  expirationTime?: string;
  userId?: number;
  name?: string;
  errorText?: string;
}

interface TokenState {
  accessToken: string;
  mdAccessToken: string;
  expiresAt: number;
  userId: number;
}

const RENEW_BUFFER_MS = 15 * 60 * 1000;
let tokenState: TokenState | null = null;
let renewInFlight: Promise<TokenState> | null = null;

function getBaseUrl(): string {
  const url = process.env.TRADOVATE_BASE_URL;
  if (!url) throw new Error('TRADOVATE_BASE_URL not configured');
  return url;
}

function parseTokenResponse(body: AccessTokenResponse): TokenState {
  if (body.errorText)
    throw new Error(`Tradovate auth error: ${body.errorText}`);
  if (!body.accessToken || !body.expirationTime)
    throw new Error('Tradovate auth: missing accessToken or expirationTime');
  return {
    accessToken: body.accessToken,
    mdAccessToken: body.mdAccessToken ?? body.accessToken,
    expiresAt: new Date(body.expirationTime).getTime(),
    userId: body.userId ?? 0,
  };
}

async function acquireToken(): Promise<TokenState> {
  const baseUrl = getBaseUrl();
  logger.info('Acquiring Tradovate access token');
  const credentials = {
    name: process.env.TRADOVATE_USERNAME,
    password: process.env.TRADOVATE_PASSWORD,
    appId: process.env.TRADOVATE_APP_ID ?? 'strike-calculator-sidecar',
    appVersion: process.env.TRADOVATE_APP_VERSION ?? '1.0',
    deviceId: process.env.TRADOVATE_DEVICE_ID,
    cid: process.env.TRADOVATE_CID,
    sec: process.env.TRADOVATE_SECRET,
  };

  // Log which fields are set (not values) — inline in message for Railway visibility
  const fieldStatus = [
    `name=${credentials.name ? 'SET' : 'MISSING'}`,
    `password=${credentials.password ? 'SET' : 'MISSING'}`,
    `appId=${credentials.appId || 'MISSING'}`,
    `cid=${credentials.cid ? 'SET' : 'MISSING'}`,
    `sec=${credentials.sec ? 'SET' : 'MISSING'}`,
    `deviceId=${credentials.deviceId ? 'SET' : 'MISSING'}`,
  ].join(', ');
  logger.info(
    `Sending auth request to ${baseUrl}/auth/accesstokenrequest [${fieldStatus}]`,
  );

  const res = await fetch(`${baseUrl}/auth/accesstokenrequest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.error(
      `Tradovate auth HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
    );
    throw new Error(`Tradovate auth HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const body: AccessTokenResponse = await res.json();

  if (body.errorText) {
    logger.error(`Tradovate auth rejected: ${body.errorText}`);
  }

  const state = parseTokenResponse(body);
  logger.info(
    {
      userId: state.userId,
      expiresAt: new Date(state.expiresAt).toISOString(),
    },
    'Tradovate token acquired',
  );
  return state;
}

async function renewToken(currentToken: string): Promise<TokenState> {
  const baseUrl = getBaseUrl();
  logger.info('Renewing Tradovate access token');
  const res = await fetch(`${baseUrl}/auth/renewaccesstoken`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${currentToken}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Tradovate renewal HTTP ${res.status}: ${text.slice(0, 200)}`,
    );
  }

  const body: AccessTokenResponse = await res.json();
  const state = parseTokenResponse(body);
  logger.info(
    { expiresAt: new Date(state.expiresAt).toISOString() },
    'Tradovate token renewed',
  );
  return state;
}

async function ensureToken(): Promise<TokenState> {
  if (tokenState && tokenState.expiresAt > Date.now() + RENEW_BUFFER_MS) {
    return tokenState;
  }
  if (tokenState) {
    if (!renewInFlight) {
      renewInFlight = renewToken(tokenState.accessToken)
        .catch(async (err) => {
          logger.warn({ err }, 'Token renewal failed, re-acquiring');
          return acquireToken();
        })
        .finally(() => {
          renewInFlight = null;
        });
    }
    tokenState = await renewInFlight;
    return tokenState;
  }
  tokenState = await acquireToken();
  return tokenState;
}

export async function getAccessToken(): Promise<string> {
  const state = await ensureToken();
  return state.accessToken;
}

/** Get the market data access token (for WebSocket authorization). */
export async function getMdAccessToken(): Promise<string> {
  const state = await ensureToken();
  return state.mdAccessToken;
}

export function clearTokenState(): void {
  tokenState = null;
  renewInFlight = null;
}
