/**
 * IndexedDB history store.
 *
 * This is the default backend and, when a remote store is configured, it also backs the
 * outbox - so it is never bypassed and there is only one write path to get right.
 *
 * Wide ranges are served from materialised hourly and daily rollups, because IndexedDB
 * has no GROUP BY and scanning a year of raw records to draw one chart is unacceptable.
 * The rollups are maintained inside the same transaction as the sample writes, so they
 * cannot drift from their raw data even if the tab dies mid-write, and they are finalised
 * through the same function the raw path uses, so the two can never disagree.
 */

import { openDB, type IDBPDatabase, type IDBPTransaction } from 'idb';

import {
  accumulate,
  aggregateSamples,
  alignWindow,
  bucketSamples,
  frameFromRollups,
  mergeAccumulators,
  newAccumulator,
  type Accumulator,
} from '../../bucketing.js';
import { DEFAULT_QUERY_LIMIT, MAX_BATCH_ROWS } from '../../constants.js';
import type {
  AggregateQuery,
  DeleteQuery,
  EventQuery,
  ExportChunk,
  ExportKind,
  ExportQuery,
  HistoryStore,
  ImportOptions,
  ImportProgress,
  RangeQuery,
  SeriesQuery,
  StoreCapabilities,
  StoreKind,
  StoreProbe,
} from '../../HistoryStore.js';
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
} from '../../types.js';
import {
  DB_NAME,
  DB_VERSION,
  ROLLUP_LEVEL_MS,
  type HistoryDB,
  type RollupLevel,
  type RollupRecord,
} from './schema.js';

const CAPABILITIES: StoreCapabilities = {
  buckets: ['raw', '1m', '5m', '1h', '1d'],
  serverSideBucketing: false,
  serverSideStats: false,
  maxBatchRows: MAX_BATCH_ROWS.indexeddb,
  streamingExport: true,
  deleteRange: true,
  multiDevice: true,
  transactional: true,
};

const range = (deviceId: DeviceId, from: Millis, to: Millis): IDBKeyRange =>
  IDBKeyRange.bound([deviceId, from], [deviceId, to], false, true);

export interface IndexedDbStoreOptions {
  dbName?: string;
  /** Injected so tests can supply fake-indexeddb without touching globals. */
  indexedDB?: IDBFactory;
}

export class IndexedDbStore implements HistoryStore {
  readonly kind: StoreKind = 'indexeddb';
  readonly id: string;

  #db: IDBPDatabase<HistoryDB> | null = null;
  readonly #dbName: string;
  readonly #factory: IDBFactory | undefined;

  constructor(options: IndexedDbStoreOptions = {}) {
    this.#dbName = options.dbName ?? DB_NAME;
    this.#factory = options.indexedDB;
    this.id = `idb:${this.#dbName}`;
  }

  async open(): Promise<void> {
    if (this.#db) return;
    this.#db = await openDB<HistoryDB>(this.#dbName, DB_VERSION, {
      // `idb` reads the global factory, so a test factory is installed for the duration
      // of the open call only.
      upgrade(db) {
        if (!db.objectStoreNames.contains('devices')) {
          const devices = db.createObjectStore('devices', { keyPath: 'deviceId' });
          devices.createIndex('by_serial', 'serialNumber', { unique: true });
        }
        if (!db.objectStoreNames.contains('sessions')) {
          const sessions = db.createObjectStore('sessions', { keyPath: 'sessionId' });
          sessions.createIndex('by_device_start', ['deviceId', 'startedMs']);
        }
        if (!db.objectStoreNames.contains('samples')) {
          db.createObjectStore('samples', { keyPath: ['deviceId', 'ts'] });
        }
        if (!db.objectStoreNames.contains('events')) {
          const events = db.createObjectStore('events', { keyPath: 'eventId' });
          events.createIndex('by_device_ts', ['deviceId', 'ts']);
          events.createIndex('by_natural', ['deviceId', 'ts', 'type'], { unique: true });
        }
        if (!db.objectStoreNames.contains('rollups')) {
          db.createObjectStore('rollups', { keyPath: ['deviceId', 'level', 'bucketMs'] });
        }
        if (!db.objectStoreNames.contains('outbox')) {
          const outbox = db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
          outbox.createIndex('by_target', ['targetId', 'seq']);
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      },
    });
  }

  async close(): Promise<void> {
    this.#db?.close();
    this.#db = null;
  }

  #require(): IDBPDatabase<HistoryDB> {
    if (!this.#db) throw new Error('IndexedDbStore.open() has not been called.');
    return this.#db;
  }

  get factory(): IDBFactory | undefined {
    return this.#factory;
  }

  async probe(): Promise<StoreProbe> {
    const started = Date.now();
    try {
      await this.open();
      const db = this.#require();
      const rowCount = await db.count('samples');

      let usage: StoreProbe['usage'] = { rowCount };
      try {
        const estimate = await navigator.storage?.estimate?.();
        const persisted = await navigator.storage?.persisted?.();
        usage = {
          rowCount,
          bytes: estimate?.usage,
          quotaBytes: estimate?.quota,
          persisted: persisted ?? false,
        };
      } catch {
        // Storage manager is unavailable in some contexts; row count alone is enough.
      }

      return {
        ok: true,
        kind: this.kind,
        id: this.id,
        latencyMs: Date.now() - started,
        schemaVersion: DB_VERSION,
        writable: true,
        capabilities: CAPABILITIES,
        usage,
      };
    } catch (error) {
      return {
        ok: false,
        kind: this.kind,
        id: this.id,
        latencyMs: Date.now() - started,
        schemaVersion: DB_VERSION,
        writable: false,
        capabilities: CAPABILITIES,
        error: {
          code: 'unsupported',
          message: error instanceof Error ? error.message : String(error),
          hint: 'This browser blocked IndexedDB. Private windows and embedded frames often do.',
        },
      };
    }
  }

  // --- devices ------------------------------------------------------------

  async upsertDevice(device: DeviceRecord): Promise<void> {
    await this.#require().put('devices', device);
  }

  async listDevices(): Promise<DeviceRecord[]> {
    return this.#require().getAll('devices');
  }

  async getDevice(deviceId: DeviceId): Promise<DeviceRecord | null> {
    return (await this.#require().get('devices', deviceId)) ?? null;
  }

  /**
   * Rewrites every row belonging to `fromId` so it points at `intoId`.
   *
   * Used when a device first seen without a readable serial number later reports one.
   * Rollups are rebuilt rather than moved, because the target may already have buckets of
   * its own that need merging.
   */
  async mergeDevices(
    fromId: DeviceId,
    intoId: DeviceId,
  ): Promise<{ movedSamples: number; movedEvents: number }> {
    const db = this.#require();
    const tx = db.transaction(['samples', 'events', 'sessions', 'devices', 'rollups'], 'readwrite');

    const samples = await tx.objectStore('samples').getAll(range(fromId, -Infinity, Infinity));
    const events = await tx.objectStore('events').index('by_device_ts').getAll(
      range(fromId, -Infinity, Infinity),
    );
    const sessions = await tx
      .objectStore('sessions')
      .index('by_device_start')
      .getAll(range(fromId, -Infinity, Infinity));

    const sampleStore = tx.objectStore('samples');
    for (const sample of samples) {
      await sampleStore.delete([fromId, sample.ts]);
      await sampleStore.put({ ...sample, deviceId: intoId });
    }
    const eventStore = tx.objectStore('events');
    for (const event of events) {
      await eventStore.put({ ...event, deviceId: intoId });
    }
    const sessionStore = tx.objectStore('sessions');
    for (const session of sessions) {
      await sessionStore.put({ ...session, deviceId: intoId });
    }

    // Drop the source's rollups; the target's are rebuilt below.
    const rollupStore = tx.objectStore('rollups');
    let cursor = await rollupStore.openCursor();
    while (cursor) {
      if (cursor.value.deviceId === fromId || cursor.value.deviceId === intoId) {
        await cursor.delete();
      }
      cursor = await cursor.continue();
    }

    await tx.objectStore('devices').delete(fromId);
    await tx.done;

    await this.rebuildRollups(intoId);
    return { movedSamples: samples.length, movedEvents: events.length };
  }

  async deleteDevice(deviceId: DeviceId): Promise<void> {
    await this.deleteRange({
      deviceId,
      from: -Infinity,
      to: Infinity,
      include: ['samples', 'events', 'sessions'],
    });
    const db = this.#require();
    const tx = db.transaction(['devices', 'rollups'], 'readwrite');
    await tx.objectStore('devices').delete(deviceId);
    let cursor = await tx.objectStore('rollups').openCursor();
    while (cursor) {
      if (cursor.value.deviceId === deviceId) await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.done;
  }

  // --- sessions -----------------------------------------------------------

  async startSession(session: SessionRecord): Promise<void> {
    await this.#require().put('sessions', session);
  }

  async endSession(
    sessionId: SessionId,
    endedMs: Millis,
    reason: SessionEndReason,
    sampleCount: number,
  ): Promise<void> {
    const db = this.#require();
    const tx = db.transaction('sessions', 'readwrite');
    const existing = await tx.store.get(sessionId);
    if (existing) {
      await tx.store.put({ ...existing, endedMs, endReason: reason, sampleCount });
    }
    await tx.done;
  }

  async listSessions(query: RangeQuery): Promise<SessionRecord[]> {
    const db = this.#require();
    // A session that started before the window can still overlap it, so the scan starts
    // early and the overlap test is done in memory.
    const all = await db
      .getAllFromIndex(
        'sessions',
        'by_device_start',
        range(query.deviceId, -Infinity, query.to),
      );
    return all
      .filter((s) => (s.endedMs ?? Number.POSITIVE_INFINITY) > query.from)
      .sort((a, b) => a.startedMs - b.startedMs);
  }

  // --- writes -------------------------------------------------------------

  async appendSamples(rows: readonly Sample[]): Promise<AppendResult> {
    if (rows.length === 0) return { accepted: 0, deduped: 0, rejected: 0 };
    const db = this.#require();
    const tx = db.transaction(['samples', 'rollups'], 'readwrite');
    const result = await appendSamplesInTx(tx, rows);
    await tx.done;
    return result;
  }

  async appendEvents(rows: readonly DeviceEvent[]): Promise<AppendResult> {
    if (rows.length === 0) return { accepted: 0, deduped: 0, rejected: 0 };
    const db = this.#require();
    const tx = db.transaction('events', 'readwrite');
    const store = tx.store;
    let accepted = 0;
    let deduped = 0;

    for (const event of rows) {
      // The unique natural key is what stops the same transition arriving twice from two
      // browsers becoming two rows.
      const existing = await store.index('by_natural').getKey([event.deviceId, event.ts, event.type]);
      if (existing !== undefined) {
        deduped += 1;
        continue;
      }
      await store.put(event);
      accepted += 1;
    }
    await tx.done;
    return { accepted, deduped, rejected: 0 };
  }

  // --- reads --------------------------------------------------------------

  async bounds(deviceId: DeviceId): Promise<Bounds | null> {
    const db = this.#require();
    const all = range(deviceId, -Infinity, Infinity);
    const sampleCount = await db.count('samples', all);
    if (sampleCount === 0) return null;

    const tx = db.transaction('samples', 'readonly');
    const first = await tx.store.openCursor(all, 'next');
    const minTs = first?.value.ts ?? 0;
    const last = await tx.store.openCursor(all, 'prev');
    const maxTs = last?.value.ts ?? minTs;
    await tx.done;

    const eventCount = await db.countFromIndex('events', 'by_device_ts', all);
    return { minTs, maxTs, sampleCount, eventCount };
  }

  async #samplesIn(deviceId: DeviceId, from: Millis, to: Millis): Promise<Sample[]> {
    return this.#require().getAll('samples', range(deviceId, from, to));
  }

  /** Raw rows, for callers that need to re-fold them rather than take a finished frame. */
  async rawSamples(deviceId: DeviceId, from: Millis, to: Millis): Promise<Sample[]> {
    return this.#samplesIn(deviceId, from, to);
  }

  async queryRange(query: SeriesQuery): Promise<SeriesFrame> {
    const window = alignWindow(query.from, query.to, query.bucket);
    const options = {
      deviceId: query.deviceId,
      from: window.from,
      to: window.to,
      bucket: query.bucket,
      ...(query.fields ? { fields: query.fields } : {}),
      limit: query.limit ?? DEFAULT_QUERY_LIMIT,
    };

    // Wide views come from rollups; anything narrower is a bounded scan anyway.
    if (query.bucket === '1h' || query.bucket === '1d') {
      const rollups = await this.#rollupsIn(query.deviceId, query.bucket, window.from, window.to);
      return frameFromRollups(
        rollups.map((r) => ({ bucketMs: r.bucketMs, acc: r.acc })),
        options,
      );
    }

    const samples = await this.#samplesIn(query.deviceId, window.from, window.to);
    return bucketSamples(samples, options);
  }

  async queryEvents(query: EventQuery): Promise<DeviceEvent[]> {
    const db = this.#require();
    const rows = await db.getAllFromIndex(
      'events',
      'by_device_ts',
      range(query.deviceId, query.from, query.to),
      query.limit,
    );
    const types = query.types ? new Set(query.types) : null;
    return rows
      .filter((e) => !types || types.has(e.type))
      .sort((a, b) => a.ts - b.ts);
  }

  async aggregate(query: AggregateQuery): Promise<Aggregates> {
    const samples = await this.#samplesIn(query.deviceId, query.from, query.to);
    const sessions = await this.listSessions({
      deviceId: query.deviceId,
      from: query.from,
      to: query.to,
    });
    const base = aggregateSamples(samples, { from: query.from, to: query.to, sessions });
    if (!query.groupBy || query.groupBy === 'none') return base;

    const groups = new Map<number, Sample[]>();
    for (const sample of samples) {
      const key = groupKey(sample.ts, query.groupBy);
      const list = groups.get(key);
      if (list) list.push(sample);
      else groups.set(key, [sample]);
    }

    base.buckets = [...groups.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([key, rows]) => {
        const { from: _from, to: _to, buckets: _buckets, ...rest } = aggregateSamples(rows, {
          from: query.from,
          to: query.to,
          sessions,
        });
        return { key, ...rest };
      });
    return base;
  }

  // --- rollups ------------------------------------------------------------

  async #rollupsIn(
    deviceId: DeviceId,
    level: RollupLevel,
    from: Millis,
    to: Millis,
  ): Promise<RollupRecord[]> {
    const rows = await this.#require().getAll(
      'rollups',
      IDBKeyRange.bound([deviceId, level, from], [deviceId, level, to], false, true),
    );
    return rows.sort((a, b) => a.bucketMs - b.bucketMs);
  }

  /** Recomputes every rollup for a device from its raw samples. */
  async rebuildRollups(deviceId: DeviceId): Promise<void> {
    const db = this.#require();
    const samples = await this.#samplesIn(deviceId, -Infinity, Infinity);
    const tx = db.transaction('rollups', 'readwrite');
    const store = tx.store;

    let cursor = await store.openCursor();
    while (cursor) {
      if (cursor.value.deviceId === deviceId) await cursor.delete();
      cursor = await cursor.continue();
    }

    for (const [level, bucketSize] of Object.entries(ROLLUP_LEVEL_MS) as Array<
      [RollupLevel, number]
    >) {
      const byBucket = new Map<number, Accumulator>();
      for (const sample of samples) {
        const bucketMs = Math.floor(sample.ts / bucketSize) * bucketSize;
        let acc = byBucket.get(bucketMs);
        if (!acc) {
          acc = newAccumulator(bucketMs);
          byBucket.set(bucketMs, acc);
        }
        accumulate(acc, sample);
      }
      for (const [bucketMs, acc] of byBucket) {
        await store.put({ deviceId, level, bucketMs, acc });
      }
    }
    await tx.done;
  }

  async compact(): Promise<void> {
    for (const device of await this.listDevices()) {
      await this.rebuildRollups(device.deviceId);
    }
  }

  // --- delete -------------------------------------------------------------

  async deleteRange(
    query: DeleteQuery,
  ): Promise<{ samples: number; events: number; sessions: number }> {
    const db = this.#require();
    const include = new Set(query.include ?? ['samples', 'events', 'sessions']);
    const keyRange = range(query.deviceId, query.from, query.to);
    let samples = 0;
    let events = 0;
    let sessions = 0;

    if (include.has('samples')) {
      const tx = db.transaction('samples', 'readwrite');
      let cursor = await tx.store.openCursor(keyRange);
      while (cursor) {
        await cursor.delete();
        samples += 1;
        cursor = await cursor.continue();
      }
      await tx.done;
    }

    if (include.has('events')) {
      const tx = db.transaction('events', 'readwrite');
      let cursor = await tx.store.index('by_device_ts').openCursor(keyRange);
      while (cursor) {
        await cursor.delete();
        events += 1;
        cursor = await cursor.continue();
      }
      await tx.done;
    }

    if (include.has('sessions')) {
      const tx = db.transaction('sessions', 'readwrite');
      let cursor = await tx.store.index('by_device_start').openCursor(keyRange);
      while (cursor) {
        await cursor.delete();
        sessions += 1;
        cursor = await cursor.continue();
      }
      await tx.done;
    }

    if (samples > 0) await this.rebuildRollups(query.deviceId);
    return { samples, events, sessions };
  }

  // --- export / import ----------------------------------------------------

  async *exportStream(query: ExportQuery): AsyncIterable<ExportChunk> {
    await this.open();
    const include = new Set<ExportKind>(
      query.include ?? ['devices', 'sessions', 'events', 'samples'],
    );
    const batch = Math.min(query.batchRows ?? 1000, CAPABILITIES.maxBatchRows);
    const from = query.from ?? -Infinity;
    const to = query.to ?? Infinity;

    yield { kind: 'header', v: 1, exportedAt: Date.now(), source: this.kind, sourceId: this.id };

    const devices = (await this.listDevices()).filter(
      (d) => !query.deviceIds || query.deviceIds.includes(d.deviceId),
    );
    if (include.has('devices')) yield { kind: 'devices', rows: devices };

    for (const device of devices) {
      if (include.has('sessions')) {
        const rows = await this.listSessions({ deviceId: device.deviceId, from, to });
        if (rows.length > 0) yield { kind: 'sessions', rows };
      }
      if (include.has('events')) {
        const rows = await this.queryEvents({ deviceId: device.deviceId, from, to });
        for (let i = 0; i < rows.length; i += batch) {
          yield { kind: 'events', rows: rows.slice(i, i + batch) };
        }
      }
      if (include.has('samples')) {
        // Paged by timestamp rather than by offset, so the cursor cannot slip if rows are
        // written while the export is running.
        let cursorTs = from;
        for (;;) {
          const rows = await this.#require().getAll(
            'samples',
            IDBKeyRange.bound([device.deviceId, cursorTs], [device.deviceId, to], false, true),
            batch,
          );
          if (rows.length === 0) break;
          const lastTs = rows[rows.length - 1]!.ts;
          yield { kind: 'samples', deviceId: device.deviceId, rows, lastTs };
          if (rows.length < batch) break;
          cursorTs = lastTs + 1;
        }
      }
    }
  }

  async *importStream(
    source: AsyncIterable<ExportChunk>,
    options: ImportOptions = {},
  ): AsyncIterable<ImportProgress> {
    await this.open();
    const dryRun = options.dryRun ?? false;

    for await (const chunk of source) {
      switch (chunk.kind) {
        case 'header':
          break;
        case 'devices': {
          if (!dryRun) for (const device of chunk.rows) await this.upsertDevice(device);
          yield {
            kind: 'devices',
            rowsSeen: chunk.rows.length,
            rowsAccepted: dryRun ? 0 : chunk.rows.length,
            rowsDeduped: 0,
          };
          break;
        }
        case 'sessions': {
          if (!dryRun) for (const session of chunk.rows) await this.startSession(session);
          yield {
            kind: 'sessions',
            rowsSeen: chunk.rows.length,
            rowsAccepted: dryRun ? 0 : chunk.rows.length,
            rowsDeduped: 0,
          };
          break;
        }
        case 'events': {
          const result = dryRun
            ? { accepted: 0, deduped: 0, rejected: 0 }
            : await this.appendEvents(chunk.rows);
          yield {
            kind: 'events',
            rowsSeen: chunk.rows.length,
            rowsAccepted: result.accepted,
            rowsDeduped: result.deduped,
          };
          break;
        }
        case 'samples': {
          const result = dryRun
            ? { accepted: 0, deduped: 0, rejected: 0 }
            : await this.appendSamples(chunk.rows);
          yield {
            kind: 'samples',
            deviceId: chunk.deviceId,
            rowsSeen: chunk.rows.length,
            rowsAccepted: result.accepted,
            rowsDeduped: result.deduped,
            lastTs: chunk.lastTs,
          };
          break;
        }
      }
    }
  }

  // --- outbox (used when a remote store is active) ------------------------

  async enqueueOutbox(
    targetId: string,
    kind: 'samples' | 'events' | 'session-start' | 'session-end' | 'device',
    payload: unknown,
  ): Promise<void> {
    await this.#require().add('outbox', {
      targetId,
      kind,
      payload,
      queuedAt: Date.now(),
      attempts: 0,
    });
  }

  async peekOutbox(targetId: string, limit: number): Promise<Array<{ seq: number; kind: string; payload: unknown }>> {
    const rows = await this.#require().getAllFromIndex(
      'outbox',
      'by_target',
      IDBKeyRange.bound([targetId, -Infinity], [targetId, Infinity]),
      limit,
    );
    return rows.map((r) => ({ seq: r.seq!, kind: r.kind, payload: r.payload }));
  }

  async ackOutbox(seqs: readonly number[]): Promise<void> {
    const tx = this.#require().transaction('outbox', 'readwrite');
    for (const seq of seqs) await tx.store.delete(seq);
    await tx.done;
  }

  async outboxSize(targetId: string): Promise<number> {
    return this.#require().countFromIndex(
      'outbox',
      'by_target',
      IDBKeyRange.bound([targetId, -Infinity], [targetId, Infinity]),
    );
  }

  // --- misc ---------------------------------------------------------------

  async getMeta<T>(key: string): Promise<T | null> {
    const row = await this.#require().get('meta', key);
    return (row?.value as T | undefined) ?? null;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await this.#require().put('meta', { key, value });
  }
}

/**
 * Writes samples and updates the affected rollups in one transaction.
 *
 * Existing keys are found with a single range read rather than one lookup per row, which
 * keeps a 5,000-row import batch to one read plus the writes it actually needs.
 */
async function appendSamplesInTx(
  tx: IDBPTransaction<HistoryDB, ['samples', 'rollups'], 'readwrite'>,
  rows: readonly Sample[],
): Promise<AppendResult> {
  const sampleStore = tx.objectStore('samples');
  const rollupStore = tx.objectStore('rollups');

  const byDevice = new Map<DeviceId, Sample[]>();
  for (const row of rows) {
    const list = byDevice.get(row.deviceId);
    if (list) list.push(row);
    else byDevice.set(row.deviceId, [row]);
  }

  let accepted = 0;
  let deduped = 0;

  for (const [deviceId, deviceRows] of byDevice) {
    const sorted = [...deviceRows].sort((a, b) => a.ts - b.ts);
    const minTs = sorted[0]!.ts;
    const maxTs = sorted[sorted.length - 1]!.ts;
    const existingKeys = await sampleStore.getAllKeys(range(deviceId, minTs, maxTs + 1));
    const existing = new Set(existingKeys.map((key) => (key as [DeviceId, Millis])[1]));

    const fresh: Sample[] = [];
    for (const row of sorted) {
      if (existing.has(row.ts)) {
        deduped += 1;
        continue;
      }
      existing.add(row.ts);
      fresh.push(row);
      await sampleStore.put(row);
      accepted += 1;
    }
    if (fresh.length === 0) continue;

    for (const [level, bucketSize] of Object.entries(ROLLUP_LEVEL_MS) as Array<
      [RollupLevel, number]
    >) {
      const deltas = new Map<number, Accumulator>();
      for (const row of fresh) {
        const bucketMs = Math.floor(row.ts / bucketSize) * bucketSize;
        let acc = deltas.get(bucketMs);
        if (!acc) {
          acc = newAccumulator(bucketMs);
          deltas.set(bucketMs, acc);
        }
        accumulate(acc, row);
      }
      for (const [bucketMs, delta] of deltas) {
        const key: [DeviceId, RollupLevel, Millis] = [deviceId, level, bucketMs];
        const current = await rollupStore.get(key);
        const merged = current ? mergeAccumulators(current.acc, delta) : delta;
        await rollupStore.put({ deviceId, level, bucketMs, acc: merged });
      }
    }
  }

  return { accepted, deduped, rejected: 0 };
}

function groupKey(ts: Millis, groupBy: NonNullable<AggregateQuery['groupBy']>): number {
  const date = new Date(ts);
  switch (groupBy) {
    case 'hourOfDay':
      return date.getHours();
    case 'dayOfWeek':
      return date.getDay();
    case 'day':
      return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    default:
      return 0;
  }
}
