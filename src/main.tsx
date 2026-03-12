import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import StrikeCalculator from './App';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element not found');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <StrikeCalculator />
  </React.StrictMode>,
);
