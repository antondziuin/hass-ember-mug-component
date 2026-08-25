/**
 * Serialises every GATT operation.
 *
 * Chrome runs one GATT operation at a time and rejects overlapping calls with
 * `NetworkError: GATT operation already in progress`, so this queue must be the only
 * path to the radio.
 *
 * The part that is easy to get wrong: a Web Bluetooth promise cannot actually be
 * aborted. When an operation times out it is still holding the radio, so the queue has
 * to remember the orphaned promise and wait for it to settle before starting anything
 * else. Starting the next operation immediately produces a permanent
 * "already in progress" state that only a disconnect can clear.
 */

import { DEFAULT_OP_TIMEOUT_MS, GATT_RETRY_BACKOFF_MS } from './constants.js';
import { EmberError, classify, isTransient, type EmberFailure } from './errors.js';
import type { CharId } from './uuids.js';

export interface GattOpOptions {
  timeoutMs?: number;
  /** Number of retries after the first attempt. Default 2, i.e. three attempts. */
  retries?: number;
  /** Higher runs first. 0 poll reads, 10 user writes, 20 teardown. */
  priority?: number;
  characteristic?: CharId;
}

export interface GattQueueOptions {
  /** Delay inserted between operations. Android's stack is happier with a small gap. */
  gapMs?: number;
  /** Called when the radio is wedged and only a disconnect can recover it. */
  onFatal?: (failure: EmberFailure) => void;
  /** Multiple of the op timeout to wait for an orphaned operation before giving up. */
  hardTimeoutFactor?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface Task<T> {
  label: string;
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  timeoutMs: number;
  retriesLeft: number;
  attempt: number;
  priority: number;
  seq: number;
  characteristic: CharId | undefined;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function backoffFor(attempt: number): number {
  const idx = Math.min(attempt - 1, GATT_RETRY_BACKOFF_MS.length - 1);
  return GATT_RETRY_BACKOFF_MS[Math.max(idx, 0)]!;
}

/** Detects whether the runtime is Android, where a small inter-op gap helps. */
export function defaultGapMs(): number {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return /Android/i.test(ua) ? 20 : 0;
}

export class GattQueue {
  #queue: Array<Task<unknown>> = [];
  #pumping = false;
  #closed: EmberFailure | null = null;
  /** A timed-out operation that may still own the radio. */
  #orphan: Promise<unknown> | null = null;
  #seq = 0;
  #inFlight = 0;

  readonly #gapMs: number;
  readonly #onFatal: (failure: EmberFailure) => void;
  readonly #hardTimeoutFactor: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: GattQueueOptions = {}) {
    this.#gapMs = options.gapMs ?? defaultGapMs();
    this.#onFatal = options.onFatal ?? (() => undefined);
    this.#hardTimeoutFactor = options.hardTimeoutFactor ?? 3;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  get pending(): number {
    return this.#queue.length + this.#inFlight;
  }

  get isClosed(): boolean {
    return this.#closed !== null;
  }

  run<T>(label: string, fn: () => Promise<T>, options: GattOpOptions = {}): Promise<T> {
    if (this.#closed) return Promise.reject(new EmberError(this.#closed));

    return new Promise<T>((resolve, reject) => {
      const task: Task<T> = {
        label,
        fn,
        resolve,
        reject,
        timeoutMs: options.timeoutMs ?? DEFAULT_OP_TIMEOUT_MS,
        retriesLeft: options.retries ?? 2,
        attempt: 0,
        priority: options.priority ?? 0,
        seq: this.#seq,
        characteristic: options.characteristic,
      };
      this.#seq += 1;
      this.#insert(task as Task<unknown>);
      void this.#pump();
    });
  }

  /** Rejects everything queued. Called on disconnect. */
  close(failure: EmberFailure): void {
    this.#closed = failure;
    const queued = this.#queue;
    this.#queue = [];
    for (const task of queued) task.reject(new EmberError(failure));
  }

  /** Re-arms the queue after a successful reconnect. */
  reopen(): void {
    this.#closed = null;
    this.#orphan = null;
  }

  /** Stable priority insert: higher priority first, FIFO within a priority. */
  #insert(task: Task<unknown>): void {
    let i = this.#queue.length;
    while (i > 0 && this.#queue[i - 1]!.priority < task.priority) i -= 1;
    this.#queue.splice(i, 0, task);
  }

  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      while (this.#queue.length > 0 && !this.#closed) {
        if (this.#orphan) {
          const settled = await this.#awaitOrphan();
          if (!settled) {
            this.#onFatal({
              kind: 'gatt',
              op: 'queue',
              cause: new Error('A GATT operation never completed; the link has to be reset.'),
              transient: false,
            });
            return;
          }
        }

        const task = this.#queue.shift()!;
        task.attempt += 1;

        try {
          const result = await this.#execute(task);
          task.resolve(result);
        } catch (error) {
          const failure =
            error instanceof EmberError
              ? error.failure
              : classify(error, task.label, task.characteristic);

          if (isTransient(failure) && task.retriesLeft > 0) {
            task.retriesLeft -= 1;
            await this.#sleep(backoffFor(task.attempt));
            this.#queue.unshift(task);
            continue;
          }

          if (failure.kind === 'disconnected') {
            task.reject(new EmberError(failure));
            this.close(failure);
            return;
          }

          task.reject(new EmberError(failure));
        }

        if (this.#gapMs > 0) await this.#sleep(this.#gapMs);
      }
    } finally {
      this.#pumping = false;
    }
  }

  /** Resolves true if the orphan settled, false if it is still hanging. */
  async #awaitOrphan(): Promise<boolean> {
    const orphan = this.#orphan;
    if (!orphan) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), DEFAULT_OP_TIMEOUT_MS * this.#hardTimeoutFactor);
    });
    try {
      const outcome = await Promise.race([orphan.then(() => 'settled' as const), expiry]);
      this.#orphan = null;
      return outcome === 'settled';
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #execute<T>(task: Task<T>): Promise<T> {
    const inflight = task.fn();
    this.#inFlight += 1;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        // The operation cannot be cancelled, so hold on to it and stall the queue
        // until it settles.
        this.#orphan = inflight.catch(() => undefined);
        reject(new EmberError({ kind: 'timeout', op: task.label, ms: task.timeoutMs }));
      }, task.timeoutMs);
    });

    try {
      return await Promise.race([inflight, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.#inFlight -= 1;
    }
  }
}
