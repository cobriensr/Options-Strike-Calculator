import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/react';
import { initBotId } from 'botid/client/core';
import './index.css';
import StrikeCalculator from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { ToastProvider } from './components/Toast';

if (import.meta.env.DEV) {
  import('@vercel/toolbar/vite').then(({ mountVercelToolbar }) =>
    mountVercelToolbar(),
  );
}

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN || undefined,
  integrations: [Sentry.browserTracingIntegration()],
  sendDefaultPii: false,
  tracesSampleRate: 0.2,
  tracePropagationTargets: ['localhost', /^https:\/\/0dte\.vercel\.app\/api/],
  enabled: import.meta.env.PROD,
  beforeSend(event) {
    const frames =
      event.exception?.values?.flatMap((v) => v.stacktrace?.frames ?? []) ?? [];
    if (frames.some((f) => f.filename?.includes('vercel.live'))) return null;
    const messages = event.exception?.values?.map((v) => v.value) ?? [];
    if (messages.some((m) => m?.includes('KPSDK has already been configured')))
      return null;
    return event;
  },
});

// Reload when the service worker takes over a new deployment so the page picks
// up the new JS bundle (and fresh BotID tokens) automatically.
if ('serviceWorker' in navigator) {
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}

// Suppress Kasada SDK "already configured" noise — race condition in botid SDK
globalThis.addEventListener('unhandledrejection', (e) => {
  if (
    e.reason instanceof Error &&
    e.reason.message.includes('KPSDK has already been configured')
  ) {
    e.preventDefault();
  }
});

// BotID challenge scripts are served by the Vercel edge, not by the Vite dev
// server. Calling initBotId() in dev causes a 404 for the challenge script and
// a console error. The guard here keeps dev clean without affecting production.
if (import.meta.env.PROD)
  initBotId({
    protect: [
      { path: '/api/quotes', method: 'GET' },
      { path: '/api/chain', method: 'GET' },
      { path: '/api/history', method: 'GET' },
      { path: '/api/intraday', method: 'GET' },
      { path: '/api/movers', method: 'GET' },
      { path: '/api/yesterday', method: 'GET' },
      { path: '/api/events', method: 'GET' },
      { path: '/api/journal', method: 'GET' },
      { path: '/api/journal/status', method: 'GET' },
      { path: '/api/journal/init', method: 'POST' },
      { path: '/api/journal/migrate', method: 'POST' },
      { path: '/api/journal/backfill-features', method: 'POST' },
      { path: '/api/analyses', method: 'GET' },
      { path: '/api/snapshot', method: 'POST' },
      { path: '/api/analyze', method: 'POST' },
      { path: '/api/positions', method: 'GET' },
      { path: '/api/positions', method: 'POST' },
      { path: '/api/vix-ohlc', method: 'GET' },
      { path: '/api/pre-market', method: 'GET' },
      { path: '/api/pre-market', method: 'POST' },
      { path: '/api/iv-term-structure', method: 'GET' },
      { path: '/api/ml/export', method: 'GET' },
      { path: '/api/ml/prediction', method: 'GET' },
      { path: '/api/bwb-anchor', method: 'GET' },
      { path: '/api/futures/snapshot', method: 'GET' },
      { path: '/api/gex-target-history', method: 'GET' },
      { path: '/api/nope-intraday', method: 'GET' },
      { path: '/api/options-flow/top-strikes', method: 'GET' },
      { path: '/api/options-flow/whale-positioning', method: 'GET' },
      { path: '/api/market-internals/history', method: 'GET' },
      { path: '/api/ml/trigger-analyze', method: 'POST' },
      { path: '/api/darkpool-levels', method: 'GET' },
      { path: '/api/alerts', method: 'GET' },
      { path: '/api/alerts-ack', method: 'POST' },
      { path: '/api/gex-per-strike', method: 'GET' },
      { path: '/api/greek-exposure-strike', method: 'GET' },
      { path: '/api/vix-snapshots-recent', method: 'GET' },
      { path: '/api/ml/analyze-plots', method: 'POST' },
      { path: '/api/cron/warm-tbbo-percentile', method: 'GET' },
    ],
  });

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element not found');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ToastProvider>
        <StrikeCalculator />
      </ToastProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
