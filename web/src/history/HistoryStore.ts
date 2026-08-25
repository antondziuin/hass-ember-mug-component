/**
 * The one interface every history backend implements.
 *
 * Everything above this line - charts, statistics, migration - talks only to these
 * methods, so IndexedDB, a local SQLite server and Supabase are interchangeable and the
 * migrator needs no per-backend code at all.
 */

import type {
  Aggregates,
  AppendResult,
  Bounds,
  Bucket,
  DeviceEvent,
  DeviceId,
  DeviceRecord,
  EventType,
  Millis,
  Sample,
  SeriesField,
  SeriesFrame,
  SessionEndReason,
  SessionId,
  SessionRecord,
} from './types.js';

export type StoreKind = 'indexeddb' | 'server' | 'supabase';

export interface SeriesQuery {
  deviceId: DeviceId;
  from: Millis;
  to: Millis;
  bucket: Bucket;
  /** Omit to receive every column. */
  fields?: readonly SeriesField[];
  limit?: number;
}

export interface EventQuery {
  deviceId: DeviceId;
  from: Millis;
  to: Millis;
  types?: readonly EventType[];
  limit?: number;
}

export interface RangeQuery {
  deviceId: DeviceId;
  from: Millis;
  to: Millis;
  limit?: number;
}

export interface AggregateQuery {
  deviceId: DeviceId;
  from: Millis;
  to: Millis;
  groupBy?: 'none' | 'hourOfDay' | 'dayOfWeek' | 'day';
}

export interface DeleteQuery {
  deviceId: DeviceId;
  from: Millis;
  to: Millis;
  include?: readonly ('samples' | 'events' | 'sessions')[];
}

export type ExportKind = 'devices' | 'sessions' | 'events' | 'samples';

export interface ExportQuery {
  deviceIds?: readonly DeviceId[];
  from?: Millis;
  to?: Millis;
  include?: readonly ExportKind[];
  /** Hint only; the store clamps to its own `maxBatchRows`. */
  batchRows?: number;
}

export type ExportChunk =
  | { kind: 'header'; v: 1; exportedAt: Millis; source: StoreKind; sourceId: string }
  | { kind: 'devices'; rows: DeviceRecord[] }
  | { kind: 'sessions'; rows: SessionRecord[] }
  | { kind: 'events'; rows: DeviceEvent[] }
  /** `lastTs` is the resume token for this device. */
  | { kind: 'samples'; deviceId: DeviceId; rows: Sample[]; lastTs: Millis };

export interface ImportOptions {
  onConflict?: 'ignore' | 'replace';
  dryRun?: boolean;
}

export interface ImportProgress {
  kind: ExportKind;
  deviceId?: DeviceId;
  rowsSeen: number;
  rowsAccepted: number;
  rowsDeduped: number;
  /** Checkpoint token; persist this to make the import resumable. */
  lastTs?: Millis;
}

export type ProbeErrorCode =
  | 'unreachable'
  | 'cors'
  | 'mixed_content'
  | 'unauthorized'
  | 'schema_mismatch'
  | 'quota'
  | 'unsupported'
  | 'unknown';

export interface StoreCapabilities {
  buckets: readonly Bucket[];
  serverSideBucketing: boolean;
  serverSideStats: boolean;
  maxBatchRows: number;
  streamingExport: boolean;
  deleteRange: boolean;
  multiDevice: boolean;
  transactional: boolean;
}

export interface StoreProbe {
  ok: boolean;
  kind: StoreKind;
  id: string;
  latencyMs: number;
  schemaVersion: number;
  writable: boolean;
  capabilities: StoreCapabilities;
  usage?: {
    bytes?: number;
    quotaBytes?: number;
    /** Whether the browser has promised not to evict this origin's storage. */
    persisted?: boolean;
    rowCount?: number;
  };
  error?: { code: ProbeErrorCode; message: string; hint?: string };
}

export interface HistoryStore {
  readonly kind: StoreKind;
  /**
   * Stable fingerprint of the target, e.g. `idb:ember-mug-history`,
   * `server:http://localhost:41821`, `supabase:<ref>:<user>`. Migration checkpoints are
   * keyed on this, so it must not change between sessions for the same target.
   */
  readonly id: string;

  open(): Promise<void>;
  close(): Promise<void>;
  probe(signal?: AbortSignal): Promise<StoreProbe>;

  upsertDevice(device: DeviceRecord): Promise<void>;
  listDevices(): Promise<DeviceRecord[]>;
  getDevice(deviceId: DeviceId): Promise<DeviceRecord | null>;
  /** Folds one device's rows into another, for when an anonymous id later gains a serial. */
  mergeDevices(
    fromId: DeviceId,
    intoId: DeviceId,
  ): Promise<{ movedSamples: number; movedEvents: number }>;

  startSession(session: SessionRecord): Promise<void>;
  endSession(
    sessionId: SessionId,
    endedMs: Millis,
    reason: SessionEndReason,
    sampleCount: number,
  ): Promise<void>;
  listSessions(query: RangeQuery): Promise<SessionRecord[]>;

  appendSamples(rows: readonly Sample[]): Promise<AppendResult>;
  appendEvents(rows: readonly DeviceEvent[]): Promise<AppendResult>;

  bounds(deviceId: DeviceId): Promise<Bounds | null>;
  queryRange(query: SeriesQuery, signal?: AbortSignal): Promise<SeriesFrame>;
  queryEvents(query: EventQuery, signal?: AbortSignal): Promise<DeviceEvent[]>;
  aggregate(query: AggregateQuery, signal?: AbortSignal): Promise<Aggregates>;

  exportStream(query: ExportQuery, signal?: AbortSignal): AsyncIterable<ExportChunk>;
  importStream(
    source: AsyncIterable<ExportChunk>,
    options?: ImportOptions,
  ): AsyncIterable<ImportProgress>;

  deleteRange(query: DeleteQuery): Promise<{ samples: number; events: number; sessions: number }>;
  deleteDevice(deviceId: DeviceId): Promise<void>;
  /** Optional housekeeping: SQLite VACUUM, IndexedDB rollup rebuild. */
  compact?(): Promise<void>;
}

/**
 * Deterministic device identity.
 *
 * Deriving the id from the serial number means two browsers looking at the same mug
 * converge on the same row with no coordination, which is what dissolves the
 * "two devices, one database" problem.
 */
export function deriveDeviceId(serialNumber: string | null | undefined): DeviceId {
  const cleaned = (serialNumber ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return cleaned.length >= 6 ? `sn:${cleaned}` : `anon:${crypto.randomUUID()}`;
}

export function isAnonymousDeviceId(deviceId: DeviceId): boolean {
  return deviceId.startsWith('anon:');
}
