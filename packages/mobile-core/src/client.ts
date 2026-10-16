import type { TokenPair } from '@petropoints/contracts';
import type { KeyValueStore } from './storage';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** True for failures worth retrying later: no connectivity, timeouts, 5xx, 408, 429. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof ApiError) return err.status >= 500 || err.status === 408 || err.status === 429;
  return true; // fetch() rejects with a TypeError when offline
}

const REFRESH_KEY = 'pp.refresh';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  idempotencyKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Platform-agnostic API client for React Native.
 * - access token lives in memory; refresh token in the injected (secure) store
 * - one transparent refresh on 401; concurrent refreshes are collapsed into one
 * - every request has a timeout, because a hung socket at a pump is worse than an error
 */
export class MobileApiClient {
  private accessToken: string | null = null;
  private refreshing: Promise<boolean> | null = null;
  onSessionExpired: () => void = () => undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly store: KeyValueStore,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    private readonly defaultHeaders: () => Record<string, string> = () => ({}),
  ) {}

  async setTokens(t: TokenPair | null) {
    this.accessToken = t?.accessToken ?? null;
    if (t) await this.store.set(REFRESH_KEY, t.refreshToken);
    else await this.store.remove(REFRESH_KEY);
  }

  async hasSession() {
    return (await this.store.get(REFRESH_KEY)) !== null;
  }

  async getRefreshToken() {
    return this.store.get(REFRESH_KEY);
  }

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.send(path, opts);
    if (res.status === 401 && path !== '/v1/auth/login' && (await this.refresh())) {
      return this.parse<T>(await this.send(path, opts));
    }
    return this.parse<T>(res);
  }

  refresh(): Promise<boolean> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<boolean> {
    const refreshToken = await this.store.get(REFRESH_KEY);
    if (!refreshToken) return false;
    let res: Response;
    try {
      res = await this.fetchWithTimeout('/v1/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
    } catch {
      return false; // offline: keep the session, the caller sees the original 401/network error
    }
    if (res.status === 401) {
      await this.setTokens(null);
      this.onSessionExpired();
      return false;
    }
    if (!res.ok) return false;
    await this.setTokens((await res.json()) as TokenPair);
    return true;
  }

  private send(path: string, o: RequestOptions) {
    const headers: Record<string, string> = { ...this.defaultHeaders(), ...o.headers };
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
    if (o.idempotencyKey) headers['idempotency-key'] = o.idempotencyKey;
    return this.fetchWithTimeout(
      path,
      {
        method: o.method ?? 'GET',
        headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
      },
      o.timeoutMs,
    );
  }

  private async fetchWithTimeout(path: string, init: RequestInit, timeoutMs = 15_000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async parse<T>(res: Response): Promise<T> {
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const e = data?.error;
      throw new ApiError(
        res.status,
        e?.code ?? 'HTTP_ERROR',
        e?.message ?? `Request failed (${res.status})`,
        e?.details,
        e?.requestId,
      );
    }
    return data as T;
  }
}
