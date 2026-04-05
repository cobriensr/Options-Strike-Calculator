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

// Suppress Kasada SDK "already configured" noise — race condition in botid SDK
globalThis.addEventListener('unhandledrejection', (e) => {
  if (
    e.reason instanceof Error &&
    e.reason.message.includes('KPSDK has already been configured')
  ) {
    e.preventDefault();
  }
});

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
    { path: '/api/vix-ohlc', method: 'GET' },
    { path: '/api/pre-market', method: 'GET' },
    { path: '/api/pre-market', method: 'POST' },
    { path: '/api/iv-term-structure', method: 'GET' },
    { path: '/api/ml/export', method: 'GET' },
    { path: '/api/ml/prediction', method: 'GET' },
    { path: '/api/bwb-anchor', method: 'GET' },
    { path: '/api/futures/snapshot', method: 'GET' },
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
