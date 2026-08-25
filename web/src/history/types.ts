/**
 * Domain types for recorded history.
 *
 * Numeric columns are stored as integers in device-native resolution - centi-degrees,
 * deci-percent, millivolts - so dead-band comparisons are exact and rows stay small.
 */

export type DeviceId = string; // 'sn:AB12CD34EF' | 'anon:<uuid>'
export type SessionId = string;
export type EventId = string;
/** Epoch milliseconds, UTC. */
export type Millis = number;

export type LiquidStateCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const SampleFlag = {
  OnChargingBase: 1 << 0,
  TempControlOn: 1 << 1,
  /** The device's own display unit was Fahrenheit at the time. Informational only. */
  DeviceUnitF: 1 << 2,
  /** Emitted by the max-interval rule rather than by an actual change. */
  Heartbeat: 1 << 3,
  /** A replayed suppressed sample, written just before a discrete transition. */
  EdgeHold: 1 << 4,
  /** First or last sample of a connection session. */
  SessionBoundary: 1 << 5,
} as const;

export interface Sample {
  deviceId: DeviceId;
  ts: Millis;
  sessionId: SessionId | null;
  /** Hundredths of a degree Celsius. */
  tempC: number | null;
  /**
   * Hundredths of a degree Celsius, or null when temperature control is off.
   *
   * Deliberately not the device's own 0 sentinel: a literal zero would be swept into
   * AVG() and drag the target line to the floor on every bucketed chart.
   */
  targetC: number | null;
  /** Tenths of a percent, 0-1000. */
  batteryDpc: number | null;
  /** Tenths of a percent, 0-1000, already normalised for the model's full scale. */
  liquidDpc: number | null;
  liquidState: LiquidStateCode | null;
  /** Travel Mug only. */
  batteryMv: number | null;
  flags: number;
}

export type EventType =
  | 'session_start'
  | 'session_end'
  | 'visibility_hidden'
  | 'visibility_visible'
  | 'state_change'
  | 'charger_on'
  | 'charger_off'
  | 'target_change'
  | 'temp_control_on'
  | 'temp_control_off'
  | 'liquid_filled'
  | 'liquid_emptied'
  | 'battery_low'
  | 'battery_full'
  | 'unit_change'
  | 'led_change'
  | 'name_change'
  | 'firmware_change'
  | 'device_added'
  | 'note';

export interface DeviceEvent {
  eventId: EventId;
  deviceId: DeviceId;
  ts: Millis;
  type: EventType;
  sessionId: SessionId | null;
  /** Value before the change, where one applies. */
  numA: number | null;
  /** Value after the change. */
  numB: number | null;
  textA: string | null;
  data: Record<string, unknown> | null;
}

export type SessionEndReason =
  | 'user_disconnect'
  | 'ble_disconnect'
  | 'tab_closed'
  | 'error'
  | 'unknown';

export interface SessionRecord {
  sessionId: SessionId;
  deviceId: DeviceId;
  startedMs: Millis;
  /** Null while the session is still open. */
  endedMs: Millis | null;
  endReason: SessionEndReason | null;
  sampleCount: number;
  appVersion: string;
}

export type StoredDeviceType = 'mug' | 'cup' | 'travel_mug' | 'tumbler' | 'unknown';

export interface DeviceRecord {
  deviceId: DeviceId;
  serialNumber: string | null;
  name: string | null;
  model: string | null;
  deviceType: StoredDeviceType;
  capacityMl: number | null;
  colour: string | null;
  fwVersion: string | null;
  fwHardware: string | null;
  fwBootloader: string | null;
  liquidLevelMax: 30 | 100;
  firstSeenMs: Millis;
  lastSeenMs: Millis;
  /** Origin-scoped Web Bluetooth id. A matching hint only, never a key. */
  bleHint: string | null;
  meta: Record<string, unknown> | null;
}

export type Bucket = 'raw' | '1m' | '5m' | '1h' | '1d';

export const BUCKET_MS: Readonly<Record<Exclude<Bucket, 'raw'>, number>> = {
  '1m': 60_000,
  '5m': 300_000,
  '1h': 3_600_000,
  '1d': 86_400_000,
};

/**
 * Columnar series data. Every array is the same length and parallel to `t`.
 *
 * `null` means a gap. It has to be literal null, not NaN, because that is the only value
 * the chart layer treats as a break in the line - which rules out typed arrays here.
 */
export interface SeriesFrame {
  deviceId: DeviceId;
  bucket: Bucket;
  from: Millis;
  to: Millis;
  /** Seconds, ascending and strictly increasing. */
  t: number[];
  /** Raw value, or the bucket mean. Degrees Celsius. */
  tempC: (number | null)[] | null;
  tempMinC: (number | null)[] | null;
  tempMaxC: (number | null)[] | null;
  /** Last value in the bucket; step semantics. Null where control was off. */
  targetC: (number | null)[] | null;
  batteryPct: (number | null)[] | null;
  batteryMinPct: (number | null)[] | null;
  batteryMaxPct: (number | null)[] | null;
  liquidPct: (number | null)[] | null;
  /** Exact for raw, last-in-bucket otherwise. */
  liquidState: (number | null)[] | null;
  /** Fraction of the bucket spent on the charger, 0-1. */
  chargeFrac: (number | null)[] | null;
  count: number[] | null;
  /** True when the query hit its row limit and the series is incomplete. */
  truncated: boolean;
}

export type SeriesField = Exclude<
  keyof SeriesFrame,
  'deviceId' | 'bucket' | 'from' | 'to' | 't' | 'truncated'
>;

export interface Bounds {
  minTs: Millis;
  maxTs: Millis;
  sampleCount: number;
  eventCount: number;
}

export interface AppendResult {
  accepted: number;
  deduped: number;
  rejected: number;
}

export interface Aggregates {
  from: Millis;
  to: Millis;
  /** Total time the app was actually connected within the window. */
  observedMs: number;
  /** observedMs / (to - from), 0-1. The honesty denominator for every rate statistic. */
  coverage: number;
  sampleCount: number;
  temp: { minC: number | null; maxC: number | null; meanC: number | null };
  /** Time-weighted and gap-clamped, indexed by liquid state. */
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
  /** Time spent at each target temperature, in half-degree bins. */
  targetHistogram: Array<{ targetC: number; ms: number }>;
  sessionCount: number;
  /** Present when the query asked for a grouping. */
  buckets?: Array<{ key: number } & Omit<Aggregates, 'buckets' | 'from' | 'to'>>;
}
