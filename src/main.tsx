import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/react';
import './index.css';
import StrikeCalculator from './App';
import ErrorBoundary from './components/ErrorBoundary';

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN || undefined,
  integrations: [Sentry.browserTracingIntegration()],
  sendDefaultPii: true,
  tracesSampleRate: 0.2,
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
