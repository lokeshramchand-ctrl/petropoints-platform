# POS handset & slip printer

The merchant app is built to run on an Android POS handset with a thermal printer. Everything up to
the printer is implemented and tested; **the last hop, talking to _your_ handset's printer, needs the
model and its SDK**, because there is no universal API for built-in printers.

## What exists

| Piece                                    | Where                                                           | Status                                |
| ---------------------------------------- | --------------------------------------------------------------- | ------------------------------------- |
| Slip layout (32-col, 58 mm)              | `packages/mobile-core/src/printing.ts` `slipLines`              | done, tested                          |
| ESC/POS byte encoder incl. native QR     | `EscPosBuilder`, `encodeSlip`                                   | done, tested                          |
| `PrinterPort` interface                  | `printing.ts`                                                   | done                                  |
| Safe print orchestration                 | `PosTerminal` (a print failure never fails the sale)            | done, tested                          |
| On-screen mock printer (dev)             | `apps/merchant-app/src/printer.ts` → `EXPO_PUBLIC_PRINTER=mock` | done                                  |
| **Adapter for the real handset printer** | `apps/merchant-app/src/printer.ts` → `builtin`/`bluetooth`      | **not written: throws a clear error** |

## Writing the adapter

A printer adapter is ~20 lines: take the bytes `encodeSlip` produced and hand them to the vendor SDK.

```ts
// apps/merchant-app/src/printer-sunmi.ts  (example shape only)
import type { PrinterPort } from '@petropoints/mobile-core';
import { PrinterError } from '@petropoints/mobile-core';
import VendorPrinter from 'vendor-printer-sdk'; // the SDK for YOUR handset

export class BuiltinPrinter implements PrinterPort {
  readonly name = 'builtin';
  async print(bytes: Uint8Array) {
    try {
      await VendorPrinter.sendRaw(bytes); // most SDKs accept raw ESC/POS bytes
    } catch (e) {
      throw new PrinterError(e instanceof Error ? e.message : 'Printer unavailable');
    }
  }
}
```

Then return it from `createPrinter()` for `kind === 'builtin'`.

Things to check for the specific device:

1. **Does the SDK accept raw ESC/POS bytes?** If yes, use `encodeSlip` as-is. If it only exposes
   text/QR/barcode calls, build the slip from `slipLines(slip)` and `slipQrPayload(slip)` instead.
2. **Paper width.** 58 mm → 32 columns (default). For 80 mm pass `48` to `encodeSlip`/`slipLines`.
3. **Native module.** Vendor SDKs are native, so the app must be built with EAS / `expo prebuild`
   (a development build). It will not run inside Expo Go.
4. **Device ID.** The app sends `x-device-serial` = Android ID on every request. Register the value
   shown on the _Device_ tab under **Outlets → POS devices** in the admin panel. A factory reset
   changes the Android ID, so revoke the old device and register the new one.
5. **Offline.** Sales taken without a network are stored and sent later; no slip can print for them
   until they sync (the server issues the slip number and signature). If you need a paper receipt
   offline, a provisional "pending" slip could be added, but it would carry no verifiable number.

## Verifying a printed slip

Each slip's QR encodes `PP1|slipNumber|transactionId|points|createdAt|signature`. POST those fields to
`/v1/transactions/slips/verify` (public): `{ "valid": true }` means the server signed exactly this
slip. A changed point value or number makes it `false`.
