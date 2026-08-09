import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type Tone = '' | 'good' | 'warn' | 'bad';

interface Toast {
  id: number;
  text: string;
  tone: Tone;
}

interface ToastApi {
  toasts: Toast[];
  toast: (text: string, tone?: Tone) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const LIFETIME_MS = 4_200;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const toast = useCallback((text: string, tone: Tone = '') => {
    const id = nextId.current++;
    setToasts((current) => [...current, { id, text, tone }]);
    setTimeout(
      () => setToasts((current) => current.filter((item) => item.id !== id)),
      LIFETIME_MS,
    );
  }, []);

  const value = useMemo(() => ({ toasts, toast }), [toasts, toast]);
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToasts(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToasts must be used inside a ToastProvider');
  return context;
}
