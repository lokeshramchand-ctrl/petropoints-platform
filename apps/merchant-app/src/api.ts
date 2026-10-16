import type {
  EarnPointsRequest,
  Page,
  RedeemPointsRequest,
  SlipView,
  TransactionView,
} from '@petropoints/contracts';
import {
  MobileApiClient,
  type KeyValueStore,
  type PosApi,
  type PosResult,
} from '@petropoints/mobile-core';
import { secureStore } from '@petropoints/mobile-ui';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { deviceSerial } from './device';

const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:3000';

/** Non-secret, larger blobs (offline queue). Tokens stay in the Keystore-backed secureStore. */
export const asyncStore: KeyValueStore = {
  get: (k) => AsyncStorage.getItem(k),
  set: (k, v) => AsyncStorage.setItem(k, v),
  remove: (k) => AsyncStorage.removeItem(k),
};

// Every request identifies the handset, so the server can verify it is registered to this outlet.
export const client = new MobileApiClient(
  BASE_URL,
  secureStore,
  undefined,
  (): Record<string, string> => {
    const serial = deviceSerial();
    return serial ? { 'x-device-serial': serial } : {};
  },
);

export interface CustomerLookup {
  customerId: string;
  name: string;
  mobileMasked: string;
  balance: number;
}
export interface Outlet {
  id: string;
  code: string;
  name: string;
}
export interface DailyRow {
  day: string;
  earned: number;
  redeemed: number;
  salesPaise: number;
  transactions: number;
}

export const posApi: PosApi = {
  earn: (body: EarnPointsRequest, key) =>
    client.request<PosResult>('/v1/points/earn', { method: 'POST', body, idempotencyKey: key }),
  redeem: (body: RedeemPointsRequest, key) =>
    client.request<PosResult>('/v1/points/redeem', { method: 'POST', body, idempotencyKey: key }),
};

export const api = {
  lookup: (mobile: string) =>
    client.request<CustomerLookup>(
      `/v1/points/customers/lookup?mobile=${encodeURIComponent(mobile)}`,
    ),
  outlets: (merchantId: string) => client.request<Outlet[]>(`/v1/merchants/${merchantId}/outlets`),
  daily: (merchantId: string, days: number) =>
    client.request<DailyRow[]>(`/v1/merchants/${merchantId}/reports/daily?days=${days}`),
  transactions: (cursor?: string) =>
    client.request<Page<TransactionView>>(
      `/v1/transactions?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),
  slip: (id: string) => client.request<SlipView>(`/v1/transactions/${id}/slip`),
  reverse: (id: string, reason: string, key: string) =>
    client.request<PosResult>(`/v1/transactions/${id}/reverse`, {
      method: 'POST',
      body: { reason },
      idempotencyKey: key,
    }),
};
