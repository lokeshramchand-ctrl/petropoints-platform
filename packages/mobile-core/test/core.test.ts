import type { SlipView } from '@petropoints/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  EscPosBuilder,
  MemoryPrinter,
  MemoryStore,
  MobileApiClient,
  OfflineQueue,
  encodeSlip,
  formatRupees,
  isRetryable,
  normaliseMobile,
  parseRupeesToPaise,
  parseSlipQr,
  slipLines,
  slipQrPayload,
  toPrinterAscii,
  twoCol,
} from '../src/index';

const slip: SlipView = {
  slipNumber: 'ALP1-20261016-000042',
  transactionId: '3b241101-e2bb-4255-8caf-4136c566a962',
  type: 'EARN',
  merchantName: 'Alpha Fuels',
  outletName: 'Anna Nagar',
  customerName: 'Ravi Kumar',
  customerMobileMasked: '+91*******210',
  points: 25,
  balanceAfter: 1325,
  amountPaise: 250_000,
  createdAt: '2026-10-16T09:02:00.000Z',
  signature: 'sig_abc-123',
};

describe('money + mobile parsing', () => {
  it.each([
    ['2500', 250_000],
    ['2,500.5', 250_050],
    ['₹ 99.99', 9_999],
    ['0.10', 10],
  ])('parseRupeesToPaise(%s)', (input, expected) =>
    expect(parseRupeesToPaise(input)).toBe(expected),
  );

  it.each(['', '0', '-5', 'abc', '12.345', '1e5', '999999999'])('rejects %s', (input) =>
    expect(parseRupeesToPaise(input)).toBeNull(),
  );

  it('never produces floating point drift', () => {
    expect(parseRupeesToPaise('0.07')).toBe(7);
    expect(parseRupeesToPaise('19.99')).toBe(1999);
  });

  it('normalises Indian mobiles and rejects invalid ones', () => {
    expect(normaliseMobile('98765 43210')).toBe('+919876543210');
    expect(normaliseMobile('+91-98765-43210')).toBe('+919876543210');
    expect(normaliseMobile('1234567890')).toBeNull(); // must start 6-9
    expect(normaliseMobile('98765')).toBeNull();
  });

  it('formats rupees in Indian grouping', () => {
    expect(formatRupees(123_456_700)).toContain('12,34,567');
  });
});

describe('slip printing', () => {
  it('every slip line fits a 58mm printer', () => {
    for (const l of slipLines(slip)) expect(l.length).toBeLessThanOrEqual(32);
  });

  it('lays out the key facts', () => {
    const text = slipLines(slip).join('\n');
    expect(text).toContain('ALPHA FUELS');
    expect(text).toContain('ALP1-20261016-000042');
    expect(text).toContain('+25 pts');
    expect(text).toContain('Rs 2,500.00');
    expect(text).toContain('1,325 pts');
  });

  it('shows redemptions as negative and omits the sale line', () => {
    const text = slipLines({ ...slip, type: 'REDEEM', points: -100, amountPaise: null }).join('\n');
    expect(text).toContain('POINTS REDEEMED');
    expect(text).toContain('-100 pts');
    expect(text).not.toContain('Sale amount');
  });

  it('transliterates to printer-safe ASCII', () => {
    expect(toPrinterAscii('₹500 café')).toBe('Rs 500 cafe');
    expect(toPrinterAscii('தமிழ்')).toMatch(/^\?+$/);
  });

  it('twoCol truncates the label, never the value', () => {
    const l = twoCol('A very long label that overflows', '1,325 pts');
    expect(l.length).toBe(32);
    expect(l.endsWith('1,325 pts')).toBe(true);
  });

  it('encodes ESC/POS: init first, QR block present, paper cut last', () => {
    const bytes = encodeSlip(slip);
    expect([...bytes.slice(0, 2)]).toEqual([0x1b, 0x40]); // ESC @
    expect([...bytes.slice(-4)]).toEqual([0x1d, 0x56, 0x42, 0x00]); // GS V B 0
    const hex = Buffer.from(bytes).toString('hex');
    expect(hex).toContain('1d286b0400314132' + '00'); // QR model 2
    expect(hex).toContain('1d286b0300315130'); // print stored QR
    expect(Buffer.from(bytes).toString('latin1')).toContain('PP1|ALP1-20261016-000042');
  });

  it('QR store-data length header matches the payload', () => {
    const b = new EscPosBuilder().qr('HELLO').build();
    const i = b.findIndex((_, k) => b[k] === 0x31 && b[k + 1] === 0x50 && b[k + 2] === 0x30);
    const len = b[i - 2]! | (b[i - 1]! << 8); // pL pH precede the 31 50 30 header
    expect(len).toBe('HELLO'.length + 3);
  });

  it('refuses an oversized QR payload', () => {
    expect(() => new EscPosBuilder().qr('x'.repeat(701))).toThrow(/QR payload/);
  });

  it('slip QR round-trips and rejects tampered payloads', () => {
    const parsed = parseSlipQr(slipQrPayload(slip));
    expect(parsed).toEqual({
      slipNumber: slip.slipNumber,
      transactionId: slip.transactionId,
      points: 25,
      createdAt: slip.createdAt,
      signature: slip.signature,
    });
    expect(parseSlipQr('PP2|a|b|1|c|d')).toBeNull();
    expect(parseSlipQr('PP1|a|b|NaN|c|d')).toBeNull();
    expect(parseSlipQr(slipQrPayload(slip) + '|extra')).toBeNull();
  });

  it('MemoryPrinter records jobs', async () => {
    const p = new MemoryPrinter();
    await p.print(encodeSlip(slip));
    expect(p.jobs).toHaveLength(1);
  });
});

describe('OfflineQueue', () => {
  const make = () => {
    let n = 0;
    return new OfflineQueue<{ amount: number }, string>(
      new MemoryStore(),
      () => `cmd-${++n}`,
      () => new Date('2026-10-16T00:00:00Z'),
    );
  };
  const reject = (status: number, code = 'X') => new ApiError(status, code, `rejected ${status}`);

  it('sends commands in order and empties the queue', async () => {
    const q = make();
    await q.enqueue('earn', { amount: 1 });
    await q.enqueue('redeem', { amount: 2 });
    const order: string[] = [];
    const res = await q.flush(async (c) => (order.push(c.id), `ok-${c.id}`));
    expect(order).toEqual(['cmd-1', 'cmd-2']);
    expect(res).toMatchObject({ remaining: 0, failed: [] });
    expect(await q.size()).toBe(0);
  });

  it('stops at a network error, keeps order, and resumes later', async () => {
    const q = make();
    await q.enqueue('earn', { amount: 1 });
    await q.enqueue('earn', { amount: 2 });
    const offline = await q.flush(async () => {
      throw new TypeError('Network request failed');
    });
    expect(offline).toMatchObject({ remaining: 2, sent: [] });
    const online = await q.flush(async (c) => c.id);
    expect(online.sent.map((s) => s.command.id)).toEqual(['cmd-1', 'cmd-2']);
  });

  it('retries 5xx / 429 later but parks 4xx rejections without blocking the rest', async () => {
    const q = make();
    await q.enqueue('earn', { amount: 1 }); // will be rejected permanently
    await q.enqueue('earn', { amount: 2 }); // fine
    const res = await q.flush(async (c) => {
      if (c.id === 'cmd-1') throw reject(409, 'INSUFFICIENT_POINTS');
      return 'ok';
    });
    expect(res.sent).toHaveLength(1);
    expect(res.failed[0]).toMatchObject({ code: 'INSUFFICIENT_POINTS' });
    expect((await q.deadLetters())[0]?.command.id).toBe('cmd-1');

    expect(isRetryable(reject(503))).toBe(true);
    expect(isRetryable(reject(429))).toBe(true);
    expect(isRetryable(reject(422))).toBe(false);
  });

  it('survives an app restart: a second instance on the same store sees the pending work', async () => {
    const store = new MemoryStore();
    const a = new OfflineQueue<{ amount: number }, string>(store, () => 'id-1');
    await a.enqueue('earn', { amount: 5 });
    const b = new OfflineQueue<{ amount: number }, string>(store, () => 'id-2');
    expect(await b.size()).toBe(1);
  });

  it('does not resend a command that already succeeded if the app crashes mid-flush', async () => {
    const store = new MemoryStore();
    const q = new OfflineQueue<{ amount: number }, string>(
      store,
      (() => {
        let n = 0;
        return () => `c${++n}`;
      })(),
    );
    await q.enqueue('earn', { amount: 1 });
    await q.enqueue('earn', { amount: 2 });
    await expect(
      q.flush(async (c) => {
        if (c.id === 'c2') throw new Error('process killed');
        return 'ok';
      }),
    ).resolves.toMatchObject({ remaining: 1 }); // c1 done; the generic Error on c2 is retryable
    // c1 was persisted as sent before c2 was attempted, so a fresh process only resends c2
    const sentAgain: string[] = [];
    await new OfflineQueue<{ amount: number }, string>(store, () => 'x').flush(
      async (c) => (sentAgain.push(c.id), 'ok'),
    );
    expect(sentAgain).toEqual(['c2']);
  });

  it('a corrupted blob cannot brick the terminal', async () => {
    const store = new MemoryStore();
    await store.set('pp.pos.queue', '{not json');
    expect(await new OfflineQueue(store, () => 'x').size()).toBe(0);
  });

  it('concurrent flushes share one run', async () => {
    const q = make();
    await q.enqueue('earn', { amount: 1 });
    const send = vi.fn(async () => 'ok');
    const [a, b] = await Promise.all([q.flush(send), q.flush(send)]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });
});

describe('MobileApiClient', () => {
  const json = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status });
  const pair = (n: number) => ({
    accessToken: `a${n}`,
    refreshToken: `r${n}`,
    expiresInSeconds: 900,
  });

  it('refreshes once on 401 and persists the rotated token', async () => {
    const store = new MemoryStore();
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/v1/auth/refresh')) return json(200, pair(2));
      return (init.headers as Record<string, string>).authorization === 'Bearer a2'
        ? json(200, { ok: 1 })
        : json(401, { error: { code: 'UNAUTHORIZED', message: 'x' } });
    });
    const c = new MobileApiClient('https://api.test', store, fetchImpl as never);
    await c.setTokens(pair(1));
    await expect(c.request('/v1/me')).resolves.toEqual({ ok: 1 });
    expect(await store.get('pp.refresh')).toBe('r2');
  });

  it('keeps the session when the refresh fails because the phone is offline', async () => {
    const store = new MemoryStore();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/auth/refresh')) throw new TypeError('Network request failed');
      return json(401, { error: { code: 'UNAUTHORIZED', message: 'expired' } });
    });
    const c = new MobileApiClient('https://api.test', store, fetchImpl as never);
    const expired = vi.fn();
    c.onSessionExpired = expired;
    await c.setTokens(pair(1));
    await expect(c.request('/v1/me')).rejects.toMatchObject({ status: 401 });
    expect(expired).not.toHaveBeenCalled();
    expect(await store.get('pp.refresh')).toBe('r1');
  });

  it('signs out when the server rejects the refresh token', async () => {
    const store = new MemoryStore();
    const fetchImpl = vi.fn(async () =>
      json(401, { error: { code: 'UNAUTHORIZED', message: 'x' } }),
    );
    const c = new MobileApiClient('https://api.test', store, fetchImpl as never);
    const expired = vi.fn();
    c.onSessionExpired = expired;
    await c.setTokens(pair(1));
    await expect(c.request('/v1/me')).rejects.toBeInstanceOf(ApiError);
    expect(expired).toHaveBeenCalledOnce();
    expect(await c.hasSession()).toBe(false);
  });

  it('sends idempotency + device headers', async () => {
    const fetchImpl = vi.fn(async (_u: string, _i: RequestInit) => json(200, {}));
    const c = new MobileApiClient(
      'https://api.test',
      new MemoryStore(),
      fetchImpl as never,
      () => ({ 'x-device-serial': 'POS-1' }),
    );
    await c.request('/v1/points/earn', {
      method: 'POST',
      body: {},
      idempotencyKey: 'key-1234567890abcdef',
    });
    const h = fetchImpl.mock.calls[0]![1].headers as Record<string, string>;
    expect(h['idempotency-key']).toBe('key-1234567890abcdef');
    expect(h['x-device-serial']).toBe('POS-1');
  });

  it('aborts a hung request after the timeout', async () => {
    const fetchImpl = vi.fn(
      (_u: string, init: RequestInit) =>
        new Promise<Response>((_res, rej) =>
          init.signal!.addEventListener('abort', () =>
            rej(new DOMException('aborted', 'AbortError')),
          ),
        ),
    );
    const c = new MobileApiClient('https://api.test', new MemoryStore(), fetchImpl as never);
    const err = (await c.request('/slow', { timeoutMs: 20 }).catch((e: unknown) => e)) as Error;
    expect(err.name).toBe('AbortError');
    expect(isRetryable(err)).toBe(true);
  });
});
