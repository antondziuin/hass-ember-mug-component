/**
 * An in-memory Ember device.
 *
 * This ships in `src/` rather than a test folder because it also drives the offline demo
 * mode, so the whole UI can be exercised without hardware.
 *
 * It stores raw bytes per characteristic and lets the production codecs decode them, so
 * the fake exercises the real decode path rather than a parallel one. It also enforces
 * one GATT operation at a time, rejecting overlaps exactly as Chrome does - which is what
 * makes it a real test of the operation queue.
 */

import type {
  BluetoothDeviceLike,
  GattCharacteristicLike,
  GattServerLike,
  GattServiceLike,
} from '../bluetooth.js';
import { DeviceModel, LiquidState, PushEventId, TemperatureUnit } from '../constants.js';
import { MODELS } from '../models.js';
import { ATTRIBUTE_CHARS } from '../models.js';
import { CHAR_UUID, Char, SERVICE, type CharId } from '../uuids.js';
import type { Attribute } from '../types.js';

export interface FakeGattOptions {
  model?: DeviceModel;
  /** Simulated round-trip latency per GATT operation. */
  latencyMs?: number;
  /** Reproduces a device that was never set up in the Ember app: writes are discarded. */
  writesAreIgnored?: boolean;
  serial?: string;
  name?: string;
  id?: string;
  /** Injected so tests can drive time without real timers. */
  sleep?: (ms: number) => Promise<void>;
}

type FailureSpec = { op: 'read' | 'write'; name: string; message: string } | null;

const textEncoder = new TextEncoder();

function u16le(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function defaultValues(model: DeviceModel, serial: string): Map<CharId, Uint8Array> {
  const spec = MODELS[model];
  const values = new Map<CharId, Uint8Array>();

  values.set(Char.MUG_NAME, textEncoder.encode('Ember'));
  values.set(Char.CURRENT_TEMPERATURE, u16le(2350));
  values.set(Char.TARGET_TEMPERATURE, u16le(5700));
  values.set(Char.TEMPERATURE_UNIT, new Uint8Array([0]));
  values.set(Char.LIQUID_LEVEL, new Uint8Array([0]));
  values.set(Char.LIQUID_STATE, new Uint8Array([LiquidState.EMPTY]));
  values.set(Char.BATTERY, new Uint8Array([87, 0]));
  values.set(Char.VOLUME, new Uint8Array([1]));
  values.set(Char.CONTROL_REGISTER_DATA, new Uint8Array([1]));
  values.set(Char.LED, new Uint8Array([255, 255, 255, 255]));

  const dateTime = new Uint8Array(5);
  new DataView(dateTime.buffer).setUint32(0, Math.floor(1_700_000_000), false);
  values.set(Char.DATE_TIME_AND_ZONE, dateTime);

  const firmware = new Uint8Array(6);
  const fwView = new DataView(firmware.buffer);
  fwView.setUint16(0, 355, true);
  fwView.setUint16(2, 128, true);
  fwView.setUint16(4, 18, true);
  values.set(Char.FIRMWARE, firmware);

  const mugId = new Uint8Array([0x63, 0x77, 0x3d, 0x3d, 0x3d, 0x3d, 0x2d, ...textEncoder.encode(serial)]);
  values.set(Char.MUG_ID, mugId);
  values.set(Char.DSK, new Uint8Array(20).fill(7));
  values.set(Char.UDSK, new Uint8Array(20).fill(3));
  values.set(Char.PUSH_EVENT, new Uint8Array([0]));
  values.set(Char.STATISTICS, new Uint8Array([0]));

  // Drop characteristics the model does not have, so the capability probe is exercised.
  for (const [attr, chars] of Object.entries(ATTRIBUTE_CHARS) as Array<
    [Attribute, readonly CharId[]]
  >) {
    if (!spec.attributes.has(attr)) for (const c of chars) values.delete(c);
  }
  return values;
}

class SimpleEventTarget {
  readonly #listeners = new Map<string, Set<(event: Event) => void>>();

  addEventListener(type: string, listener: (event: Event) => void): void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: Event): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(event);
  }
}

class FakeCharacteristic extends SimpleEventTarget implements GattCharacteristicLike {
  value: DataView | undefined;
  notifying = false;

  constructor(
    readonly uuid: string,
    readonly id: CharId,
    private readonly device: FakeBluetoothDevice,
  ) {
    super();
  }

  async readValue(): Promise<DataView> {
    const dv = await this.device._read(this.id);
    this.value = dv;
    return dv;
  }

  async writeValue(data: BufferSource): Promise<void> {
    await this.device._write(this.id, data);
  }

  async writeValueWithResponse(data: BufferSource): Promise<void> {
    await this.device._write(this.id, data);
  }

  async startNotifications(): Promise<GattCharacteristicLike> {
    this.notifying = true;
    return this;
  }

  async stopNotifications(): Promise<GattCharacteristicLike> {
    this.notifying = false;
    return this;
  }

  /** Delivers a notification the way Chrome does: value on the target, then the event. */
  deliver(bytes: Uint8Array): void {
    if (!this.notifying) return;
    // Non-zero byteOffset on purpose, to catch code that reads `dv.buffer` directly.
    const padded = new Uint8Array(bytes.length + 3);
    padded.set(bytes, 3);
    this.value = new DataView(padded.buffer, 3, bytes.length);
    this.dispatch('characteristicvaluechanged', { target: this } as unknown as Event);
  }
}

class FakeService implements GattServiceLike {
  constructor(
    readonly uuid: string,
    private readonly chars: FakeCharacteristic[],
  ) {}

  async getCharacteristics(): Promise<GattCharacteristicLike[]> {
    return [...this.chars];
  }
}

class FakeGattServer implements GattServerLike {
  connected = false;
  connectCalls = 0;

  constructor(private readonly device: FakeBluetoothDevice) {}

  async connect(): Promise<GattServerLike> {
    this.connectCalls += 1;
    this.connected = true;
    return this;
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.device._notifyDisconnected();
  }

  async getPrimaryServices(): Promise<GattServiceLike[]> {
    if (!this.connected) throw named('NetworkError', 'GATT Server is disconnected.');
    return this.device._services();
  }
}

function named(name: string, message: string): DOMException {
  const error = new Error(message);
  error.name = name;
  return error as unknown as DOMException;
}

export class FakeBluetoothDevice extends SimpleEventTarget implements BluetoothDeviceLike {
  readonly id: string;
  readonly name: string;
  readonly gatt: FakeGattServer;

  readonly model: DeviceModel;
  readonly writeLog: Array<{ id: CharId; bytes: Uint8Array }> = [];

  #values: Map<CharId, Uint8Array>;
  #chars = new Map<CharId, FakeCharacteristic>();
  #serviceList: FakeService[] = [];
  #inFlight = 0;
  #maxInFlight = 0;
  #nextFailure: FailureSpec = null;
  #stalled = new Set<'read' | 'write'>();
  #latencyMs: number;
  #writesAreIgnored: boolean;
  #sleep: (ms: number) => Promise<void>;

  constructor(options: FakeGattOptions = {}) {
    super();
    this.model = options.model ?? DeviceModel.MUG_2_10_OZ;
    this.id = options.id ?? 'fake-device-1';
    this.name = options.name ?? nameFor(this.model);
    this.#latencyMs = options.latencyMs ?? 0;
    this.#writesAreIgnored = options.writesAreIgnored ?? false;
    this.#sleep =
      options.sleep ??
      ((ms) =>
        ms > 0
          ? new Promise<void>((resolve) => {
              setTimeout(resolve, ms);
            })
          : Promise.resolve());

    this.#values = defaultValues(this.model, options.serial ?? 'AB12CD34EF');
    this.gatt = new FakeGattServer(this);
    this.#buildServices();
  }

  /** Highest number of concurrent GATT operations observed. Must stay at 1. */
  get maxConcurrentOps(): number {
    return this.#maxInFlight;
  }

  #buildServices(): void {
    const standard: FakeCharacteristic[] = [];
    for (const id of this.#values.keys()) {
      const characteristic = new FakeCharacteristic(CHAR_UUID[id], id, this);
      this.#chars.set(id, characteristic);
      standard.push(characteristic);
    }
    // An unrecognised characteristic, so the diagnostics path is exercised.
    standard.push(
      new FakeCharacteristic('0000180a-0000-1000-8000-00805f9b34fb', Char.LAST_LOCATION, this),
    );

    const isTravelMug = this.model === DeviceModel.TRAVEL_MUG_12_OZ;
    this.#serviceList = [
      new FakeService(isTravelMug ? SERVICE.TRAVEL_MUG : SERVICE.STANDARD, standard),
    ];
  }

  _services(): GattServiceLike[] {
    return [...this.#serviceList];
  }

  _notifyDisconnected(): void {
    for (const characteristic of this.#chars.values()) characteristic.notifying = false;
    this.dispatch('gattserverdisconnected', { target: this } as unknown as Event);
  }

  async #guard<T>(op: 'read' | 'write', run: () => T): Promise<T> {
    if (!this.gatt.connected) throw named('NetworkError', 'GATT Server is disconnected.');

    this.#inFlight += 1;
    this.#maxInFlight = Math.max(this.#maxInFlight, this.#inFlight);
    try {
      if (this.#inFlight > 1) {
        throw named('NetworkError', 'GATT operation already in progress.');
      }
      if (this.#stalled.has(op)) {
        // Never settles: exercises the queue's orphan handling.
        await new Promise<never>(() => undefined);
      }
      if (this.#nextFailure?.op === op) {
        const failure = this.#nextFailure;
        this.#nextFailure = null;
        throw named(failure.name, failure.message);
      }
      await this.#sleep(this.#latencyMs);
      return run();
    } finally {
      this.#inFlight -= 1;
    }
  }

  async _read(id: CharId): Promise<DataView> {
    return this.#guard('read', () => {
      const bytes = this.#values.get(id);
      if (!bytes) throw named('NotSupportedError', 'GATT operation not permitted.');
      // Deliberately offset inside a larger buffer, matching real Chrome behaviour.
      const padded = new Uint8Array(bytes.length + 5);
      padded.set(bytes, 5);
      return new DataView(padded.buffer, 5, bytes.length);
    });
  }

  async _write(id: CharId, data: BufferSource): Promise<void> {
    await this.#guard('write', () => {
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data.slice(0))
          : new Uint8Array(
              (data as ArrayBufferView).buffer.slice(
                (data as ArrayBufferView).byteOffset,
                (data as ArrayBufferView).byteOffset + (data as ArrayBufferView).byteLength,
              ),
            );
      this.writeLog.push({ id, bytes });
      if (!this.#writesAreIgnored) this.#values.set(id, bytes);
    });
  }

  // --- test controls ------------------------------------------------------

  setValue(id: CharId, bytes: Uint8Array): void {
    this.#values.set(id, bytes);
  }

  getValue(id: CharId): Uint8Array | undefined {
    return this.#values.get(id);
  }

  setTemperature(celsius: number): void {
    this.setValue(Char.CURRENT_TEMPERATURE, u16le(Math.round(celsius * 100)));
  }

  setLiquidState(state: LiquidState): void {
    this.setValue(Char.LIQUID_STATE, new Uint8Array([state]));
  }

  setBattery(percent: number, onCharger: boolean): void {
    this.setValue(Char.BATTERY, new Uint8Array([Math.round(percent), onCharger ? 1 : 0]));
  }

  setTemperatureUnitValue(unit: TemperatureUnit): void {
    this.setValue(Char.TEMPERATURE_UNIT, new Uint8Array([unit === TemperatureUnit.FAHRENHEIT ? 1 : 0]));
  }

  emitPushEvent(id: PushEventId): void {
    this.#chars.get(Char.PUSH_EVENT)?.deliver(new Uint8Array([id]));
  }

  emitStatistics(bytes: Uint8Array): void {
    this.#chars.get(Char.STATISTICS)?.deliver(bytes);
  }

  failNext(op: 'read' | 'write', name: string, message = 'GATT operation failed.'): void {
    this.#nextFailure = { op, name, message };
  }

  stall(op: 'read' | 'write'): void {
    this.#stalled.add(op);
  }

  unstall(op: 'read' | 'write'): void {
    this.#stalled.delete(op);
  }

  set writesIgnored(value: boolean) {
    this.#writesAreIgnored = value;
  }

  simulateDisconnect(): void {
    this.gatt.disconnect();
  }

  get connectCalls(): number {
    return this.gatt.connectCalls;
  }

  async watchAdvertisements(_init?: { signal?: AbortSignal }): Promise<void> {
    return;
  }

  simulateAdvertisement(): void {
    this.dispatch('advertisementreceived', { target: this } as unknown as Event);
  }
}

function nameFor(model: DeviceModel): string {
  switch (model) {
    case DeviceModel.TRAVEL_MUG_12_OZ:
      return 'Ember Travel Mug';
    case DeviceModel.CUP_6_OZ:
      return 'Ember Cup';
    case DeviceModel.TUMBLER_16_OZ:
      return 'Ember Tumbler';
    default:
      return 'Ember Ceramic Mug';
  }
}
