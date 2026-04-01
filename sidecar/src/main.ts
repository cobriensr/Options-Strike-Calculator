import { getAccessToken } from './tradovate-auth.js';
import { TradovateWsClient, type TradovateQuote } from './tradovate-ws.js';
import { BarAggregator, type Tick } from './bar-aggregator.js';
import { resolveContractSymbol } from './contract-roller.js';
import { upsertBar, verifyConnection, drainPool, getPool } from './db.js';
import { startHealthServer } from './health.js';
import logger from './logger.js';

let lastQuoteTime = 0;
let wsClient: TradovateWsClient | null = null;
let aggregator: BarAggregator | null = null;
let safetyFlushTimer: NodeJS.Timeout | null = null;
let isShuttingDown = false;

function handleQuote(quote: TradovateQuote): void {
  const trade = quote.entries.Trade;
  const totalVol = quote.entries.TotalTradeVolume;
  if (!trade?.price) return;

  lastQuoteTime = Date.now();
  const tick: Tick = {
    price: trade.price,
    cumulativeVolume: totalVol?.size ?? 0,
    timestamp: new Date(quote.timestamp),
  };
  aggregator?.onTick(tick);
}

async function connectWithRetry(): Promise<void> {
  let backoff = 1000;
  const MAX_BACKOFF = 30_000;

  while (!isShuttingDown) {
    try {
      const token = await getAccessToken();
      const symbol = resolveContractSymbol();
      const wsUrl = process.env.TRADOVATE_MD_URL;
      if (!wsUrl) throw new Error('TRADOVATE_MD_URL not configured');

      // Resolve contract ID via REST — the WS may need the ID, not the symbol
      const baseUrl = process.env.TRADOVATE_BASE_URL;
      let contractId: number | null = null;
      try {
        const contractRes = await fetch(
          `${baseUrl}/contract/find?name=${symbol}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (contractRes.ok) {
          const contract = (await contractRes.json()) as {
            id: number;
            name: string;
          };
          contractId = contract.id;
          logger.info({ symbol, contractId }, 'Contract resolved');
        }
      } catch (err) {
        logger.warn(
          { err, symbol },
          'Could not resolve contract ID, using symbol string',
        );
      }

      aggregator = new BarAggregator(async (bar) => {
        try {
          await upsertBar(bar);
          logger.debug(
            {
              ts: bar.ts.toISOString(),
              o: bar.open,
              h: bar.high,
              l: bar.low,
              c: bar.close,
              v: bar.volume,
            },
            'Bar flushed',
          );
        } catch (err) {
          logger.error({ err }, 'Failed to upsert bar');
        }
      }, symbol);

      safetyFlushTimer = setInterval(() => {
        aggregator?.flush();
      }, 60_000);

      // Try both tokens — log which one we're using
      // accessToken has Prices:Read ACL; mdAccessToken is md-specific
      // Try accessToken first since authorize format is now fixed
      const mdToken = token; // use same accessToken for both REST and WS
      logger.info('Using accessToken for WS auth (has Prices:Read ACL)');

      // Wait for the WebSocket session to end (disconnect/error)
      await new Promise<void>((resolve) => {
        wsClient = new TradovateWsClient(wsUrl, {
          onQuote: handleQuote,
          onConnected: () => {
            backoff = 1000; // Reset backoff on successful connection
            logger.info({ symbol }, 'Sidecar ready — receiving quotes');
          },
          onDisconnected: (reason) => {
            logger.warn({ reason }, 'Disconnected');
            aggregator?.flush();
            if (safetyFlushTimer) clearInterval(safetyFlushTimer);
            resolve();
          },
        });
        wsClient.connect(mdToken, symbol, contractId);
      });

      // Connection ended — fall through to backoff below
    } catch (err) {
      logger.error({ err, backoff }, 'Connection attempt failed');
    }

    if (isShuttingDown) break;
    logger.info({ backoff }, 'Reconnecting after backoff');
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
  }
}

async function main(): Promise<void> {
  logger.info('ES relay sidecar starting');
  const required = [
    'DATABASE_URL',
    'TRADOVATE_BASE_URL',
    'TRADOVATE_MD_URL',
    'TRADOVATE_USERNAME',
    'TRADOVATE_PASSWORD',
  ];
  for (const key of required) {
    if (!process.env[key]) {
      logger.error({ key }, 'Missing required environment variable');
      process.exit(1);
    }
  }
  await verifyConnection();
  startHealthServer({
    isWsConnected: () => wsClient?.isConnected ?? false,
    lastQuoteAt: () => lastQuoteTime,
    isDbHealthy: async () => {
      try {
        await getPool().query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },
  });
  // connectWithRetry loops internally with backoff
  await connectWithRetry();
}

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ signal }, 'Shutting down gracefully');
  wsClient?.disconnect();
  aggregator?.flush();
  if (safetyFlushTimer) clearInterval(safetyFlushTimer);
  await new Promise((r) => setTimeout(r, 1000));
  await drainPool();
  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  logger.error({ err }, 'Fatal error in main');
  process.exit(1);
});
