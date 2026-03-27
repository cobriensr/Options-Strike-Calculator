import logger from './logger.js';

interface AccessTokenResponse {
  accessToken?: string;
  expirationTime?: string;
  userId?: number;
  name?: string;
  errorText?: string;
}

interface TokenState {
  accessToken: string;
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
  if (body.errorText) throw new Error(`Tradovate auth error: ${body.errorText}`);
  if (!body.accessToken || !body.expirationTime)
    throw new Error('Tradovate auth: missing accessToken or expirationTime');
  return {
    accessToken: body.accessToken,
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

  // Log which fields are set (not values) for debugging
  logger.info(
    {
      url: `${baseUrl}/auth/accesstokenrequest`,
      hasName: !!credentials.name,
      hasPassword: !!credentials.password,
      hasAppId: !!credentials.appId,
      hasCid: !!credentials.cid,
      hasSec: !!credentials.sec,
      hasDeviceId: !!credentials.deviceId,
    },
    'Sending auth request',
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
      { status: res.status, statusText: res.statusText, body: text.slice(0, 500) },
      'Tradovate auth HTTP error',
    );
    throw new Error(`Tradovate auth HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const body: AccessTokenResponse = await res.json();

  if (body.errorText) {
    logger.error({ errorText: body.errorText }, 'Tradovate auth rejected');
  }

  const state = parseTokenResponse(body);
  logger.info(
    { userId: state.userId, expiresAt: new Date(state.expiresAt).toISOString() },
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
  const body: AccessTokenResponse = await res.json();
  const state = parseTokenResponse(body);
  logger.info({ expiresAt: new Date(state.expiresAt).toISOString() }, 'Tradovate token renewed');
  return state;
}

export async function getAccessToken(): Promise<string> {
  if (tokenState && tokenState.expiresAt > Date.now() + RENEW_BUFFER_MS) {
    return tokenState.accessToken;
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
    return tokenState.accessToken;
  }
  tokenState = await acquireToken();
  return tokenState.accessToken;
}

export function clearTokenState(): void {
  tokenState = null;
  renewInFlight = null;
}
