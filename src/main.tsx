import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './app/App';
import { detectPathPlatform } from './document/platform';
import './theme/tokens.css';
import './theme/app.css';

// On macOS the titlebar is overlaid (titleBarStyle: Overlay), so the header
// leaves room for the native traffic lights. Other platforms get standard
// decorations and need no such padding.
if ('__TAURI_INTERNALS__' in window && detectPathPlatform() === 'macos') {
  document.documentElement.classList.add('tauri');
}

// On Linux, never let a native HTML5 drag start inside the webview: every
// in-page drag (selected text, image widgets) takes a WebKitGTK seat grab
// that wedges the whole app under wlroots compositors. Nothing in the app
// initiates drags intentionally, and files dropped from outside still fire
// `drop` (they never emit a local `dragstart`), so nothing is lost. macOS
// keeps the native behavior.
if (detectPathPlatform() === 'linux') {
  document.addEventListener('dragstart', (event) => event.preventDefault());
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
