/**
 * Types for the server's SQLite layer.
 *
 * The server itself is plain JavaScript so it runs with no build step; these declarations
 * exist so the conformance suite can hold it to the same numbers as the client fold.
 */

export declare const SCHEMA_VERSION: number;
export declare const MAX_GAP_MS: number;
export declare const LIQUID_STATE_COUNT: number;
export declare const LIQUID_PRESENT_DPC: number;
export declare const TARGET_HISTOGRAM_BIN_CENTI_C: number;

export interface BucketRow {
  b: number;
  n: number;
  temp_avg: number | null;
  temp_min: number | null;
  temp_max: number | null;
  batt_avg: number | null;
  batt_min: number | null;
  batt_max: number | null;
  liquid_avg: number | null;
  state_last: number | null;
  target_last: number | null;
  charge_frac: number | null;
}

export interface ServerAggregates {
  from: number;
  to: number;
  observedMs: number;
  coverage: number;
  sampleCount: number;
  temp: { minC: number | null; maxC: number | null; meanC: number | null };
  msPerState: number[];
  msOnCharger: number;
  msTempControlOn: number;
  msLiquidPresent: number;
  battery: {
    minPct: number | null;
    maxPct: number | null;
    dischargedPct: number;
    chargedPct: number;
  };
  targetHistogram: Array<{ targetC: number; ms: number }>;
  sessionCount: number;
}

/** `[ts, tempC, targetC, batteryDpc, liquidDpc, liquidState, batteryMv, flags, sessionId]` */
export type ServerSampleTuple = [
  number,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number,
  string | null,
];

export declare class HistoryDb {
  constructor(db: unknown);
  close(): void;
  vacuum(): void;
  upsertDevice(device: object): void;
  listDevices(): Array<Record<string, unknown>>;
  deleteDevice(deviceId: string): void;
  mergeDevices(fromId: string, intoId: string): { movedSamples: number; movedEvents: number };
  upsertSession(session: object): void;
  endSession(sessionId: string, endedMs: number, reason: string, sampleCount: number): void;
  listSessions(deviceId: string, from: number, to: number): Array<Record<string, unknown>>;
  insertSamples(
    deviceId: string,
    tuples: readonly ServerSampleTuple[],
  ): { accepted: number; deduped: number; rejected: number };
  insertEvents(rows: readonly object[]): {
    accepted: number;
    deduped: number;
    rejected: number;
  };
  bounds(deviceId: string): {
    minTs: number;
    maxTs: number;
    sampleCount: number;
    eventCount: number;
  } | null;
  rawSamples(
    deviceId: string,
    from: number,
    to: number,
    limit: number,
  ): Array<Record<string, unknown>>;
  bucketed(
    deviceId: string,
    from: number,
    to: number,
    bucketMs: number,
    limit: number,
  ): BucketRow[];
  aggregate(deviceId: string, from: number, to: number): ServerAggregates;
  queryEvents(
    deviceId: string,
    from: number,
    to: number,
    types: string[] | null,
    limit?: number,
  ): Array<Record<string, unknown>>;
  deleteRange(
    deviceId: string,
    from: number,
    to: number,
    include: readonly string[],
  ): { samples: number; events: number; sessions: number };
}

export declare function openDatabase(path: string): Promise<HistoryDb>;
export declare function loadSqlite(): Promise<unknown>;
