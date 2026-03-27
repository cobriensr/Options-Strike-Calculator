import http from 'node:http';
import logger from './logger.js';

interface HealthDeps {
  isWsConnected: () => boolean;
  lastQuoteAt: () => number;
  isDbHealthy: () => Promise<boolean>;
}

function isQuoteExpected(): boolean {
  const now = new Date();
  const et = new Date(
    now.toLocaleString('en-US', { timeZone: 'America/New_York' }),
  );
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const hour = et.getHours();
  if (hour === 17) return false; // 5-6 PM ET maintenance
  return true;
}

export function startHealthServer(deps: HealthDeps): http.Server {
  const port = parseInt(process.env.PORT ?? '8080', 10);

  const server = http.createServer(async (req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const checks = { ws: deps.isWsConnected(), quoteFresh: true, db: false };

    if (isQuoteExpected()) {
      const staleness = Date.now() - deps.lastQuoteAt();
      checks.quoteFresh = staleness < 120_000;
    }

    try {
      checks.db = await deps.isDbHealthy();
    } catch {
      checks.db = false;
    }

    const healthy = checks.ws && checks.quoteFresh && checks.db;
    res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: healthy ? 'ok' : 'degraded', checks }));
  });

  server.listen(port, () => {
    logger.info({ port }, 'Health server listening');
  });
  return server;
}
