import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { getCurrentDictionary } from './i18n';
import { applyTheme, storedTheme } from './lib/theme';
import './styles.css';

applyTheme(storedTheme());
const root = document.getElementById('root');
if (root === null) throw new Error(getCurrentDictionary().shell.rootMissing);
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
