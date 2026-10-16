import { MemoryPrinter, PrinterError, type PrinterPort } from '@petropoints/mobile-core';

/**
 * Selects the receipt printer. `EXPO_PUBLIC_PRINTER` picks the adapter:
 *   - `mock`    (default in development) records print jobs in memory and shows them on screen
 *   - `builtin` the handset's integrated thermal printer, via the vendor SDK
 *   - `bluetooth` an external ESC/POS printer
 *
 * `builtin` and `bluetooth` need a native module that only works in a dev/production build (not
 * Expo Go) and depends on the handset model. Until that adapter is written they fail loudly rather
 * than silently dropping receipts. See docs/POS-PRINTER.md.
 */
export const previewPrinter = new MemoryPrinter();

class UnconfiguredPrinter implements PrinterPort {
  constructor(readonly name: string) {}
  async print(): Promise<void> {
    throw new PrinterError(
      `The "${this.name}" printer adapter is not installed. Follow docs/POS-PRINTER.md for this handset.`,
    );
  }
}

export function createPrinter(kind = process.env.EXPO_PUBLIC_PRINTER ?? 'mock'): PrinterPort {
  switch (kind) {
    case 'mock':
      return previewPrinter;
    case 'builtin':
    case 'bluetooth':
      return new UnconfiguredPrinter(kind);
    default:
      throw new Error(`Unknown EXPO_PUBLIC_PRINTER "${kind}"`);
  }
}
