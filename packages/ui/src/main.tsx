import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { VisitorConsent } from './components/VisitorConsent';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
      {/* spec-254 t-3 — app-wide opt-in consent banner + consent-gated visitor_id mint. */}
      <VisitorConsent />
    </BrowserRouter>
  </StrictMode>
);
