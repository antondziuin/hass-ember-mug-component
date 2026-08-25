/**
 * IndexedDB schema.
 *
 * The `samples` store uses a compound in-line key of `[deviceId, ts]`, which does three
 * jobs at once: it is the range index every chart query needs, it makes `put()` an
 * idempotent upsert, and it therefore makes a replayed import a no-op for free.
 */

import type { DBSchema } from 'idb';

import type { Accumulator } from '../../bucketing.js';
import type {
  DeviceEvent,
  DeviceId,
  DeviceRecord,
  Millis,
  Sample,
  SessionRecord,
} from '../../types.js';

export const DB_NAME = 'ember-mug-history';
export const DB_VERSION = 1;

export type RollupLevel = '1h' | '1d';

export const ROLLUP_LEVEL_MS: Readonly<Record<RollupLevel, number>> = {
  '1h': 3_600_000,
  '1d': 86_400_000,
};

export interface RollupRecord {
  deviceId: DeviceId;
  level: RollupLevel;
  bucketMs: Millis;
  acc: Accumulator;
}

/** One pending write for a remote store, held locally until it is acknowledged. */
export interface OutboxRecord {
  seq?: number;
  targetId: string;
  kind: 'samples' | 'events' | 'session-start' | 'session-end' | 'device';
  payload: unknown;
  queuedAt: Millis;
  attempts: number;
}

export interface MetaRecord {
  key: string;
  value: unknown;
}

export interface HistoryDB extends DBSchema {
  devices: {
    key: DeviceId;
    value: DeviceRecord;
    indexes: { by_serial: string };
  };
  sessions: {
    key: string;
    value: SessionRecord;
    indexes: { by_device_start: [DeviceId, Millis] };
  };
  samples: {
    key: [DeviceId, Millis];
    value: Sample;
  };
  events: {
    key: string;
    value: DeviceEvent;
    indexes: {
      by_device_ts: [DeviceId, Millis];
      by_natural: [DeviceId, Millis, string];
    };
  };
  rollups: {
    key: [DeviceId, RollupLevel, Millis];
    value: RollupRecord;
  };
  outbox: {
    key: number;
    value: OutboxRecord;
    indexes: { by_target: [string, number] };
  };
  meta: {
    key: string;
    value: MetaRecord;
  };
}
