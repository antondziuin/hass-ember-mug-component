/**
 * Batches writes to whichever store is active.
 *
 * Flushes eagerly - every ten seconds at the latest - because an IndexedDB transaction
 * opened during `pagehide` usually but not reliably commits. Writing often means a lost
 * final flush costs at most ten seconds of history rather than a whole session.
 */

import type { HistoryStore } from './HistoryStore.js';
import type { DeviceEvent, Sample } from './types.js';

export interface WriteBufferConfig {
  maxRows: number;
  maxAgeMs: number;
}

export const DEFAULT_WRITE_BUFFER: WriteBufferConfig = {
  maxRows: 25,
  maxAgeMs: 10_000,
};

export type FlushReason =
  | 'rows'
  | 'age'
  | 'visibility'
  | 'pagehide'
  | 'session-end'
  | 'manual'
  | 'store-change';

export interface WriteBufferOptions {
  config?: WriteBufferConfig;
  onError?: (error: unknown, reason: FlushReason) => void;
  onFlush?: (result: { samples: number; events: number; reason: FlushReason }) => void;
  now?: () => number;
}

export class WriteBuffer {
  #store: HistoryStore;
  #samples: Sample[] = [];
  #events: DeviceEvent[] = [];
  #firstQueuedAt: number | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** Serialises flushes so two overlapping calls cannot write the same rows twice. */
  #inFlight: Promise<void> = Promise.resolve();

  readonly #config: WriteBufferConfig;
  readonly #onError: (error: unknown, reason: FlushReason) => void;
  readonly #onFlush: (result: { samples: number; events: number; reason: FlushReason }) => void;
  readonly #now: () => number;

  constructor(store: HistoryStore, options: WriteBufferOptions = {}) {
    this.#store = store;
    this.#config = options.config ?? DEFAULT_WRITE_BUFFER;
    this.#onError = options.onError ?? (() => undefined);
    this.#onFlush = options.onFlush ?? (() => undefined);
    this.#now = options.now ?? Date.now;
  }

  get pending(): number {
    return this.#samples.length + this.#events.length;
  }

  get store(): HistoryStore {
    return this.#store;
  }

  /** Drains into the old store before switching, so nothing is stranded. */
  async setStore(store: HistoryStore): Promise<void> {
    await this.flush('store-change');
    this.#store = store;
  }

  add(samples: readonly Sample[], events: readonly DeviceEvent[] = []): void {
    if (samples.length === 0 && events.length === 0) return;
    this.#samples.push(...samples);
    this.#events.push(...events);
    this.#firstQueuedAt ??= this.#now();

    if (this.pending >= this.#config.maxRows) {
      void this.flush('rows');
      return;
    }
    this.#arm();
  }

  #arm(): void {
    if (this.#timer !== null) return;
    const elapsed = this.#firstQueuedAt === null ? 0 : this.#now() - this.#firstQueuedAt;
    const delay = Math.max(this.#config.maxAgeMs - elapsed, 0);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush('age');
    }, delay);
  }

  #disarm(): void {
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  flush(reason: FlushReason): Promise<void> {
    this.#inFlight = this.#inFlight.then(() => this.#doFlush(reason));
    return this.#inFlight;
  }

  async #doFlush(reason: FlushReason): Promise<void> {
    this.#disarm();
    if (this.pending === 0) return;

    const samples = this.#samples;
    const events = this.#events;
    this.#samples = [];
    this.#events = [];
    this.#firstQueuedAt = null;

    try {
      if (samples.length > 0) await this.#store.appendSamples(samples);
      if (events.length > 0) await this.#store.appendEvents(events);
      this.#onFlush({ samples: samples.length, events: events.length, reason });
    } catch (error) {
      // Put the rows back so a transient store failure does not silently lose history.
      this.#samples = [...samples, ...this.#samples];
      this.#events = [...events, ...this.#events];
      this.#firstQueuedAt = this.#now();
      this.#arm();
      this.#onError(error, reason);
    }
  }

  dispose(): void {
    this.#disarm();
  }
}
