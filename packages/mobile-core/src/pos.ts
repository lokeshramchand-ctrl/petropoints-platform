import type { EarnPointsRequest, RedeemPointsRequest, SlipView } from '@petropoints/contracts';
import type { FlushResult, OfflineQueue, QueuedCommand } from './offline-queue';
import { encodeSlip, type PrinterPort } from './printing';

export type PosPayload = EarnPointsRequest | RedeemPointsRequest;

export interface PosResult {
  transactionId: string;
  type: string;
  points: number;
  balanceAfter: number;
  slip: SlipView | null;
  replayed: boolean;
}

/** The two server calls the terminal makes. Implemented over MobileApiClient in the app. */
export interface PosApi {
  earn(body: EarnPointsRequest, idempotencyKey: string): Promise<PosResult>;
  redeem(body: RedeemPointsRequest, idempotencyKey: string): Promise<PosResult>;
}

export type SubmitOutcome =
  | {
      status: 'done';
      result: PosResult;
      print: 'printed' | 'no-printer' | { failed: string };
      syncedEarlier: number;
    }
  /** no connectivity: safely stored, will be sent (once) when the network returns */
  | { status: 'queued'; commandId: string }
  /** the server refused it (e.g. insufficient points): nothing was applied */
  | { status: 'rejected'; code: string; message: string };

/**
 * Orchestrates one POS sale: durable-enqueue FIRST, then try to send, then print.
 *
 * Enqueuing before sending is the key safety property: the command id doubles as the
 * Idempotency-Key, so if the app dies or the response is lost after the server applied it,
 * the retry returns the original result instead of awarding twice.
 */
export class PosTerminal {
  constructor(
    private readonly queue: OfflineQueue<PosPayload, PosResult>,
    private readonly api: PosApi,
    private readonly printer: PrinterPort | null = null,
  ) {}

  async submit(kind: 'earn' | 'redeem', payload: PosPayload): Promise<SubmitOutcome> {
    const cmd = await this.queue.enqueue(kind, payload);
    const flush = await this.sync();

    const done = flush.sent.find((s) => s.command.id === cmd.id);
    if (done) {
      return {
        status: 'done',
        result: done.result,
        print: await this.print(done.result.slip),
        syncedEarlier: flush.sent.length - 1,
      };
    }
    const failed = flush.failed.find((f) => f.command.id === cmd.id);
    if (failed) return { status: 'rejected', code: failed.code, message: failed.message };
    return { status: 'queued', commandId: cmd.id };
  }

  /** Called on reconnect / app foreground / manual retry. Safe to call concurrently. */
  sync(): Promise<FlushResult<PosPayload, PosResult>> {
    return this.queue.flush((c) => this.send(c));
  }

  pending() {
    return this.queue.size();
  }

  async reprint(slip: SlipView): Promise<void> {
    if (!this.printer) throw new Error('No printer configured');
    await this.printer.print(encodeSlip(slip));
  }

  private send(c: QueuedCommand<PosPayload>) {
    return c.kind === 'earn'
      ? this.api.earn(c.payload as EarnPointsRequest, c.id)
      : this.api.redeem(c.payload as RedeemPointsRequest, c.id);
  }

  private async print(
    slip: SlipView | null,
  ): Promise<'printed' | 'no-printer' | { failed: string }> {
    if (!slip || !this.printer) return 'no-printer';
    try {
      await this.printer.print(encodeSlip(slip));
      return 'printed';
    } catch (e) {
      // The sale succeeded; a paper jam must never look like a failed transaction.
      return { failed: e instanceof Error ? e.message : 'Printer error' };
    }
  }
}
