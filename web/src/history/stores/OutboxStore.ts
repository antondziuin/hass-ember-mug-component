/**
 * Wraps a remote store so writing never depends on the network being up.
 *
 * Rows are written to IndexedDB first and drained to the remote afterwards. Because every
 * remote write is an upsert on the natural key, replaying a batch is always a no-op, so a
 * drain can be retried freely.
 *
 * Reads come from the remote, with anything still pending folded in locally - otherwise
 * the chart would visibly lag the mug whenever the backend is slow or asleep.
 */

import { bucketSamples } from '../bucketing.js';
import { DEFAULT_QUERY_LIMIT } from '../constants.js';
import type {
  AggregateQuery,
  DeleteQuery,
  EventQuery,
  ExportChunk,
  ExportQuery,
  HistoryStore,
  ImportOptions,
  ImportProgress,
  RangeQuery,
  SeriesQuery,
  StoreKind,
  StoreProbe,
} from '../HistoryStore.js';
import type {
  Aggregates,
  AppendResult,
  Bounds,
  DeviceEvent,
  DeviceId,
  DeviceRecord,
  Millis,
  Sample,
  SeriesFrame,
  SessionEndReason,
  SessionId,
  SessionRecord,
} from '../types.js';
import type { IndexedDbStore } from './indexeddb/IndexedDbStore.js';

const DRAIN_INTERVAL_MS = 30_000;
const DRAIN_BATCH = 1_000;
const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000];
/** Beyond this the user is told loudly; a month of silent failure must not be invisible. */
const OUTBOX_WARN_ROWS = 200_000;

export interface OutboxStatus {
  pending: number;
  lastDrainAt: Millis | null;
  lastError: string | null;
  draining: boolean;
  /** True once the queue is large enough that data loss is a real risk. */
  overflowing: boolean;
}

export class OutboxStore implements HistoryStore {
  readonly kind: StoreKind;
  readonly id: string;

  readonly #remote: HistoryStore;
  readonly #local: IndexedDbStore;
  #timer: ReturnType<typeof setInterval> | null = null;
  #draining = false;
  #attempt = 0;
  #status: OutboxStatus = {
    pending: 0,
    lastDrainAt: null,
    lastError: null,
    draining: false,
    overflowing: false,
  };
  #listeners = new Set<() => void>();

  constructor(remote: HistoryStore, local: IndexedDbStore) {
    this.#remote = remote;
    this.#local = local;
    this.kind = remote.kind;
    this.id = remote.id;
  }

  getStatus = (): OutboxStatus => this.#status;

  subscribeStatus = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  async #publish(): Promise<void> {
    const pending = await this.#local.outboxSize(this.id);
    this.#status = {
      ...this.#status,
      pending,
      draining: this.#draining,
      overflowing: pending > OUTBOX_WARN_ROWS,
    };
    for (const listener of this.#listeners) listener();
  }

  async open(): Promise<void> {
    await this.#local.open();
    await this.#remote.open();
    if (this.#timer === null && typeof setInterval === 'function') {
      this.#timer = setInterval(() => void this.drain(), DRAIN_INTERVAL_MS);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.#onOnline);
    }
    await this.#publish();
    void this.drain();
  }

  async close(): Promise<void> {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    if (typeof window !== 'undefined') window.removeEventListener('online', this.#onOnline);
    await this.#remote.close();
  }

  #onOnline = (): void => {
    this.#attempt = 0;
    void this.drain();
  };

  probe(signal?: AbortSignal): Promise<StoreProbe> {
    return this.#remote.probe(signal);
  }

  // --- writes: local first, always ---------------------------------------

  async appendSamples(rows: readonly Sample[]): Promise<AppendResult> {
    if (rows.length === 0) return { accepted: 0, deduped: 0, rejected: 0 };
    const result = await this.#local.appendSamples(rows);
    if (result.accepted > 0) {
      await this.#local.enqueueOutbox(this.id, 'samples', rows);
      await this.#publish();
      void this.drain();
    }
    return result;
  }

  async appendEvents(rows: readonly DeviceEvent[]): Promise<AppendResult> {
    if (rows.length === 0) return { accepted: 0, deduped: 0, rejected: 0 };
    const result = await this.#local.appendEvents(rows);
    if (result.accepted > 0) {
      await this.#local.enqueueOutbox(this.id, 'events', rows);
      await this.#publish();
    }
    return result;
  }

  async upsertDevice(device: DeviceRecord): Promise<void> {
    await this.#local.upsertDevice(device);
    await this.#local.enqueueOutbox(this.id, 'device', device);
    void this.drain();
  }

  async startSession(session: SessionRecord): Promise<void> {
    await this.#local.startSession(session);
    await this.#local.enqueueOutbox(this.id, 'session-start', session);
  }

  async endSession(
    sessionId: SessionId,
    endedMs: Millis,
    reason: SessionEndReason,
    sampleCount: number,
  ): Promise<void> {
    await this.#local.endSession(sessionId, endedMs, reason, sampleCount);
    await this.#local.enqueueOutbox(this.id, 'session-end', {
      sessionId,
      endedMs,
      reason,
      sampleCount,
    });
    void this.drain();
  }

  /**
   * Sends queued work to the remote, oldest first, stopping at the first failure so
   * ordering is preserved.
   */
  async drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    await this.#publish();

    try {
      for (;;) {
        const batch = await this.#local.peekOutbox(this.id, DRAIN_BATCH);
        if (batch.length === 0) {
          this.#attempt = 0;
          this.#status = { ...this.#status, lastError: null, lastDrainAt: Date.now() };
          break;
        }

        const done: number[] = [];
        for (const item of batch) {
          try {
            await this.#send(item.kind, item.payload);
            done.push(item.seq);
          } catch (error) {
            this.#status = {
              ...this.#status,
              lastError: error instanceof Error ? error.message : String(error),
            };
            this.#attempt += 1;
            break;
          }
        }
        if (done.length > 0) await this.#local.ackOutbox(done);
        if (done.length < batch.length) {
          this.#scheduleRetry();
          break;
        }
      }
    } finally {
      this.#draining = false;
      await this.#publish();
    }
  }

  #scheduleRetry(): void {
    const delay = BACKOFF_MS[Math.min(this.#attempt - 1, BACKOFF_MS.length - 1)] ?? 300_000;
    setTimeout(() => void this.drain(), delay);
  }

  async #send(kind: string, payload: unknown): Promise<void> {
    switch (kind) {
      case 'samples':
        await this.#remote.appendSamples(payload as Sample[]);
        return;
      case 'events':
        await this.#remote.appendEvents(payload as DeviceEvent[]);
        return;
      case 'device':
        await this.#remote.upsertDevice(payload as DeviceRecord);
        return;
      case 'session-start':
        await this.#remote.startSession(payload as SessionRecord);
        return;
      case 'session-end': {
        const p = payload as {
          sessionId: SessionId;
          endedMs: Millis;
          reason: SessionEndReason;
          sampleCount: number;
        };
        await this.#remote.endSession(p.sessionId, p.endedMs, p.reason, p.sampleCount);
        return;
      }
      default:
        throw new Error(`Unknown outbox entry: ${kind}`);
    }
  }

  // --- reads: remote, with the local tail folded in -----------------------

  async #pendingFrom(deviceId: DeviceId): Promise<Millis | null> {
    const batch = await this.#local.peekOutbox(this.id, DRAIN_BATCH);
    let earliest: Millis | null = null;
    for (const item of batch) {
      if (item.kind !== 'samples') continue;
      for (const sample of item.payload as Sample[]) {
        if (sample.deviceId !== deviceId) continue;
        if (earliest === null || sample.ts < earliest) earliest = sample.ts;
      }
    }
    return earliest;
  }

  async queryRange(query: SeriesQuery, signal?: AbortSignal): Promise<SeriesFrame> {
    const pendingFrom = await this.#pendingFrom(query.deviceId);
    if (pendingFrom === null || pendingFrom >= query.to) {
      return this.#remote.queryRange(query, signal);
    }

    // The tail is bucketed locally with the same fold the stores use, so the join is
    // seamless rather than two differently-computed halves.
    const splitAt = Math.max(query.from, pendingFrom);
    const head =
      splitAt > query.from
        ? await this.#remote.queryRange({ ...query, to: splitAt }, signal)
        : null;
    const tailSamples = await this.#localSamples(query.deviceId, splitAt, query.to);
    const tail = bucketSamples(tailSamples, {
      deviceId: query.deviceId,
      from: splitAt,
      to: query.to,
      bucket: query.bucket,
      ...(query.fields ? { fields: query.fields } : {}),
      limit: query.limit ?? DEFAULT_QUERY_LIMIT,
    });

    return head ? concatFrames(head, tail) : tail;
  }

  #localSamples(deviceId: DeviceId, from: Millis, to: Millis): Promise<Sample[]> {
    return this.#local.rawSamples(deviceId, from, to);
  }

  queryEvents(query: EventQuery, signal?: AbortSignal): Promise<DeviceEvent[]> {
    return this.#remote.queryEvents(query, signal).catch(() => this.#local.queryEvents(query));
  }

  /**
   * Aggregates cannot be merged across a split, so a drain is attempted first. If the
   * remote is still behind, the local answer is used - it is the complete one.
   */
  async aggregate(query: AggregateQuery, signal?: AbortSignal): Promise<Aggregates> {
    const pendingFrom = await this.#pendingFrom(query.deviceId);
    if (pendingFrom !== null && pendingFrom < query.to) {
      await this.drain();
      if ((await this.#pendingFrom(query.deviceId)) !== null) {
        return this.#local.aggregate(query);
      }
    }
    return this.#remote.aggregate(query, signal);
  }

  bounds(deviceId: DeviceId): Promise<Bounds | null> {
    return this.#remote.bounds(deviceId).catch(() => this.#local.bounds(deviceId));
  }

  listDevices(): Promise<DeviceRecord[]> {
    return this.#remote.listDevices().catch(() => this.#local.listDevices());
  }

  getDevice(deviceId: DeviceId): Promise<DeviceRecord | null> {
    return this.#remote.getDevice(deviceId).catch(() => this.#local.getDevice(deviceId));
  }

  listSessions(query: RangeQuery): Promise<SessionRecord[]> {
    return this.#remote.listSessions(query).catch(() => this.#local.listSessions(query));
  }

  async mergeDevices(
    fromId: DeviceId,
    intoId: DeviceId,
  ): Promise<{ movedSamples: number; movedEvents: number }> {
    await this.#local.mergeDevices(fromId, intoId);
    return this.#remote.mergeDevices(fromId, intoId);
  }

  async deleteRange(
    query: DeleteQuery,
  ): Promise<{ samples: number; events: number; sessions: number }> {
    await this.#local.deleteRange(query);
    return this.#remote.deleteRange(query);
  }

  async deleteDevice(deviceId: DeviceId): Promise<void> {
    await this.#local.deleteDevice(deviceId);
    await this.#remote.deleteDevice(deviceId);
  }

  exportStream(query: ExportQuery, signal?: AbortSignal): AsyncIterable<ExportChunk> {
    return this.#remote.exportStream(query, signal);
  }

  importStream(
    source: AsyncIterable<ExportChunk>,
    options?: ImportOptions,
  ): AsyncIterable<ImportProgress> {
    return this.#remote.importStream(source, options);
  }

  async compact(): Promise<void> {
    await this.#remote.compact?.();
  }
}

/** Joins two frames that cover adjacent, non-overlapping ranges. */
function concatFrames(head: SeriesFrame, tail: SeriesFrame): SeriesFrame {
  const join = <T>(a: T[] | null, b: T[] | null): T[] | null =>
    a === null || b === null ? null : [...a, ...b];
  return {
    ...head,
    to: tail.to,
    t: [...head.t, ...tail.t],
    tempC: join(head.tempC, tail.tempC),
    tempMinC: join(head.tempMinC, tail.tempMinC),
    tempMaxC: join(head.tempMaxC, tail.tempMaxC),
    targetC: join(head.targetC, tail.targetC),
    batteryPct: join(head.batteryPct, tail.batteryPct),
    batteryMinPct: join(head.batteryMinPct, tail.batteryMinPct),
    batteryMaxPct: join(head.batteryMaxPct, tail.batteryMaxPct),
    liquidPct: join(head.liquidPct, tail.liquidPct),
    liquidState: join(head.liquidState, tail.liquidState),
    chargeFrac: join(head.chargeFrac, tail.chargeFrac),
    count: join(head.count, tail.count),
    truncated: head.truncated || tail.truncated,
  };
}
