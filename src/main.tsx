import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import StrikeCalculator from './App';
import ErrorBoundary from './components/ErrorBoundary';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element not found');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <ErrorBoundary>
      <StrikeCalculator />
    </ErrorBoundary>
  </React.StrictMode>,
);
