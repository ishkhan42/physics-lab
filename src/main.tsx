import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import App from './App.tsx';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Mission Board root element is missing.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
