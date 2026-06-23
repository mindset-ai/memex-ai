import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { UnsupportedBrowserBanner } from './components/UnsupportedBrowserBanner';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* spec-290 dec-3: below-floor browser notice — first in the tree so it
        paints with the app rather than after a flash of broken UI. */}
    <UnsupportedBrowserBanner />
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);
