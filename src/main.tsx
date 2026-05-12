import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/react';
import { initBotId } from 'botid/client/core';
import { registerSW } from 'virtual:pwa-register';
import './index.css';
import StrikeCalculator from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { ToastProvider } from './components/Toast';
import { markNeedsRefresh, setUpdateFn } from './lib/sw-update';
import { installAuthInterceptor } from './utils/authInterceptor';

if (import.meta.env.DEV) {
  import('@vercel/toolbar/vite').then(({ mountVercelToolbar }) =>
    mountVercelToolbar(),
  );
}

// Self-healing 401 handler: when the server reports the session is gone
// but a stale JS-visible hint cookie still tells the UI we're owner/guest,
// the user gets stuck with no Sign-in CTA. The interceptor wipes the hint
// and notifies useAccessSession so the public-mode UI surfaces immediately.
installAuthInterceptor();

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

// Register the service worker in prompt mode. When a new SW reaches the
// waiting state, vite-plugin-pwa fires `onNeedRefresh` — we surface this
// to React via the sw-update bridge so UpdateAvailableBanner can render
// a "New version available" toast with a Reload button. The reload itself
// is wired up lazily in `applyUpdate()` so that first-install
// controllerchange events don't trigger a spurious reload mid-load (which
// was aborting in-flight XHRs as NS_BINDING_ABORTED on every page open).
const updateSW = registerSW({
  onNeedRefresh() {
    markNeedsRefresh();
  },
});
setUpdateFn(updateSW);

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
      { path: '/api/periscope-playbook', method: 'GET' },
      { path: '/api/periscope-chat-list', method: 'GET' },
      { path: '/api/periscope-chat-detail', method: 'GET' },
      { path: '/api/periscope-chat-image', method: 'GET' },
      { path: '/api/periscope-chat-update', method: 'PATCH' },
      { path: '/api/periscope-chat-update', method: 'POST' },
      { path: '/api/periscope-lessons-list', method: 'GET' },
      { path: '/api/periscope-lessons-update', method: 'POST' },
      { path: '/api/greek-flow', method: 'GET' },
      { path: '/api/gex-strike-expiry', method: 'GET' },
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
      { path: '/api/periscope-exposure', method: 'GET' },
      { path: '/api/ml/trigger-analyze', method: 'POST' },
      { path: '/api/darkpool-levels', method: 'GET' },
      { path: '/api/alerts', method: 'GET' },
      { path: '/api/alerts-ack', method: 'POST' },
      { path: '/api/interval-ba-alerts', method: 'GET' },
      { path: '/api/interval-ba-alerts-ack', method: 'POST' },
      { path: '/api/vega-spikes', method: 'GET' },
      { path: '/api/greek-exposure-strike', method: 'GET' },
      { path: '/api/zero-gamma', method: 'GET' },
      { path: '/api/dealer-regime', method: 'GET' },
      { path: '/api/vix-snapshots-recent', method: 'GET' },
      { path: '/api/ml/analyze-plots', method: 'POST' },
      { path: '/api/cron/warm-tbbo-percentile', method: 'GET' },
      { path: '/api/lottery-finder', method: 'GET' },
      { path: '/api/lottery-export', method: 'GET' },
      { path: '/api/lottery-contract-tape', method: 'GET' },
      { path: '/api/silent-boom-feed', method: 'GET' },
      { path: '/api/silent-boom-export', method: 'GET' },
      { path: '/api/net-flow-history', method: 'GET' },
      { path: '/api/ticker-candles', method: 'GET' },
      { path: '/api/strike-trade-volume', method: 'GET' },
      { path: '/api/system-status', method: 'GET' },
      { path: '/api/auth/guest-key', method: 'POST' },
      { path: '/api/auth/guest-logout', method: 'POST' },
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
