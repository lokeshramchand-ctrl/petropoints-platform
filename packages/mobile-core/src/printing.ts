import type { SlipView } from '@petropoints/contracts';

/** Hardware abstraction. One adapter per handset SDK; the app only ever talks to this. */
export interface PrinterPort {
  readonly name: string;
  print(bytes: Uint8Array): Promise<void>;
}

export class PrinterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrinterError';
  }
}

/** Keeps what was "printed", for tests and for the on-screen preview during development. */
export class MemoryPrinter implements PrinterPort {
  readonly name = 'memory';
  readonly jobs: Uint8Array[] = [];
  async print(bytes: Uint8Array) {
    this.jobs.push(bytes);
  }
}

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

/** 58 mm thermal printers print 32 columns in the default font (80 mm: 48). */
export const COLS_58MM = 32;

/** Thermal printers speak a legacy code page: transliterate to plain ASCII rather than print garbage. */
export function toPrinterAscii(s: string): string {
  return s
    .replaceAll('₹', 'Rs ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '?');
}

export class EscPosBuilder {
  private readonly buf: number[] = [];

  init() {
    return this.raw(ESC, 0x40);
  }
  align(a: 'left' | 'center' | 'right') {
    return this.raw(ESC, 0x61, { left: 0, center: 1, right: 2 }[a]);
  }
  bold(on: boolean) {
    return this.raw(ESC, 0x45, on ? 1 : 0);
  }
  /** 1 = normal, 2 = double width and height */
  size(n: 1 | 2) {
    return this.raw(GS, 0x21, n === 2 ? 0x11 : 0x00);
  }
  text(s: string) {
    for (const ch of toPrinterAscii(s)) this.buf.push(ch.charCodeAt(0));
    return this;
  }
  line(s = '') {
    return this.text(s).raw(LF);
  }
  feed(n = 1) {
    return this.raw(ESC, 0x64, n);
  }
  rule(cols = COLS_58MM, ch = '-') {
    return this.line(ch.repeat(cols));
  }
  cut() {
    return this.feed(3).raw(GS, 0x56, 0x42, 0x00);
  }

  /** Native QR (GS ( k). `ecc` L/M/Q/H; `moduleSize` 1-16 dots. */
  qr(data: string, moduleSize = 5, ecc: 'L' | 'M' | 'Q' | 'H' = 'M') {
    const bytes = [...toPrinterAscii(data)].map((c) => c.charCodeAt(0));
    if (bytes.length === 0 || bytes.length > 700)
      throw new PrinterError('QR payload must be 1-700 bytes');
    const storeLen = bytes.length + 3;
    return this.raw(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00) // model 2
      .raw(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, Math.min(16, Math.max(1, moduleSize)))
      .raw(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, { L: 48, M: 49, Q: 50, H: 51 }[ecc])
      .raw(GS, 0x28, 0x6b, storeLen & 0xff, storeLen >> 8, 0x31, 0x50, 0x30, ...bytes)
      .raw(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30);
  }

  private raw(...b: number[]) {
    this.buf.push(...b);
    return this;
  }

  build(): Uint8Array {
    return Uint8Array.from(this.buf);
  }
}

/** "label ........ value" within `cols`, truncating the label (never the value). */
export function twoCol(label: string, value: string, cols = COLS_58MM): string {
  const v = toPrinterAscii(value);
  const l = toPrinterAscii(label).slice(0, Math.max(0, cols - v.length - 1));
  return l + ' '.repeat(Math.max(1, cols - l.length - v.length)) + v;
}

export function centre(s: string, cols = COLS_58MM): string {
  const t = toPrinterAscii(s).slice(0, cols);
  return ' '.repeat(Math.floor((cols - t.length) / 2)) + t;
}

const inr = (paise: number) =>
  `Rs ${new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(paise / 100)}`;
const pts = (n: number) => `${n > 0 ? '+' : ''}${new Intl.NumberFormat('en-IN').format(n)} pts`;

const HEADLINE: Record<SlipView['type'], string> = {
  EARN: 'POINTS EARNED',
  REDEEM: 'POINTS REDEEMED',
  REVERSAL: 'REVERSAL',
  ADJUSTMENT: 'ADJUSTMENT',
  EXPIRY: 'POINTS EXPIRED',
};

/** Compact, verifiable payload for the slip QR: scan => POST /v1/transactions/slips/verify. */
export function slipQrPayload(s: SlipView): string {
  return ['PP1', s.slipNumber, s.transactionId, s.points, s.createdAt, s.signature].join('|');
}

export function parseSlipQr(payload: string): {
  slipNumber: string;
  transactionId: string;
  points: number;
  createdAt: string;
  signature: string;
} | null {
  const [v, slipNumber, transactionId, points, createdAt, signature, ...extra] = payload.split('|');
  if (v !== 'PP1' || extra.length || !slipNumber || !transactionId || !createdAt || !signature)
    return null;
  const p = Number(points);
  return Number.isInteger(p)
    ? { slipNumber, transactionId, points: p, createdAt, signature }
    : null;
}

/** Plain-text layout, used for the on-screen preview and as the single source for what gets printed. */
export function slipLines(slip: SlipView, cols = COLS_58MM): string[] {
  const when = new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(slip.createdAt));
  const rule = '-'.repeat(cols);
  return [
    centre(slip.merchantName.toUpperCase(), cols),
    centre(slip.outletName, cols),
    rule,
    twoCol('Slip', slip.slipNumber, cols),
    twoCol('Date', when, cols),
    twoCol('Customer', slip.customerName, cols),
    twoCol('Mobile', slip.customerMobileMasked, cols),
    rule,
    twoCol(HEADLINE[slip.type], pts(slip.points), cols),
    ...(slip.amountPaise ? [twoCol('Sale amount', inr(slip.amountPaise), cols)] : []),
    rule,
    twoCol('BALANCE', `${new Intl.NumberFormat('en-IN').format(slip.balanceAfter)} pts`, cols),
    rule,
  ];
}

export function encodeSlip(slip: SlipView, cols = COLS_58MM): Uint8Array {
  const lines = slipLines(slip, cols);
  const b = new EscPosBuilder().init();
  b.align('left');
  lines.forEach((l, i) => {
    if (i <= 1) b.bold(true).line(l).bold(false);
    else b.line(l);
  });
  b.align('center').feed(1).qr(slipQrPayload(slip), 5).feed(1);
  b.line('Scan to verify').line('Thank you! Drive safe.');
  return b.cut().build();
}
