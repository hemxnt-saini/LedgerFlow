import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Toasts } from './components/Toasts';
import { ControlsPage } from './features/controls/ControlsPage';
import { KafkaPage } from './features/kafka/KafkaPage';
import { LedgerPage } from './features/ledger/LedgerPage';
import { PipelinePage } from './features/pipeline/PipelinePage';
import { WalletPage } from './features/wallet/WalletPage';

const TITLES: Record<string, string> = {
  '/': 'Wallet',
  '/ledger': 'Ledger',
  '/controls': 'Controls',
  '/pipeline': 'Event monitor',
  '/kafka': 'Kafka control room',
};

/** One document, several pages - so the tab title has to be set by hand. */
function DocumentTitle() {
  const { pathname } = useLocation();
  useEffect(() => {
    document.title = TITLES[pathname] ?? 'Wallet';
  }, [pathname]);
  return null;
}

export function App() {
  return (
    <>
      <DocumentTitle />
      <Routes>
        <Route path="/" element={<WalletPage />} />
        <Route path="/ledger" element={<LedgerPage />} />
        <Route path="/controls" element={<ControlsPage />} />
        <Route path="/pipeline" element={<PipelinePage />} />
        <Route path="/kafka" element={<KafkaPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toasts />
    </>
  );
}
