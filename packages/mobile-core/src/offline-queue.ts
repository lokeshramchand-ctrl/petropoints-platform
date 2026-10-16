import { isRetryable } from './client';
import type { KeyValueStore } from './storage';

export interface QueuedCommand<P = unknown> {
  /** Also used as the Idempotency-Key, so a replay after a lost response can never double-award. */
  id: string;
  kind: 'earn' | 'redeem';
  payload: P;
  createdAt: string;
  attempts: number;
}

export interface FailedCommand<P = unknown> {
  command: QueuedCommand<P>;
  code: string;
  message: string;
}

export interface FlushResult<P, R> {
  sent: Array<{ command: QueuedCommand<P>; result: R }>;
  failed: Array<FailedCommand<P>>;
  /** commands still waiting (flush stopped at the first retryable error to preserve order) */
  remaining: number;
}

const QUEUE_KEY = 'pp.pos.queue';
const DEAD_KEY = 'pp.pos.dead';

/**
 * Durable, ordered outbox for POS commands taken while the pump's network is down.
 * Order matters (an earn followed by a redeem), so a transient failure halts the flush; a permanent
 * rejection (validation, forbidden, insufficient points) is parked for a human and the flush continues.
 */
export class OfflineQueue<P = unknown, R = unknown> {
  private flushing: Promise<FlushResult<P, R>> | null = null;

  constructor(
    private readonly store: KeyValueStore,
    private readonly newId: () => string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async enqueue(kind: QueuedCommand['kind'], payload: P): Promise<QueuedCommand<P>> {
    const cmd: QueuedCommand<P> = {
      id: this.newId(),
      kind,
      payload,
      createdAt: this.now().toISOString(),
      attempts: 0,
    };
    const q = await this.read<QueuedCommand<P>>(QUEUE_KEY);
    q.push(cmd);
    await this.write(QUEUE_KEY, q);
    return cmd;
  }

  async size(): Promise<number> {
    return (await this.read(QUEUE_KEY)).length;
  }

  async deadLetters(): Promise<Array<FailedCommand<P>>> {
    return this.read(DEAD_KEY);
  }

  async dismissDeadLetter(commandId: string) {
    const dead = await this.read<FailedCommand<P>>(DEAD_KEY);
    await this.write(
      DEAD_KEY,
      dead.filter((d) => d.command.id !== commandId),
    );
  }

  /** Concurrent callers share one in-flight flush (e.g. a connectivity event and a manual retry). */
  flush(send: (cmd: QueuedCommand<P>) => Promise<R>): Promise<FlushResult<P, R>> {
    this.flushing ??= this.doFlush(send).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush(send: (cmd: QueuedCommand<P>) => Promise<R>): Promise<FlushResult<P, R>> {
    const result: FlushResult<P, R> = { sent: [], failed: [], remaining: 0 };
    const queue = await this.read<QueuedCommand<P>>(QUEUE_KEY);

    while (queue.length > 0) {
      const cmd = queue[0]!;
      try {
        const r = await send(cmd);
        result.sent.push({ command: cmd, result: r });
        queue.shift();
      } catch (err) {
        if (isRetryable(err)) {
          cmd.attempts += 1;
          break;
        }
        const e = err as { code?: string; message?: string };
        const failure = {
          command: cmd,
          code: e.code ?? 'REJECTED',
          message: e.message ?? 'Rejected by server',
        };
        result.failed.push(failure);
        queue.shift();
        await this.write(DEAD_KEY, [...(await this.read<FailedCommand<P>>(DEAD_KEY)), failure]);
      }
      await this.write(QUEUE_KEY, queue); // persist progress after every command: a crash can't resend a sent one
    }
    await this.write(QUEUE_KEY, queue);
    result.remaining = queue.length;
    return result;
  }

  private async read<T>(key: string): Promise<T[]> {
    const raw = await this.store.get(key);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as T[];
    } catch {
      return []; // corrupted blob must never brick the terminal
    }
  }

  private write(key: string, value: unknown[]) {
    return value.length ? this.store.set(key, JSON.stringify(value)) : this.store.remove(key);
  }
}
