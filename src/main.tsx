import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/react';
import { initBotId } from 'botid/client/core';
import './index.css';
import StrikeCalculator from './App';
import ErrorBoundary from './components/ErrorBoundary';

if (import.meta.env.DEV) {
  import('@vercel/toolbar/vite').then(({ mountVercelToolbar }) =>
    mountVercelToolbar(),
  );
}

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
    { path: '/api/analyses', method: 'GET' },
    { path: '/api/snapshot', method: 'POST' },
    { path: '/api/analyze', method: 'POST' },
    { path: '/api/positions', method: 'GET' },
    { path: '/api/positions', method: 'POST' },
  ],
});

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN || undefined,
  integrations: [Sentry.browserTracingIntegration()],
  sendDefaultPii: true,
  tracesSampleRate: 1.0,
  tracePropagationTargets: ['localhost', /^https:\/\/0dte\.vercel\.app\/api/],
  enableLogs: true,
  enabled: import.meta.env.PROD,
});

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element not found');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <ErrorBoundary>
      <StrikeCalculator />
    </ErrorBoundary>
  </React.StrictMode>,
);
