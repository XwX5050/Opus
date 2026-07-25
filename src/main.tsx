import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './app/App';
import './theme/tokens.css';
import './theme/app.css';

// Inside the Tauri window the titlebar is overlaid (titleBarStyle: Overlay),
// so the header leaves room for the native traffic lights.
if ('__TAURI_INTERNALS__' in window) {
  document.documentElement.classList.add('tauri');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
