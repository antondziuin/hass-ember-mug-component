/**
 * Owns everything stateful: the connected device, the active history store, and the
 * recorder that joins them.
 *
 * Kept out of React so the wiring is testable and so a re-render never restarts a
 * Bluetooth session.
 */

import {
  EmberDevice,
  canSilentlyReconnect,
  getPermittedDevices,
  hasBluetoothAdapter,
  loadRememberedDevice,
  browserStore,
  unsupportedReason,
  type BluetoothDeviceLike,
  type EmberDeviceState,
  type EmberFailure,
  type KeyValueStore,
  type RememberedDevice,
} from '../lib/ember/index.js';
import { initialState } from '../lib/ember/reducer.js';
import { GATE_PRESETS, type SampleGateConfig } from '../history/gate.js';
import { HistoryRecorder, type RecorderStatus } from '../history/recorder.js';
import type { HistoryStore } from '../history/HistoryStore.js';
import { createStore, loadStoreConfig, saveStoreConfig, type StoreConfig } from '../history/activeStore.js';

export type GatePreset = keyof typeof GATE_PRESETS;

export interface AppState {
  /** Null until a device has been chosen in this page load. */
  device: EmberDevice | null;
  deviceState: EmberDeviceState;
  remembered: RememberedDevice | null;
  /** True when the browser can re-acquire a permitted device without the chooser. */
  canRestore: boolean;
  adapterAvailable: boolean;
  unsupported: Extract<EmberFailure, { kind: 'unsupported' }> | null;
  storeConfig: StoreConfig;
  /** The live store instance, so views can query without a second subscription. */
  historyStore: HistoryStore | null;
  storeReady: boolean;
  storeError: string | null;
  recorder: RecorderStatus | null;
  gatePreset: GatePreset;
  busy: boolean;
  notice: string | null;
}

const GATE_PRESET_KEY = 'ember.gatePreset';

export class AppController {
  #listeners = new Set<() => void>();
  #state: AppState;
  #device: EmberDevice | null = null;
  #recorder: HistoryRecorder | null = null;
  #store: HistoryStore | null = null;
  #unsubscribeDevice: (() => void) | null = null;
  #unsubscribeRecorder: (() => void) | null = null;
  readonly #kv: KeyValueStore;
  #initPromise: Promise<void> | null = null;

  constructor(kv: KeyValueStore = browserStore()) {
    this.#kv = kv;
    this.#state = {
      device: null,
      deviceState: initialState({ status: 'idle' }),
      remembered: null,
      canRestore: false,
      adapterAvailable: true,
      unsupported: null,
      storeConfig: loadStoreConfig(kv),
      historyStore: null,
      storeReady: false,
      storeError: null,
      recorder: null,
      gatePreset: (kv.get(GATE_PRESET_KEY) as GatePreset | null) ?? 'balanced',
      busy: false,
      notice: null,
    };
  }

  getSnapshot = (): AppState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #set(patch: Partial<AppState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }

  get historyStore(): HistoryStore | null {
    return this.#store;
  }

  get gateConfig(): SampleGateConfig {
    return GATE_PRESETS[this.#state.gatePreset] ?? GATE_PRESETS.balanced!;
  }

  // --- boot ---------------------------------------------------------------

  /**
   * Idempotent: React's StrictMode runs effects twice in development, and two concurrent
   * inits would open the history store twice and race each other.
   */
  async init(): Promise<void> {
    this.#initPromise ??= this.#init();
    return this.#initPromise;
  }

  async #init(): Promise<void> {
    const failure = unsupportedReason();
    const unsupported = failure?.kind === 'unsupported' ? failure : null;
    const remembered = loadRememberedDevice(this.#kv);
    this.#set({
      unsupported,
      remembered,
      canRestore: canSilentlyReconnect(),
      deviceState: remembered
        ? initialState({ status: 'needs-gesture', remembered })
        : initialState({ status: 'idle' }),
    });

    if (!unsupported) {
      this.#set({ adapterAvailable: await hasBluetoothAdapter() });
    }

    await this.#openStore(this.#state.storeConfig);

    // With the persistent-permissions flag enabled the chooser can be skipped entirely.
    if (remembered && canSilentlyReconnect()) {
      const permitted = await getPermittedDevices();
      const match = permitted.find((d) => d.id === remembered.bleId);
      if (match) {
        await this.#adoptDevice(match as unknown as BluetoothDeviceLike, { autoConnect: true });
      }
    }
  }

  // --- history store ------------------------------------------------------

  async #openStore(config: StoreConfig): Promise<void> {
    try {
      const store = await createStore(config);
      await store.open();
      const probe = await store.probe();
      if (!probe.ok) {
        this.#set({
          storeReady: false,
          storeError: probe.error?.message ?? 'Store unavailable',
          // A store that failed its probe is still usable for local reads when it is the
          // local one, so it is kept rather than dropped.
          historyStore: store.kind === 'indexeddb' ? store : this.#store,
        });
        return;
      }
      const previous = this.#store;
      this.#store = store;
      if (this.#recorder) await this.#recorder.setStore(store);
      if (previous && previous !== store) await previous.close();
      this.#set({ storeReady: true, storeError: null, storeConfig: config, historyStore: store });
    } catch (error) {
      this.#set({
        storeReady: false,
        storeError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async setStoreConfig(config: StoreConfig): Promise<void> {
    saveStoreConfig(this.#kv, config);
    this.#set({ storeConfig: config, busy: true });
    await this.#openStore(config);
    this.#set({ busy: false });
  }

  setGatePreset(preset: GatePreset): void {
    this.#kv.set(GATE_PRESET_KEY, preset);
    this.#set({ gatePreset: preset, notice: 'Recording detail applies from the next connection.' });
  }

  // --- device -------------------------------------------------------------

  /** Opens the chooser. Must be called straight from a user gesture. */
  async connect(options: { acceptAll?: boolean } = {}): Promise<void> {
    this.#set({ busy: true, notice: null });
    try {
      const device = await EmberDevice.pick({
        acceptAll: options.acceptAll ?? false,
        store: this.#kv,
      });
      await this.#adoptDevice(device.bluetoothDevice, { autoConnect: true, existing: device });
    } catch (error) {
      const failure = (error as { failure?: { kind?: string } }).failure;
      // A user closing the chooser is not an error worth shouting about.
      if (failure?.kind !== 'cancelled') {
        this.#set({ notice: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      this.#set({ busy: false });
    }
  }

  async #adoptDevice(
    bluetoothDevice: BluetoothDeviceLike,
    options: { autoConnect: boolean; existing?: EmberDevice },
  ): Promise<void> {
    await this.disconnect({ keepRemembered: true });

    const device =
      options.existing ?? new EmberDevice(bluetoothDevice, { store: this.#kv });
    this.#device = device;
    this.#unsubscribeDevice = device.subscribe(() => {
      this.#set({ deviceState: device.getSnapshot() });
    });
    this.#set({ device, deviceState: device.getSnapshot() });

    if (this.#store) {
      const recorder = new HistoryRecorder(device, this.#store, { gate: this.gateConfig });
      this.#recorder = recorder;
      this.#unsubscribeRecorder = recorder.subscribeStatus(() => {
        this.#set({ recorder: recorder.getStatus() });
      });
      await recorder.start();
      this.#set({ recorder: recorder.getStatus() });
    }

    if (options.autoConnect) {
      try {
        await device.connect();
      } catch (error) {
        this.#set({ notice: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  async disconnect(options: { keepRemembered?: boolean } = {}): Promise<void> {
    this.#unsubscribeDevice?.();
    this.#unsubscribeRecorder?.();
    this.#unsubscribeDevice = null;
    this.#unsubscribeRecorder = null;

    if (this.#recorder) {
      await this.#recorder.stop();
      this.#recorder = null;
    }
    if (this.#device) {
      await this.#device.disconnect().catch(() => undefined);
      this.#device.destroy();
      this.#device = null;
    }

    const remembered = options.keepRemembered ? this.#state.remembered : null;
    this.#set({
      device: null,
      recorder: null,
      remembered,
      deviceState: remembered
        ? initialState({ status: 'needs-gesture', remembered })
        : initialState({ status: 'idle' }),
    });
  }

  async flushHistory(): Promise<void> {
    await this.#recorder?.flush();
  }

  dismissNotice(): void {
    this.#set({ notice: null });
  }
}
