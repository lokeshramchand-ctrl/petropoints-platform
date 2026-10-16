import type { Page, SlipView, TransactionView } from '@petropoints/contracts';
import { MobileApiClient } from '@petropoints/mobile-core';
import { secureStore } from '@petropoints/mobile-ui';

// Android emulator reaches the host machine at 10.0.2.2. Real builds set EXPO_PUBLIC_API_URL.
const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:3000';

export const client = new MobileApiClient(BASE_URL, secureStore);

export interface Wallet {
  customerId: string;
  name: string;
  mobile: string;
  balance: number;
}

export const api = {
  wallet: () => client.request<Wallet>('/v1/me/wallet'),
  history: (cursor?: string) =>
    client.request<Page<TransactionView>>(
      `/v1/transactions?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),
  slip: (id: string) => client.request<SlipView>(`/v1/transactions/${id}/slip`),
  verify: (slip: SlipView) =>
    client.request<{ valid: boolean }>('/v1/transactions/slips/verify', {
      method: 'POST',
      body: slip,
    }),
  register: (b: { name: string; email: string; mobile: string; password: string; city?: string }) =>
    client.request<{ userId: string }>('/v1/auth/register', { method: 'POST', body: b }),
};
