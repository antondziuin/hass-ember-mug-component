import type {
  DeviceColour,
  DeviceModel,
  DeviceType,
  LiquidState,
  TemperatureUnit,
  VolumeLevel,
} from './constants.js';
import type { EmberFailure } from './errors.js';

/** RGBA as stored in characteristic 20. Brightness is the alpha byte. */
export interface Colour {
  red: number;
  green: number;
  blue: number;
  brightness: number;
}

export interface BatteryInfo {
  percent: number;
  onChargingBase: boolean;
}

export interface FirmwareInfo {
  version: number;
  hardware: number;
  bootloader: number | null;
}

export interface MugMeta {
  /** Base64 of the first six bytes. Its meaning is not understood; shown in diagnostics. */
  mugId: string;
  serialNumber: string | null;
}

export interface DateTimeZone {
  date: Date | null;
  /** Byte 5, assumed to be a signed hour offset. Never written - see the plan. */
  offsetHours: number | null;
}

/** Every readable/writable attribute, keyed the way the poll scheduler refers to them. */
export type Attribute =
  | 'name'
  | 'ledColour'
  | 'currentTemp'
  | 'targetTemp'
  | 'temperatureUnit'
  | 'battery'
  | 'liquidLevel'
  | 'liquidState'
  | 'volumeLevel'
  | 'batteryVoltage'
  | 'dateTimeZone'
  | 'firmware'
  | 'meta'
  | 'dsk'
  | 'udsk';

/** Decoded attribute values, all optional until first read. */
export interface EmberAttributes {
  name?: string;
  ledColour?: Colour;
  /** Celsius. */
  currentTemp?: number;
  /** Celsius. 0 means temperature control is off. */
  targetTemp?: number;
  temperatureUnit?: TemperatureUnit;
  battery?: BatteryInfo;
  /** Raw device units: 0-30, or 0-100 on a Travel Mug. */
  liquidLevel?: number;
  liquidState?: LiquidState | null;
  volumeLevel?: VolumeLevel | null;
  batteryVoltage?: number;
  dateTimeZone?: DateTimeZone;
  firmware?: FirmwareInfo;
  meta?: MugMeta;
  dsk?: string;
  /** `null` means the characteristic reads as 20 zero bytes, i.e. the device is unprovisioned. */
  udsk?: string | null;
}

export type ModelSource =
  | 'user-override'
  | 'advertisement'
  | 'gatt-probe'
  | 'ble-name'
  | 'serial'
  | 'default';

export interface ModelDetection {
  model: DeviceModel | null;
  /** Never null - falls back to `mug`. */
  deviceType: DeviceType;
  colour: DeviceColour | null;
  source: ModelSource;
  confidence: 'exact' | 'family' | 'guess';
  /** Candidate models when detection could not narrow it down; drives the model picker. */
  ambiguous: DeviceModel[];
}

/** Whether writes actually take effect, discovered empirically by read-back. */
export type Writability = 'unknown' | 'yes' | 'no';

export type ConnectionState =
  | { status: 'unsupported'; reason: 'no-web-bluetooth' | 'insecure-context' | 'no-adapter' }
  | { status: 'idle' }
  | { status: 'needs-gesture'; remembered: RememberedDevice }
  | { status: 'connecting'; attempt: number }
  | { status: 'discovering' }
  | { status: 'connected'; since: number }
  | { status: 'reconnecting'; attempt: number; nextRetryAt: number }
  | { status: 'disconnected'; failure: EmberFailure | null };

/** Enough to render the whole UI greyed-out after a reload, before reconnecting. */
export interface RememberedDevice {
  /** Origin-scoped Web Bluetooth id. A hint for matching, never a persistence key. */
  bleId: string;
  bleName: string | null;
  serialNumber: string | null;
  model: DeviceModel | null;
  deviceType: DeviceType;
  lastSeenAt: number;
  attrs: EmberAttributes;
}

export interface DiagnosticEntry {
  at: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  failure?: EmberFailure;
}

export interface EmberDeviceState {
  connection: ConnectionState;
  detection: ModelDetection | null;
  capabilities: ReadonlySet<Attribute>;
  attrs: EmberAttributes;
  /** Attributes with an in-flight optimistic write. */
  pending: ReadonlySet<Attribute>;
  writability: Writability;
  bleName: string | null;
  bleId: string | null;
  /** Characteristic UUIDs found on the device that this app does not recognise. */
  unknownCharUuids: readonly string[];
  lastUpdate: number | null;
  lastFailure: EmberFailure | null;
  /** True once the device has reported that no Ember-app auth info exists. */
  authInfoMissing: boolean;
}

/** Result of a write: `confirmed` is false when the read-back disagreed. */
export interface WriteResult {
  confirmed: boolean;
}

/** Minimal key/value persistence, so the device layer never imports `localStorage` directly. */
export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}
