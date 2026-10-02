/**
 * Connection lifecycle, polling, push-event handling and writes for one Ember device.
 *
 * Deliberately React-free: a plain emitter over an immutable snapshot, so the whole
 * thing runs and is tested in Node without a DOM or a radio.
 */

import { buildCharIndex, type CharIndex } from './charIndex.js';
import {
  CONNECT_TIMEOUT_MS,
  DEFAULT_TARGET_C,
  FULL_POLL_EVERY_N_TICKS,
  HOT_POLL_MS,
  IDLE_POLL_MS,
  LiquidState,
  PUSH_COALESCE_MS,
  PUSH_DEBOUNCE_MS,
  PushEventId,
  RECONNECT_BACKOFF_MS,
  TEMP_OFF,
  type DeviceModel,
  type TemperatureUnit,
  type VolumeLevel,
} from './constants.js';
import {
  decodeBattery,
  decodeBatteryVoltage,
  decodeColour,
  decodeDateTimeZone,
  decodeDsk,
  decodeFirmware,
  decodeLiquidLevel,
  decodeLiquidState,
  decodeMugId,
  decodeName,
  decodePushEvent,
  decodeTemperature,
  decodeTemperatureUnit,
  decodeUdsk,
  decodeVolumeLevel,
  encodeColour,
  encodeName,
  encodeTemperature,
  encodeTemperatureUnit,
  encodeUdsk,
  encodeVolumeLevel,
  validateTargetTemp,
} from './codecs.js';
import { detectModel } from './detectModel.js';
import { EmberError, classify, type EmberFailure } from './errors.js';
import { GattQueue } from './gattQueue.js';
import { attributeForChar, liquidLevelMaxFor, resolveCapabilities } from './models.js';
import {
  browserStore,
  devicePrefsKey,
  loadDevicePrefs,
  rekeyDevicePrefs,
  saveDevicePrefs,
  saveRememberedDevice,
  type DevicePrefs,
} from './persistence.js';
import { PUSH_EVENT_ATTRIBUTES, PUSH_EVENT_LABEL, PushEventDebouncer } from './pushEvents.js';
import { emberReducer, initialState, type EmberAction } from './reducer.js';
import { requestEmberDevice, tryReadManufacturerData, type RequestOptions } from './requestDevice.js';
import { writeCharacteristic, type BluetoothDeviceLike, type GattServerLike } from './bluetooth.js';
import type {
  Attribute,
  Colour,
  DiagnosticEntry,
  EmberAttributes,
  EmberDeviceState,
  KeyValueStore,
  WriteResult,
} from './types.js';
import { Char, type CharId } from './uuids.js';

/** Read once per connection; these do not change while the device is awake. */
export const INITIAL_ATTRS: readonly Attribute[] = [
  'meta',
  'firmware',
  'udsk',
  'dsk',
  'dateTimeZone',
];

/** Read on every tick. */
export const HOT_ATTRS: readonly Attribute[] = [
  'currentTemp',
  'liquidState',
  'liquidLevel',
  'battery',
];

/** Read on a full sweep. */
export const POLL_ATTRS: readonly Attribute[] = [
  'currentTemp',
  'targetTemp',
  'temperatureUnit',
  'battery',
  'liquidLevel',
  'liquidState',
  'ledColour',
  'name',
  'volumeLevel',
  'batteryVoltage',
];

interface Reader {
  char: CharId;
  decode: (dv: DataView) => unknown;
}

const READERS: Readonly<Record<Attribute, Reader>> = {
  name: { char: Char.MUG_NAME, decode: decodeName },
  currentTemp: { char: Char.CURRENT_TEMPERATURE, decode: decodeTemperature },
  targetTemp: { char: Char.TARGET_TEMPERATURE, decode: decodeTemperature },
  temperatureUnit: { char: Char.TEMPERATURE_UNIT, decode: decodeTemperatureUnit },
  liquidLevel: { char: Char.LIQUID_LEVEL, decode: decodeLiquidLevel },
  dateTimeZone: { char: Char.DATE_TIME_AND_ZONE, decode: decodeDateTimeZone },
  battery: { char: Char.BATTERY, decode: decodeBattery },
  liquidState: { char: Char.LIQUID_STATE, decode: decodeLiquidState },
  volumeLevel: { char: Char.VOLUME, decode: decodeVolumeLevel },
  firmware: { char: Char.FIRMWARE, decode: decodeFirmware },
  meta: { char: Char.MUG_ID, decode: decodeMugId },
  dsk: { char: Char.DSK, decode: decodeDsk },
  udsk: { char: Char.UDSK, decode: decodeUdsk },
  batteryVoltage: { char: Char.CONTROL_REGISTER_DATA, decode: decodeBatteryVoltage },
  ledColour: { char: Char.LED, decode: decodeColour },
};

export type DeviceSignal =
  | { type: 'connected'; at: number }
  | { type: 'disconnected'; at: number; unexpected: boolean }
  | { type: 'push'; at: number; id: PushEventId }
  | { type: 'write'; at: number; attribute: Attribute; confirmed: boolean };

export interface EmberDeviceOptions {
  store?: KeyValueStore;
  now?: () => number;
  /** Subscribes to the statistics characteristic and keeps verbose diagnostics. */
  debug?: boolean;
  autoReconnect?: boolean;
}

const DIAGNOSTIC_LIMIT = 200;
const WRITE_PRIORITY = 10;
/** Consecutive polls that read nothing before the link is treated as dead. */
const DEAD_POLLS_BEFORE_RESET = 3;
/** Extra attempts for a write that timed out while the link still looked up. */
const WRITE_TIMEOUT_RETRIES = 1;

interface Waiter {
  resolve: (result: WriteResult) => void;
  reject: (error: unknown) => void;
}

/**
 * What the user last asked an attribute to be.
 *
 * Only the newest intent per attribute is ever written: a burst of slider moves becomes
 * one write of the final value, and an intent made while the link is down is written as
 * soon as it is back, instead of being thrown away.
 */
interface Intent {
  value: unknown;
  data: BufferSource;
  char: CharId;
  decode: (dv: DataView) => unknown;
  equals: (a: unknown, b: unknown) => boolean;
  /** The value the device is known to hold, restored if the write is refused. */
  base: unknown;
  waiters: Waiter[];
  timeouts: number;
}

export class EmberDevice {
  readonly #device: BluetoothDeviceLike;
  readonly #store: KeyValueStore;
  readonly #now: () => number;
  readonly #debug: boolean;

  #state: EmberDeviceState;
  #listeners = new Set<() => void>();
  #signalListeners = new Set<(signal: DeviceSignal) => void>();

  #queue: GattQueue;
  #server: GattServerLike | null = null;
  #chars: CharIndex | null = null;

  #debouncer: PushEventDebouncer;
  #dirty = new Set<Attribute>();
  #coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  #pollTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  #ticks = 0;
  #attempt = 0;
  #autoReconnect: boolean;
  #intentionalDisconnect = false;
  #destroyed = false;
  #disconnectBound = false;
  #prefsKey: string;
  #prefs: DevicePrefs;
  #diagnostics: DiagnosticEntry[] = [];
  #manufacturerData: DataView | null = null;
  #pageHideBound = false;
  #lifecycleBound = false;
  #adapterBound = false;
  #adapterAvailable = true;
  #releasedForPageHide = false;
  #opening: Promise<void> | null = null;
  #advertWatch: AbortController | null = null;
  #advertListener: ((event: Event) => void) | null = null;
  #intents = new Map<Attribute, Intent>();
  #flushing = new Set<Attribute>();
  /** Bumped on every user intent, so a read issued before it can be recognised as stale. */
  #epochs = new Map<Attribute, number>();
  #deadPolls = 0;

  constructor(device: BluetoothDeviceLike, options: EmberDeviceOptions = {}) {
    this.#device = device;
    this.#store = options.store ?? browserStore();
    this.#now = options.now ?? Date.now;
    this.#debug = options.debug ?? false;
    this.#autoReconnect = options.autoReconnect ?? true;

    this.#prefsKey = devicePrefsKey(null, device.id);
    this.#prefs = loadDevicePrefs(this.#store, this.#prefsKey);

    this.#queue = new GattQueue({ onFatal: (failure) => this.#onQueueFatal(failure) });
    // Shares the injected clock so the debounce window is testable without real timers.
    this.#debouncer = new PushEventDebouncer(PUSH_DEBOUNCE_MS, this.#now);

    this.#state = initialState({ status: 'idle' });
    this.#dispatch({
      type: 'device-info',
      bleId: device.id,
      bleName: device.name ?? null,
    });
  }

  /** Opens the chooser and wraps the chosen device. Must run inside a user gesture. */
  static async pick(
    options: RequestOptions & EmberDeviceOptions = {},
  ): Promise<EmberDevice> {
    const { acceptAll, ...deviceOptions } = options;
    const device = await requestEmberDevice({ acceptAll });
    return new EmberDevice(device as unknown as BluetoothDeviceLike, deviceOptions);
  }

  // --- snapshot -----------------------------------------------------------

  getSnapshot = (): EmberDeviceState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Discrete signals for the history recorder: connects, disconnects, push events, writes. */
  subscribeSignals = (listener: (signal: DeviceSignal) => void): (() => void) => {
    this.#signalListeners.add(listener);
    return () => this.#signalListeners.delete(listener);
  };

  get diagnostics(): readonly DiagnosticEntry[] {
    return this.#diagnostics;
  }

  get bluetoothDevice(): BluetoothDeviceLike {
    return this.#device;
  }

  get liquidLevelMax(): 30 | 100 {
    return liquidLevelMaxFor(this.#state.detection?.deviceType ?? 'mug');
  }

  #dispatch(action: EmberAction): void {
    const next = emberReducer(this.#state, action);
    if (next === this.#state) return;
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }

  #emit(signal: DeviceSignal): void {
    for (const listener of this.#signalListeners) listener(signal);
  }

  #log(level: DiagnosticEntry['level'], message: string, failure?: EmberFailure): void {
    this.#diagnostics.push(
      failure ? { at: this.#now(), level, message, failure } : { at: this.#now(), level, message },
    );
    if (this.#diagnostics.length > DIAGNOSTIC_LIMIT) {
      this.#diagnostics.splice(0, this.#diagnostics.length - DIAGNOSTIC_LIMIT);
    }
  }

  // --- lifecycle ----------------------------------------------------------

  async connect(): Promise<void> {
    this.#intentionalDisconnect = false;
    this.#autoReconnect = true;
    await this.#openSession();
  }

  /** Cancels the backoff timer and tries GATT immediately. */
  async reconnectNow(): Promise<void> {
    if (this.#destroyed || this.#intentionalDisconnect) return;
    if (this.#state.connection.status === 'connected') return;
    this.#autoReconnect = true;
    this.#attempt = 0;
    this.#clearReconnectTimer();
    this.#stopAdvertWatch();
    await this.#openSession().catch(() => {
      // #openSession already scheduled the next attempt when auto-reconnect is on.
    });
  }

  async disconnect(): Promise<void> {
    this.#intentionalDisconnect = true;
    this.#autoReconnect = false;
    this.#clearTimers();
    this.#stopAdvertWatch();
    await this.#unsubscribeNotifications();
    try {
      this.#device.gatt?.disconnect();
    } catch {
      // Already gone; the disconnect event will not fire again.
    }
    this.#queue.close({ kind: 'disconnected', unexpected: false });
    this.#server = null;
    this.#chars = null;
    this.#abandonIntents({ kind: 'disconnected', unexpected: false });
    this.#dispatch({ type: 'connection', connection: { status: 'disconnected', failure: null } });
    this.#emit({ type: 'disconnected', at: this.#now(), unexpected: false });
  }

  /** Tears everything down permanently. The instance must not be reused afterwards. */
  destroy(): void {
    this.#destroyed = true;
    this.#autoReconnect = false;
    this.#clearTimers();
    if (this.#disconnectBound) {
      this.#device.removeEventListener('gattserverdisconnected', this.#onDisconnected);
      this.#disconnectBound = false;
    }
    if (this.#pageHideBound && typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.#onPageHide);
      window.removeEventListener('pageshow', this.#onPageShow);
      this.#pageHideBound = false;
    }
    if (this.#lifecycleBound && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.#onVisibilityChange);
      this.#lifecycleBound = false;
    }
    this.#unbindAdapter();
    this.#stopAdvertWatch();
    try {
      this.#device.gatt?.disconnect();
    } catch {
      // Nothing to do.
    }
    this.#queue.close({ kind: 'disconnected', unexpected: false });
    this.#abandonIntents({ kind: 'disconnected', unexpected: false });
    this.#listeners.clear();
    this.#signalListeners.clear();
  }

  async #openSession(): Promise<void> {
    if (this.#destroyed) return;
    if (this.#opening) return this.#opening;
    this.#opening = this.#runOpenSession().finally(() => {
      this.#opening = null;
    });
    return this.#opening;
  }

  async #runOpenSession(): Promise<void> {
    if (this.#destroyed || this.#intentionalDisconnect) return;

    const gatt = this.#device.gatt;
    if (!gatt) {
      const failure: EmberFailure = { kind: 'unsupported', reason: 'no-adapter' };
      this.#dispatch({ type: 'connection', connection: { status: 'disconnected', failure } });
      throw new EmberError(failure);
    }

    this.#dispatch({ type: 'connection', connection: { status: 'connecting', attempt: this.#attempt } });

    // Registered once on the device so it survives reconnects; re-registering leaks handlers.
    if (!this.#disconnectBound) {
      this.#device.addEventListener('gattserverdisconnected', this.#onDisconnected);
      this.#disconnectBound = true;
    }

    // Leaving the link open across a reload is what locks the Ember phone app out of the
    // mug afterwards, so it is released explicitly as the page goes away.
    this.#bindLifecycle();

    try {
      this.#server = await withTimeout(gatt.connect(), CONNECT_TIMEOUT_MS, 'connect');
    } catch (error) {
      // A timed-out connect may still be pending inside the browser; cancel it so the
      // next attempt starts clean instead of queueing behind it.
      try {
        gatt.disconnect();
      } catch {
        // Nothing was open.
      }
      const failure: EmberFailure = { kind: 'connect-failed', attempt: this.#attempt, cause: error };
      this.#log('warn', 'Connection attempt failed', failure);
      this.#dispatch({ type: 'failure', failure });
      if (this.#autoReconnect && !this.#intentionalDisconnect && !this.#destroyed) {
        if (this.#reconnectTimer === null) this.#scheduleReconnect();
      } else {
        this.#dispatch({ type: 'connection', connection: { status: 'disconnected', failure } });
      }
      throw new EmberError(failure);
    }

    if (this.#destroyed || this.#intentionalDisconnect) {
      try {
        this.#device.gatt?.disconnect();
      } catch {
        // The page or the user already asked us to let go.
      }
      return;
    }

    this.#queue.reopen();
    this.#dispatch({ type: 'connection', connection: { status: 'discovering' } });

    try {
      await this.#setUpSession(this.#server);
    } catch (error) {
      if (this.#destroyed || this.#intentionalDisconnect) return;
      // Discovery or the first reads failed on a link that did open. Drop it and go
      // round again rather than sitting in "discovering" forever.
      const failure = error instanceof EmberError ? error.failure : classify(error, 'setup');
      this.#log('warn', 'Session setup failed; reconnecting', failure);
      this.#queue.close({ kind: 'disconnected', unexpected: true });
      this.#server = null;
      this.#chars = null;
      try {
        gatt.disconnect();
      } catch {
        // Already down.
      }
      if (this.#autoReconnect && this.#reconnectTimer === null) this.#scheduleReconnect();
      throw error instanceof EmberError ? error : new EmberError(failure);
    }
  }

  async #setUpSession(server: GattServerLike): Promise<void> {
    this.#chars = await buildCharIndex(server, this.#queue);
    this.#dispatch({ type: 'unknown-chars', uuids: this.#chars.unknownCharUuids });
    if (this.#chars.present.size === 0) {
      this.#log('error', 'No known Ember characteristics were found on this device.');
    }

    // Best-effort; absent unless the experimental-features flag is on.
    this.#manufacturerData ??= await tryReadManufacturerData(
      this.#device as unknown as BluetoothDevice,
    );

    this.#identify();
    await this.#subscribeNotifications();

    await this.#readAttributes(INITIAL_ATTRS);
    this.#adoptSerialKey();
    // Re-identify now that the serial number is known and may refine the model.
    this.#identify();

    await this.#readAttributes(this.#capableAttrs(POLL_ATTRS));

    if (this.#destroyed || this.#intentionalDisconnect) return;

    this.#attempt = 0;
    this.#ticks = 0;
    this.#deadPolls = 0;
    this.#clearReconnectTimer();
    this.#stopAdvertWatch();
    this.#dispatch({ type: 'failure', failure: null });
    this.#dispatch({ type: 'connection', connection: { status: 'connected', since: this.#now() } });
    this.#emit({ type: 'connected', at: this.#now() });
    this.#log('info', 'Connected');
    this.#remember();
    this.#scheduleTick();
    // Anything the user changed while the link was down goes out first.
    this.#flushAllIntents();
    void this.#probeWritability();
  }

  #identify(): void {
    const detection = detectModel({
      override: this.#prefs.modelOverride ?? null,
      manufacturerData: this.#manufacturerData,
      services: this.#chars?.services,
      presentChars: this.#chars?.present,
      bleName: this.#device.name ?? null,
      serialNumber: this.#state.attrs.meta?.serialNumber ?? null,
    });
    this.#dispatch({
      type: 'identified',
      detection,
      capabilities: resolveCapabilities(detection.model, this.#chars?.present ?? new Set()),
    });
  }

  /** Migrates preferences from the Bluetooth-id key to the portable serial key. */
  #adoptSerialKey(): void {
    const serial = this.#state.attrs.meta?.serialNumber ?? null;
    if (!serial) return;
    const nextKey = devicePrefsKey(serial, this.#device.id);
    if (nextKey === this.#prefsKey) return;
    rekeyDevicePrefs(this.#store, this.#prefsKey, nextKey);
    this.#prefsKey = nextKey;
    this.#prefs = loadDevicePrefs(this.#store, nextKey);
  }

  #remember(): void {
    saveRememberedDevice(this.#store, {
      bleId: this.#device.id,
      bleName: this.#device.name ?? null,
      serialNumber: this.#state.attrs.meta?.serialNumber ?? null,
      model: this.#state.detection?.model ?? null,
      deviceType: this.#state.detection?.deviceType ?? 'mug',
      lastSeenAt: this.#now(),
      attrs: this.#state.attrs,
    });
  }

  #bindLifecycle(): void {
    if (!this.#pageHideBound && typeof window !== 'undefined') {
      window.addEventListener('pagehide', this.#onPageHide);
      window.addEventListener('pageshow', this.#onPageShow);
      this.#pageHideBound = true;
    }
    if (!this.#lifecycleBound && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.#onVisibilityChange);
      this.#lifecycleBound = true;
    }
    this.#bindAdapter();
  }

  #onPageHide = (): void => {
    this.#releasedForPageHide = true;
    this.#intentionalDisconnect = true;
    this.#autoReconnect = false;
    this.#stopAdvertWatch();
    try {
      this.#device.gatt?.disconnect();
    } catch {
      // The page is going away regardless.
    }
  };

  #onPageShow = (): void => {
    if (!this.#releasedForPageHide || this.#destroyed) return;
    this.#releasedForPageHide = false;
    this.#intentionalDisconnect = false;
    this.#autoReconnect = true;
    this.#attempt = 0;
    void this.#openSession().catch(() => undefined);
  };

  #onVisibilityChange = (): void => {
    if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
    if (this.#destroyed || this.#intentionalDisconnect || !this.#autoReconnect) return;
    const status = this.#state.connection.status;
    if (status === 'connected' || status === 'connecting' || status === 'discovering') return;
    this.#attempt = 0;
    this.#clearReconnectTimer();
    this.#stopAdvertWatch();
    void this.#openSession().catch(() => undefined);
  };

  #bindAdapter(): void {
    if (this.#adapterBound || typeof navigator === 'undefined') return;
    const bluetooth = navigator.bluetooth as
      | { addEventListener?: (type: string, listener: (event: Event) => void) => void }
      | undefined;
    if (typeof bluetooth?.addEventListener !== 'function') return;
    bluetooth.addEventListener('availabilitychanged', this.#onAvailabilityChanged);
    this.#adapterBound = true;
  }

  #unbindAdapter(): void {
    if (!this.#adapterBound || typeof navigator === 'undefined') return;
    const bluetooth = navigator.bluetooth as
      | { removeEventListener?: (type: string, listener: (event: Event) => void) => void }
      | undefined;
    bluetooth?.removeEventListener?.('availabilitychanged', this.#onAvailabilityChanged);
    this.#adapterBound = false;
  }

  #onAvailabilityChanged = (event: Event): void => {
    const available = (event as Event & { value?: boolean }).value;
    this.#adapterAvailable = available !== false;
    if (!this.#adapterAvailable) {
      this.#clearReconnectTimer();
      this.#stopAdvertWatch();
      this.#log('warn', 'Bluetooth adapter became unavailable');
      return;
    }
    if (this.#destroyed || this.#intentionalDisconnect || !this.#autoReconnect) return;
    if (this.#state.connection.status === 'connected') return;
    this.#attempt = 0;
    void this.#openSession().catch(() => undefined);
  };

  #onDisconnected = (): void => {
    const wasConnected = this.#state.connection.status === 'connected';
    this.#clearPollTimers();
    this.#chars = null;
    this.#server = null;
    this.#debouncer.reset();
    this.#queue.close({ kind: 'disconnected', unexpected: !this.#intentionalDisconnect });
    if (wasConnected) {
      this.#remember();
      this.#emit({
        type: 'disconnected',
        at: this.#now(),
        unexpected: !this.#intentionalDisconnect,
      });
    }

    if (this.#intentionalDisconnect || !this.#autoReconnect || this.#destroyed) {
      this.#clearReconnectTimer();
      this.#dispatch({ type: 'connection', connection: { status: 'disconnected', failure: null } });
      return;
    }

    // A failed attempt that cancelled itself has already queued the next one.
    if (this.#reconnectTimer !== null) return;
    if (wasConnected) this.#log('warn', 'Disconnected unexpectedly');
    this.#scheduleReconnect();
  };

  #onQueueFatal(failure: EmberFailure): void {
    this.#log('error', 'Bluetooth link wedged; forcing a reconnect', failure);
    try {
      this.#device.gatt?.disconnect();
    } catch {
      // The disconnect handler still runs via the event, if it can.
    }
  }

  #scheduleReconnect(): void {
    if (this.#destroyed || !this.#autoReconnect || this.#intentionalDisconnect) return;
    if (!this.#adapterAvailable) return;
    const base =
      RECONNECT_BACKOFF_MS[Math.min(this.#attempt, RECONNECT_BACKOFF_MS.length - 1)] ?? 30_000;
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.#attempt += 1;
    this.#dispatch({
      type: 'connection',
      connection: { status: 'reconnecting', attempt: this.#attempt, nextRetryAt: this.#now() + delay },
    });
    this.#startAdvertWatch();
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#stopAdvertWatch();
      void this.#openSession().catch(() => {
        // #openSession already scheduled the next attempt.
      });
    }, delay);
  }

  #deviceCanWatchAdvertisements(): boolean {
    return (
      typeof (this.#device as { watchAdvertisements?: unknown }).watchAdvertisements === 'function'
    );
  }

  #startAdvertWatch(): void {
    if (this.#advertWatch || !this.#deviceCanWatchAdvertisements()) return;
    const watchable = this.#device as BluetoothDeviceLike & {
      watchAdvertisements: (init?: { signal?: AbortSignal }) => Promise<void>;
    };
    const controller = new AbortController();
    this.#advertWatch = controller;
    const onAdvert = (): void => {
      if (this.#destroyed || !this.#autoReconnect || this.#intentionalDisconnect) return;
      if (this.#state.connection.status !== 'reconnecting') return;
      this.#log('info', 'Mug advertised; retrying immediately');
      this.#clearReconnectTimer();
      this.#stopAdvertWatch();
      void this.#openSession().catch(() => undefined);
    };
    this.#advertListener = onAdvert;
    this.#device.addEventListener('advertisementreceived', onAdvert);
    watchable.watchAdvertisements({ signal: controller.signal }).catch(() => {
      this.#stopAdvertWatch();
    });
  }

  #stopAdvertWatch(): void {
    if (this.#advertListener) {
      this.#device.removeEventListener('advertisementreceived', this.#advertListener);
      this.#advertListener = null;
    }
    this.#advertWatch?.abort();
    this.#advertWatch = null;
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }

  #clearPollTimers(): void {
    for (const timer of [this.#pollTimer, this.#coalesceTimer]) {
      if (timer !== null) clearTimeout(timer);
    }
    this.#pollTimer = null;
    this.#coalesceTimer = null;
  }

  #clearTimers(): void {
    this.#clearPollTimers();
    this.#clearReconnectTimer();
  }

  // --- notifications ------------------------------------------------------

  async #subscribeNotifications(): Promise<void> {
    const push = this.#chars?.byId.get(Char.PUSH_EVENT);
    if (push) {
      push.addEventListener('characteristicvaluechanged', this.#onPushEvent);
      try {
        await this.#queue.run('startNotifications:push', () => push.startNotifications(), {
          priority: WRITE_PRIORITY,
        });
      } catch (error) {
        // Not fatal: the app degrades to poll-only updates.
        this.#log('warn', 'Could not subscribe to push events', classify(error, 'startNotifications'));
      }
    }

    if (!this.#debug) return;
    const stats = this.#chars?.byId.get(Char.STATISTICS);
    if (!stats) return;
    stats.addEventListener('characteristicvaluechanged', this.#onStatistics);
    try {
      await this.#queue.run('startNotifications:statistics', () => stats.startNotifications());
    } catch {
      // Statistics are diagnostic only.
    }
  }

  async #unsubscribeNotifications(): Promise<void> {
    const push = this.#chars?.byId.get(Char.PUSH_EVENT);
    if (push) {
      push.removeEventListener('characteristicvaluechanged', this.#onPushEvent);
      try {
        await push.stopNotifications();
      } catch {
        // The link is probably already down.
      }
    }
    const stats = this.#chars?.byId.get(Char.STATISTICS);
    if (stats) {
      stats.removeEventListener('characteristicvaluechanged', this.#onStatistics);
      try {
        await stats.stopNotifications();
      } catch {
        // As above.
      }
    }
  }

  #onStatistics = (event: Event): void => {
    const value = (event.target as { value?: DataView } | null)?.value;
    if (!value) return;
    this.#log('debug', `Statistics payload (${value.byteLength} bytes)`);
  };

  #onPushEvent = (event: Event): void => {
    const value = (event.target as { value?: DataView } | null)?.value;
    if (!value) return;
    const id = decodePushEvent(value);
    if (id === null || !this.#debouncer.shouldHandle(id)) return;

    this.#emit({ type: 'push', at: this.#now(), id });
    this.#log('debug', PUSH_EVENT_LABEL[id]);

    // The charger transition is known from the event itself, so patch it immediately
    // rather than waiting for the re-read.
    if (id === PushEventId.CHARGER_CONNECTED || id === PushEventId.CHARGER_DISCONNECTED) {
      const battery = this.#state.attrs.battery;
      this.#dispatch({
        type: 'attrs',
        at: this.#now(),
        attrs: {
          battery: {
            percent: battery?.percent ?? 0,
            onChargingBase: id === PushEventId.CHARGER_CONNECTED,
          },
        },
      });
    }

    if (id === PushEventId.AUTH_INFO_NOT_FOUND) {
      // A write has already been read back intact, so the device evidently does accept
      // them; the event alone is not worth telling the user the mug is read-only.
      if (this.#state.writability === 'yes') {
        this.#log('debug', 'Auth-info event ignored: writes are confirmed to work');
        return;
      }
      this.#dispatch({ type: 'auth-info-missing' });
      this.#dispatch({ type: 'failure', failure: { kind: 'not-writable', hint: 'setup-in-ember-app' } });
      this.#log('warn', 'Device reports no auth info; writes will be ignored');
      return;
    }

    for (const attr of PUSH_EVENT_ATTRIBUTES[id]) {
      if (this.#state.capabilities.has(attr)) this.#dirty.add(attr);
    }
    this.#scheduleCoalescedDrain();
  };

  /** Bursts of events become one round-trip rather than nine. */
  #scheduleCoalescedDrain(): void {
    if (this.#coalesceTimer !== null || this.#dirty.size === 0) return;
    this.#coalesceTimer = setTimeout(() => {
      this.#coalesceTimer = null;
      void this.#drainDirty();
    }, PUSH_COALESCE_MS);
  }

  async #drainDirty(): Promise<void> {
    if (this.#state.connection.status !== 'connected' || this.#dirty.size === 0) return;
    const attrs = [...this.#dirty];
    this.#dirty.clear();
    try {
      await this.#readAttributes(attrs);
    } catch (error) {
      this.#noteReadFailure(error, 'drain');
    }
  }

  // --- polling ------------------------------------------------------------

  #capableAttrs(attrs: readonly Attribute[]): Attribute[] {
    return attrs.filter((a) => this.#state.capabilities.has(a));
  }

  #isIdle(): boolean {
    const { liquidState, battery } = this.#state.attrs;
    const quiet = liquidState === LiquidState.STANDBY || liquidState === LiquidState.EMPTY;
    return quiet && (battery?.onChargingBase ?? false);
  }

  #scheduleTick(): void {
    if (this.#destroyed) return;
    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = null;
      void this.#tick();
    }, this.#isIdle() ? IDLE_POLL_MS : HOT_POLL_MS);
  }

  async #tick(): Promise<void> {
    if (this.#state.connection.status !== 'connected') return;
    this.#ticks += 1;

    const dirty = [...this.#dirty];
    this.#dirty.clear();
    const full = this.#ticks % FULL_POLL_EVERY_N_TICKS === 0;
    const wanted = full ? POLL_ATTRS : HOT_ATTRS;
    const attrs = this.#capableAttrs([...new Set([...dirty, ...wanted])]);

    try {
      const read = await this.#readAttributes(attrs);
      if (full) this.#remember();
      this.#deadPolls = attrs.length > 0 && read === 0 ? this.#deadPolls + 1 : 0;
      if (this.#deadPolls >= DEAD_POLLS_BEFORE_RESET) {
        // The link claims to be up but nothing comes back: reset it rather than show
        // frozen numbers as if they were live.
        this.#deadPolls = 0;
        this.#log('warn', 'Polls keep failing; resetting the link');
        this.#onQueueFatal({ kind: 'timeout', op: 'poll', ms: 0 });
        return;
      }
    } catch (error) {
      this.#noteReadFailure(error, 'poll');
    } finally {
      // Self-rescheduling rather than setInterval, so a slow sweep cannot stack ticks.
      if (this.#state.connection.status === 'connected') this.#scheduleTick();
    }
  }

  #noteReadFailure(error: unknown, op: string): void {
    const failure = error instanceof EmberError ? error.failure : classify(error, op);
    if (failure.kind === 'disconnected') return;
    this.#log('warn', `Read failed during ${op}`, failure);
    this.#dispatch({ type: 'failure', failure });
  }

  /** Forces a full read of everything this device supports. */
  async refresh(): Promise<void> {
    await this.#readAttributes(this.#capableAttrs(POLL_ATTRS));
  }

  // --- reads / writes -----------------------------------------------------

  #characteristic(id: CharId) {
    const characteristic = this.#chars?.byId.get(id);
    if (!characteristic) {
      const attribute = attributeForChar(id);
      throw new EmberError(
        attribute
          ? { kind: 'unsupported-attribute', attribute }
          : { kind: 'gatt', op: 'lookup', characteristic: id, cause: null, transient: false },
      );
    }
    return characteristic;
  }

  async #read(id: CharId, priority = 0): Promise<DataView> {
    const characteristic = this.#characteristic(id);
    return this.#queue.run(`read:${id}`, () => characteristic.readValue(), {
      priority,
      characteristic: id,
    });
  }

  async #write(id: CharId, data: BufferSource): Promise<void> {
    const characteristic = this.#characteristic(id);
    await this.#queue.run(`write:${id}`, () => writeCharacteristic(characteristic, data), {
      priority: WRITE_PRIORITY,
      retries: 1,
      characteristic: id,
    });
  }

  /**
   * Reads attributes one at a time, tolerating individual failures the way the reference
   * implementation does - a single unreadable characteristic must not abort the sweep.
   */
  async #readAttributes(attrs: readonly Attribute[]): Promise<number> {
    if (attrs.length === 0) return 0;
    const updates: Partial<EmberAttributes> = {};
    const failed: Attribute[] = [];
    const epochs = new Map(attrs.map((attr) => [attr, this.#epochs.get(attr) ?? 0]));

    for (const attr of attrs) {
      const reader = READERS[attr];
      try {
        const value = reader.decode(await this.#read(reader.char));
        (updates as Record<string, unknown>)[attr] = value;
      } catch (error) {
        const failure = error instanceof EmberError ? error.failure : classify(error, `read:${attr}`);
        if (failure.kind === 'disconnected') throw error;
        failed.push(attr);
      }
    }

    const read = Object.keys(updates).length;

    // A sweep is many round-trips long and a write can land in the middle of it. A value
    // read before the user changed that attribute is history, not news: applying it
    // would flash the old value back on screen.
    for (const attr of Object.keys(updates) as Attribute[]) {
      if (this.#intents.has(attr) || (this.#epochs.get(attr) ?? 0) !== epochs.get(attr)) {
        delete (updates as Record<string, unknown>)[attr];
      }
    }

    if (Object.keys(updates).length > 0) {
      this.#dispatch({ type: 'attrs', attrs: updates, at: this.#now() });
    }
    if (failed.length > 0) {
      this.#log('debug', `Could not read: ${failed.join(', ')}`);
    }
    return read;
  }

  /**
   * Records what the user asked for, shows it immediately, and writes it in the background.
   *
   * Every write is read back: a device that was never set up in the Ember app
   * acknowledges the write at the GATT layer and silently discards it, so read-back is
   * the only reliable detection. The promise settles once the device holds the value
   * (or a newer intent replaced it), so callers can await it but never have to.
   */
  async #writeAttr<T>(
    attr: Attribute,
    id: CharId,
    value: T,
    encode: (value: T) => BufferSource,
    decode: (dv: DataView) => T,
    equals: (a: T, b: T) => boolean = Object.is,
  ): Promise<WriteResult> {
    if (!this.#state.capabilities.has(attr)) {
      throw new EmberError({ kind: 'unsupported-attribute', attribute: attr });
    }
    if (this.#intentionalDisconnect || this.#destroyed) {
      throw new EmberError({ kind: 'disconnected', unexpected: false });
    }

    // Validation happens before anything touches the radio.
    const data = encode(value);
    const existing = this.#intents.get(attr);

    const result = new Promise<WriteResult>((resolve, reject) => {
      this.#intents.set(attr, {
        value,
        data,
        char: id,
        decode: decode as (dv: DataView) => unknown,
        equals: equals as (a: unknown, b: unknown) => boolean,
        base: existing ? existing.base : this.#state.attrs[attr as keyof EmberAttributes],
        // Superseded callers settle with the newest intent: it is what they now mean.
        waiters: [...(existing?.waiters ?? []), { resolve, reject }],
        timeouts: 0,
      });
    });

    this.#epochs.set(attr, (this.#epochs.get(attr) ?? 0) + 1);
    this.#dispatch({ type: 'optimistic', attr, value });
    void this.#flush(attr);
    return result;
  }

  #flushAllIntents(): void {
    for (const attr of this.#intents.keys()) void this.#flush(attr);
  }

  /** One writer per attribute; it loops until the newest intent is on the device. */
  async #flush(attr: Attribute): Promise<void> {
    if (this.#flushing.has(attr)) return;
    this.#flushing.add(attr);
    try {
      for (;;) {
        const intent = this.#intents.get(attr);
        if (!intent || this.#state.connection.status !== 'connected') return;
        const current = (): boolean => this.#intents.get(attr) === intent;

        try {
          await this.#write(intent.char, intent.data);
          if (!current()) continue;

          let actual = intent.decode(await this.#read(intent.char, WRITE_PRIORITY));
          if (!current()) continue;
          let confirmed = intent.equals(actual, intent.value);
          if (!confirmed) {
            // Look once more before calling the device read-only; a single odd read
            // must not put a warning in front of the user.
            actual = intent.decode(await this.#read(intent.char, WRITE_PRIORITY));
            if (!current()) continue;
            confirmed = intent.equals(actual, intent.value);
          }

          this.#intents.delete(attr);
          this.#dispatch({ type: 'settle', attr, value: actual, at: this.#now() });
          this.#dispatch({ type: 'writability', value: confirmed ? 'yes' : 'no' });
          if (!confirmed) {
            this.#dispatch({
              type: 'failure',
              failure: { kind: 'not-writable', hint: 'setup-in-ember-app' },
            });
            this.#log('warn', `Write to ${attr} was accepted but did not take effect`);
          }
          this.#emit({ type: 'write', at: this.#now(), attribute: attr, confirmed });
          for (const waiter of intent.waiters) waiter.resolve({ confirmed });
        } catch (error) {
          if (!current()) continue;
          const failure = error instanceof EmberError ? error.failure : classify(error, `write:${attr}`);

          if (failure.kind === 'disconnected' || this.#state.connection.status !== 'connected') {
            // Kept, and written again as soon as the link is back.
            this.#log('info', `Write to ${attr} will be retried after reconnecting`);
            return;
          }
          if (failure.kind === 'timeout' && intent.timeouts < WRITE_TIMEOUT_RETRIES) {
            intent.timeouts += 1;
            continue;
          }

          this.#intents.delete(attr);
          this.#dispatch({ type: 'revert', attr, value: intent.base });
          this.#dispatch({ type: 'failure', failure });
          this.#log('warn', `Write to ${attr} failed`, failure);
          const rejection = error instanceof EmberError ? error : new EmberError(failure);
          for (const waiter of intent.waiters) waiter.reject(rejection);
        }
      }
    } finally {
      this.#flushing.delete(attr);
    }
  }

  /** The user let go of the device: unwritten intents are dropped and undone. */
  #abandonIntents(failure: EmberFailure): void {
    if (this.#intents.size === 0) return;
    const intents = [...this.#intents];
    this.#intents.clear();
    for (const [attr, intent] of intents) {
      this.#dispatch({ type: 'revert', attr, value: intent.base });
      const error = new EmberError(failure);
      for (const waiter of intent.waiters) waiter.reject(error);
    }
  }

  // --- public actions -----------------------------------------------------

  async setTargetTemp(celsius: number): Promise<WriteResult> {
    validateTargetTemp(celsius);
    if (celsius !== TEMP_OFF) this.#savePrefs({ lastTargetC: celsius });
    return this.#writeAttr(
      'targetTemp',
      Char.TARGET_TEMPERATURE,
      celsius,
      encodeTemperature,
      decodeTemperature,
      // The value round-trips through a uint16 of hundredths, so exact equality is wrong.
      (a, b) => Math.abs(a - b) < 0.02,
    );
  }

  /**
   * Writing 0 turns temperature control off and loses the target, so the last non-zero
   * value is remembered and restored when it is switched back on.
   */
  async setTemperatureControl(on: boolean): Promise<WriteResult> {
    if (!on) {
      const current = this.#state.attrs.targetTemp;
      if (current && current > 0) this.#savePrefs({ lastTargetC: current });
      return this.setTargetTemp(TEMP_OFF);
    }
    return this.setTargetTemp(this.#prefs.lastTargetC ?? DEFAULT_TARGET_C);
  }

  async setName(name: string): Promise<WriteResult> {
    return this.#writeAttr('name', Char.MUG_NAME, name, encodeName, decodeName);
  }

  async setTemperatureUnit(unit: TemperatureUnit): Promise<WriteResult> {
    return this.#writeAttr(
      'temperatureUnit',
      Char.TEMPERATURE_UNIT,
      unit,
      encodeTemperatureUnit,
      decodeTemperatureUnit,
    );
  }

  async setVolumeLevel(level: VolumeLevel): Promise<WriteResult> {
    return this.#writeAttr(
      'volumeLevel',
      Char.VOLUME,
      level,
      encodeVolumeLevel,
      (dv) => decodeVolumeLevel(dv) as VolumeLevel,
    );
  }

  async setLedColour(colour: Colour): Promise<WriteResult> {
    return this.#writeAttr('ledColour', Char.LED, colour, encodeColour, decodeColour, (a, b) =>
      a.red === b.red && a.green === b.green && a.blue === b.blue && a.brightness === b.brightness,
    );
  }

  setModelOverride(model: DeviceModel | null): void {
    this.#savePrefs({ modelOverride: model });
    this.#identify();
  }

  #savePrefs(patch: Partial<DevicePrefs>): void {
    this.#prefs = { ...this.#prefs, ...patch };
    saveDevicePrefs(this.#store, this.#prefsKey, this.#prefs);
  }

  /**
   * Determines whether writes take effect, without changing anything: rewrites the
   * current target temperature to itself and checks the read-back.
   */
  async #probeWritability(force = false): Promise<void> {
    const current = this.#state.attrs.targetTemp;
    if (current === undefined || !this.#state.capabilities.has('targetTemp')) return;
    if (!force && (this.#state.authInfoMissing || this.#state.writability !== 'unknown')) return;
    // A real write from the user answers the question better, and racing it would put
    // the old value back on the device.
    if (this.#intents.has('targetTemp')) return;
    const epoch = this.#epochs.get('targetTemp') ?? 0;
    const untouched = (): boolean =>
      !this.#intents.has('targetTemp') && (this.#epochs.get('targetTemp') ?? 0) === epoch;

    try {
      await this.#write(Char.TARGET_TEMPERATURE, encodeTemperature(current));
      if (!untouched()) return;
      const readBack = decodeTemperature(await this.#read(Char.TARGET_TEMPERATURE));
      if (!untouched()) return;
      this.#dispatch({
        type: 'writability',
        value: Math.abs(readBack - current) < 0.02 ? 'yes' : 'no',
      });
    } catch (error) {
      // A dropped link says nothing about whether the mug accepts writes.
      this.#log('debug', 'Writability probe did not finish', classify(error, 'probe'));
    }
  }

  /**
   * Port of the reference implementation's `make_writable()`: overwrites UDSK with random
   * bytes to force the device to accept writes.
   *
   * UDSK is the key the official Ember app uses, so this very likely unpairs the phone
   * app. It must only ever run behind an explicit confirmation.
   */
  async forceWritable(): Promise<boolean> {
    try {
      const random = crypto.getRandomValues(new Uint8Array(14));
      const hex = Array.from(random, (b) => b.toString(16).padStart(2, '0')).join('');
      await this.#write(Char.UDSK, encodeUdsk(hex));
      const udsk = decodeUdsk(await this.#read(Char.UDSK, WRITE_PRIORITY));
      this.#dispatch({ type: 'attrs', attrs: { udsk }, at: this.#now() });
      await this.#probeWritability(true);
      this.#log('warn', 'Overwrote the device pairing key to force writability');
      return this.#state.writability === 'yes';
    } catch (error) {
      this.#log('error', 'Could not force writability', classify(error, 'forceWritable'));
      return false;
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, op: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new EmberError({ kind: 'timeout', op, ms })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}
