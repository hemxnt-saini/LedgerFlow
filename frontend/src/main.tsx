import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { AppStreamProvider } from './hooks/useAppStream';
import { ToastProvider } from './hooks/useToasts';
import './styles/global.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AppStreamProvider>
          <App />
        </AppStreamProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
