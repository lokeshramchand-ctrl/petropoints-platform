import {
  OfflineQueue,
  PosTerminal,
  type PosPayload,
  type PosResult,
} from '@petropoints/mobile-core';
import NetInfo from '@react-native-community/netinfo';
import * as Crypto from 'expo-crypto';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';
import { asyncStore, posApi } from './api';
import { createPrinter } from './printer';

interface PosState {
  terminal: PosTerminal;
  /** commands waiting for connectivity */
  pending: number;
  /** re-read the pending count (call after submitting a sale) */
  refresh(): Promise<void>;
  syncNow(): Promise<void>;
}

const Ctx = createContext<PosState | null>(null);

export function PosProvider({ children }: { children: ReactNode }) {
  const terminal = useMemo(() => {
    const queue = new OfflineQueue<PosPayload, PosResult>(asyncStore, () => Crypto.randomUUID());
    return new PosTerminal(queue, posApi, createPrinter());
  }, []);
  const [pending, setPending] = useState(0);

  const refresh = useCallback(async () => setPending(await terminal.pending()), [terminal]);
  const syncNow = useCallback(async () => {
    try {
      await terminal.sync();
    } finally {
      await refresh();
    }
  }, [terminal, refresh]);

  useEffect(() => {
    void syncNow();
    // retry whenever the network comes back, and whenever the app returns to the foreground
    const unsubNet = NetInfo.addEventListener((s) => {
      if (s.isConnected && s.isInternetReachable !== false) void syncNow();
    });
    const sub = AppState.addEventListener('change', (s) => s === 'active' && void syncNow());
    return () => {
      unsubNet();
      sub.remove();
    };
  }, [syncNow]);

  const value = useMemo(
    () => ({ terminal, pending, refresh, syncNow }),
    [terminal, pending, refresh, syncNow],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePos(): PosState {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePos must be used inside <PosProvider>');
  return v;
}
