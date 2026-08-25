/**
 * Wires the device layer to whichever history store is active.
 *
 * Also owns the honest bits: it records connection sessions so charts can show real gaps
 * instead of interpolating across a disconnect, notes when the page was hidden (Chrome
 * throttles background tabs to about one tick a minute), and elects a single writer when
 * several tabs are open.
 */

import { LiquidState, liquidLevelPercent, colourToHex } from '../lib/ember/index.js';
import type { DeviceSignal, EmberDevice } from '../lib/ember/emberDevice.js';
import type { EmberDeviceState } from '../lib/ember/types.js';

import { APP_VERSION } from './constants.js';
import { DEFAULT_GATE, SampleGate, type DeviceSnapshot, type SampleGateConfig } from './gate.js';
import { deriveDeviceId, type HistoryStore } from './HistoryStore.js';
import type {
  DeviceEvent,
  DeviceId,
  DeviceRecord,
  EventType,
  LiquidStateCode,
  Millis,
  SessionEndReason,
  SessionId,
  StoredDeviceType,
} from './types.js';
import { WriteBuffer, type WriteBufferOptions } from './writeBuffer.js';

export interface RecorderOptions {
  gate?: SampleGateConfig;
  buffer?: WriteBufferOptions;
  now?: () => number;
  /** Skips leader election; used in tests and when multi-tab handling is not wanted. */
  singleTab?: boolean;
  onError?: (error: unknown) => void;
}

export interface RecorderStatus {
  deviceId: DeviceId | null;
  sessionId: SessionId | null;
  isLeader: boolean;
  recording: boolean;
  pending: number;
  samplesWritten: number;
  lastWriteAt: Millis | null;
  lastError: string | null;
}

const WRITER_LOCK = 'ember-mug-writer';

/** Maps the device layer's snapshot onto what the gate expects, in human units. */
export function toDeviceSnapshot(state: EmberDeviceState, liquidLevelMax: 30 | 100): DeviceSnapshot {
  const { attrs } = state;
  return {
    currentTempC: attrs.currentTemp ?? null,
    targetTempC: attrs.targetTemp ?? null,
    batteryPercent: attrs.battery?.percent ?? null,
    onChargingBase: attrs.battery?.onChargingBase ?? false,
    batteryVoltage: attrs.batteryVoltage ?? null,
    liquidPercent:
      attrs.liquidLevel === undefined
        ? null
        : liquidLevelPercent(attrs.liquidLevel, liquidLevelMax),
    liquidState: (attrs.liquidState ?? null) as LiquidStateCode | null,
    deviceUnitIsFahrenheit: attrs.temperatureUnit === 'F',
    ledHex: attrs.ledColour ? colourToHex(attrs.ledColour) : null,
    volumeLevel: attrs.volumeLevel ?? null,
    name: attrs.name ?? null,
    firmwareVersion: attrs.firmware?.version ?? null,
  };
}

export function toDeviceRecord(
  state: EmberDeviceState,
  deviceId: DeviceId,
  liquidLevelMax: 30 | 100,
  now: Millis,
  existing: DeviceRecord | null,
): DeviceRecord {
  const firmware = state.attrs.firmware;
  return {
    deviceId,
    serialNumber: state.attrs.meta?.serialNumber ?? existing?.serialNumber ?? null,
    name: state.attrs.name ?? existing?.name ?? null,
    model: state.detection?.model ?? existing?.model ?? null,
    deviceType: (state.detection?.deviceType ?? 'unknown') as StoredDeviceType,
    capacityMl: existing?.capacityMl ?? null,
    colour: state.detection?.colour ?? existing?.colour ?? null,
    fwVersion: firmware ? String(firmware.version) : (existing?.fwVersion ?? null),
    fwHardware: firmware ? String(firmware.hardware) : (existing?.fwHardware ?? null),
    fwBootloader:
      firmware?.bootloader != null ? String(firmware.bootloader) : (existing?.fwBootloader ?? null),
    liquidLevelMax,
    firstSeenMs: existing?.firstSeenMs ?? now,
    lastSeenMs: now,
    bleHint: state.bleId ?? existing?.bleHint ?? null,
    meta: existing?.meta ?? null,
  };
}

export class HistoryRecorder {
  readonly #device: EmberDevice;
  #store: HistoryStore;
  #buffer: WriteBuffer;
  #gate: SampleGate | null = null;

  readonly #now: () => number;
  readonly #gateConfig: SampleGateConfig;
  readonly #singleTab: boolean;
  readonly #onError: (error: unknown) => void;

  #deviceId: DeviceId | null = null;
  #sessionId: SessionId | null = null;
  #sessionSamples = 0;
  #samplesWritten = 0;
  #lastWriteAt: Millis | null = null;
  #lastError: string | null = null;
  #isLeader: boolean;
  #started = false;

  #unsubscribeState: (() => void) | null = null;
  #unsubscribeSignals: (() => void) | null = null;
  #lockRelease: (() => void) | null = null;
  #statusListeners = new Set<() => void>();
  #status: RecorderStatus;

  constructor(device: EmberDevice, store: HistoryStore, options: RecorderOptions = {}) {
    this.#device = device;
    this.#store = store;
    this.#now = options.now ?? Date.now;
    this.#gateConfig = options.gate ?? DEFAULT_GATE;
    this.#singleTab = options.singleTab ?? false;
    this.#onError = options.onError ?? (() => undefined);
    this.#isLeader = this.#singleTab;

    this.#buffer = new WriteBuffer(store, {
      ...options.buffer,
      onError: (error) => {
        this.#lastError = error instanceof Error ? error.message : String(error);
        this.#onError(error);
        this.#publish();
      },
      onFlush: ({ samples }) => {
        this.#samplesWritten += samples;
        this.#lastWriteAt = this.#now();
        this.#lastError = null;
        this.#publish();
      },
    });

    this.#status = this.#snapshotStatus();
  }

  // --- status -------------------------------------------------------------

  getStatus = (): RecorderStatus => this.#status;

  subscribeStatus = (listener: () => void): (() => void) => {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  };

  #snapshotStatus(): RecorderStatus {
    return {
      deviceId: this.#deviceId,
      sessionId: this.#sessionId,
      isLeader: this.#isLeader,
      recording: this.#started && this.#isLeader && this.#sessionId !== null,
      pending: this.#buffer.pending,
      samplesWritten: this.#samplesWritten,
      lastWriteAt: this.#lastWriteAt,
      lastError: this.#lastError,
    };
  }

  #publish(): void {
    this.#status = this.#snapshotStatus();
    for (const listener of this.#statusListeners) listener();
  }

  get store(): HistoryStore {
    return this.#store;
  }

  /** Swaps the destination store, draining anything buffered into the old one first. */
  async setStore(store: HistoryStore): Promise<void> {
    await this.#buffer.setStore(store);
    this.#store = store;
  }

  // --- lifecycle ----------------------------------------------------------

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;

    if (!this.#singleTab) await this.#acquireLeadership();

    this.#unsubscribeState = this.#device.subscribe(() => this.#onStateChange());
    this.#unsubscribeSignals = this.#device.subscribeSignals((signal) => {
      void this.#onSignal(signal);
    });

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.#onVisibilityChange);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', this.#onPageHide);
      window.addEventListener('freeze', this.#onPageHide);
    }

    // If the device is already connected, open a session for it now.
    if (this.#device.getSnapshot().connection.status === 'connected') {
      await this.#openSession();
    }
    this.#publish();
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;

    this.#unsubscribeState?.();
    this.#unsubscribeSignals?.();
    this.#unsubscribeState = null;
    this.#unsubscribeSignals = null;

    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.#onVisibilityChange);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.#onPageHide);
      window.removeEventListener('freeze', this.#onPageHide);
    }

    await this.#closeSession('user_disconnect');
    this.#buffer.dispose();
    this.#lockRelease?.();
    this.#lockRelease = null;
    this.#publish();
  }

  /**
   * Holds an exclusive Web Lock for the tab's lifetime. Other tabs stay read-only rather
   * than racing to write the same samples.
   */
  async #acquireLeadership(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.locks) {
      this.#isLeader = true;
      return;
    }
    await new Promise<void>((resolveAcquired) => {
      let settled = false;
      void navigator.locks
        .request(WRITER_LOCK, { mode: 'exclusive' }, () => {
          this.#isLeader = true;
          this.#publish();
          if (!settled) {
            settled = true;
            resolveAcquired();
          }
          // Held until the tab closes or `stop()` releases it.
          return new Promise<void>((releaseLock) => {
            this.#lockRelease = releaseLock;
          });
        })
        .catch(() => {
          this.#isLeader = true;
          if (!settled) {
            settled = true;
            resolveAcquired();
          }
        });

      // Another tab already holds it: carry on read-only rather than blocking start().
      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolveAcquired();
        }
      }, 250);
    });
  }

  // --- sessions -----------------------------------------------------------

  async #openSession(): Promise<void> {
    if (!this.#isLeader || this.#sessionId !== null) return;

    const state = this.#device.getSnapshot();
    const serial = state.attrs.meta?.serialNumber ?? null;
    const deviceId = await this.#resolveDeviceId(serial, state.bleId);
    this.#deviceId = deviceId;

    const now = this.#now();
    const existing = await this.#store.getDevice(deviceId);
    await this.#store.upsertDevice(
      toDeviceRecord(state, deviceId, this.#device.liquidLevelMax, now, existing),
    );

    const sessionId = crypto.randomUUID();
    this.#sessionId = sessionId;
    this.#sessionSamples = 0;
    await this.#store.startSession({
      sessionId,
      deviceId,
      startedMs: now,
      endedMs: null,
      endReason: null,
      sampleCount: 0,
      appVersion: APP_VERSION,
    });

    this.#gate = new SampleGate(deviceId, this.#gateConfig);
    this.#gate.reset(sessionId, deviceId);
    this.#emitEvent('session_start', now);

    // Ask for durable storage now rather than on first paint: Chrome grants it based on
    // engagement, and a successful connection is the strongest engagement signal we have.
    void requestPersistence();

    this.#publish();
    this.#onStateChange();
  }

  /**
   * Reuses an existing row when the Bluetooth id matches a device recorded without a
   * readable serial, so history is not split across two ids for the same mug.
   */
  async #resolveDeviceId(serial: string | null, bleId: string | null): Promise<DeviceId> {
    if (serial) return deriveDeviceId(serial);
    if (bleId) {
      const known = (await this.#store.listDevices()).find((d) => d.bleHint === bleId);
      if (known) return known.deviceId;
    }
    return deriveDeviceId(null);
  }

  async #closeSession(reason: SessionEndReason): Promise<void> {
    const sessionId = this.#sessionId;
    if (sessionId === null) return;

    const now = this.#now();
    if (this.#gate) {
      const flushed = this.#gate.flush(now, 'session_end');
      this.#buffer.add(flushed.samples, flushed.events);
      this.#sessionSamples += flushed.samples.length;
    }
    this.#emitEvent('session_end', now);
    await this.#buffer.flush('session-end');

    try {
      await this.#store.endSession(sessionId, now, reason, this.#sessionSamples);
    } catch (error) {
      this.#onError(error);
    }

    this.#sessionId = null;
    this.#gate = null;
    this.#publish();
  }

  #emitEvent(type: EventType, ts: Millis, textA: string | null = null): void {
    if (!this.#deviceId) return;
    const event: DeviceEvent = {
      eventId: crypto.randomUUID(),
      deviceId: this.#deviceId,
      ts,
      type,
      sessionId: this.#sessionId,
      numA: null,
      numB: null,
      textA,
      data: null,
    };
    this.#buffer.add([], [event]);
  }

  // --- device hooks -------------------------------------------------------

  #onStateChange(): void {
    if (!this.#isLeader || !this.#gate) return;
    const state = this.#device.getSnapshot();
    if (state.connection.status !== 'connected') return;
    // Nothing has been read yet; an all-null sample would just be noise.
    if (state.lastUpdate === null) return;

    const output = this.#gate.push(
      toDeviceSnapshot(state, this.#device.liquidLevelMax),
      this.#now(),
    );
    if (output.samples.length === 0 && output.events.length === 0) return;

    this.#sessionSamples += output.samples.length;
    this.#buffer.add(output.samples, output.events);
    this.#publish();
  }

  async #onSignal(signal: DeviceSignal): Promise<void> {
    switch (signal.type) {
      case 'connected':
        await this.#openSession();
        break;
      case 'disconnected':
        await this.#closeSession(signal.unexpected ? 'ble_disconnect' : 'user_disconnect');
        break;
      default:
        break;
    }
  }

  #onVisibilityChange = (): void => {
    const hidden = document.visibilityState === 'hidden';
    // Recorded because the sample rate genuinely drops while hidden; without the marker a
    // sparse patch in the chart looks like a fault.
    this.#emitEvent(hidden ? 'visibility_hidden' : 'visibility_visible', this.#now());
    if (hidden) {
      if (this.#gate) {
        const flushed = this.#gate.flush(this.#now(), 'visibility');
        this.#buffer.add(flushed.samples, flushed.events);
      }
      void this.#buffer.flush('visibility');
    } else {
      void this.#device.refresh().catch(() => undefined);
    }
  };

  #onPageHide = (): void => {
    void this.#buffer.flush('pagehide');
  };

  /** Forces everything buffered to disk right now. */
  async flush(): Promise<void> {
    await this.#buffer.flush('manual');
  }
}

/**
 * Asks the browser to stop treating this origin's storage as evictable.
 *
 * Without it, Chrome may discard the entire origin under storage pressure, with no
 * warning - which for a user in "no database" mode means losing all their history.
 */
export async function requestPersistence(): Promise<{
  persisted: boolean;
  usage?: StorageEstimate;
}> {
  if (typeof navigator === 'undefined' || !navigator.storage) return { persisted: false };
  try {
    const usage = await navigator.storage.estimate?.();
    let persisted = (await navigator.storage.persisted?.()) ?? false;
    if (!persisted) persisted = (await navigator.storage.persist?.()) ?? false;
    return usage ? { persisted, usage } : { persisted };
  } catch {
    return { persisted: false };
  }
}

export { LiquidState };
