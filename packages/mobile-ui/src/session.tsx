import type { KeyValueStore, MobileApiClient } from '@petropoints/mobile-core';
import type { TokenPair } from '@petropoints/contracts';
import type { Principal, Role } from '@petropoints/rbac';
import * as SecureStore from 'expo-secure-store';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/** Keychain / Keystore-backed storage for tokens. */
export const secureStore: KeyValueStore = {
  get: (k) => SecureStore.getItemAsync(k),
  set: (k, v) => SecureStore.setItemAsync(k, v),
  remove: (k) => SecureStore.deleteItemAsync(k),
};

export interface SessionUser extends Principal {
  name: string;
}

interface LoginResponse extends TokenPair {
  user: {
    id: string;
    name: string;
    role: Role;
    merchantId: string | null;
    outletId: string | null;
  };
}

interface SessionState {
  user: SessionUser | null;
  /** true while a stored session is being restored at launch */
  restoring: boolean;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
}

const Ctx = createContext<SessionState | null>(null);
const USER_KEY = 'pp.user';

export class WrongAppError extends Error {
  constructor(app: string) {
    super(`This account can’t be used in the ${app} app.`);
    this.name = 'WrongAppError';
  }
}

export function SessionProvider({
  client,
  allowedRoles,
  appName,
  children,
}: {
  client: MobileApiClient;
  /** Roles that may sign in to THIS app; other valid accounts are rejected before tokens are kept. */
  allowedRoles: readonly Role[];
  appName: string;
  children: ReactNode;
}) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [restoring, setRestoring] = useState(true);

  const clear = useCallback(async () => {
    await client.setTokens(null);
    await secureStore.remove(USER_KEY);
    setUser(null);
  }, [client]);

  useEffect(() => {
    client.onSessionExpired = () => void clear();
    let cancelled = false;
    void (async () => {
      try {
        const raw = await secureStore.get(USER_KEY);
        if (raw && (await client.hasSession())) {
          const saved = JSON.parse(raw) as SessionUser;
          if (allowedRoles.includes(saved.role) && !cancelled) setUser(saved);
        }
      } catch {
        /* unreadable secure storage: fall through to the login screen */
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, clear, allowedRoles]);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await client.request<LoginResponse>('/v1/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      if (!allowedRoles.includes(res.user.role)) throw new WrongAppError(appName);
      await client.setTokens(res);
      const u: SessionUser = {
        userId: res.user.id,
        name: res.user.name,
        role: res.user.role,
        merchantId: res.user.merchantId,
        outletId: res.user.outletId,
      };
      await secureStore.set(USER_KEY, JSON.stringify(u));
      setUser(u);
    },
    [client, allowedRoles, appName],
  );

  const logout = useCallback(async () => {
    const refreshToken = await client.getRefreshToken();
    if (refreshToken)
      await client
        .request('/v1/auth/logout', { method: 'POST', body: { refreshToken } })
        .catch(() => undefined);
    await clear();
  }, [client, clear]);

  const value = useMemo(
    () => ({ user, restoring, login, logout }),
    [user, restoring, login, logout],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession must be used inside <SessionProvider>');
  return v;
}
