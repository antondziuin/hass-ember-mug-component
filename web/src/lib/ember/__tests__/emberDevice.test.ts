import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DeviceModel,
  LiquidState,
  PushEventId,
  TemperatureUnit,
  VolumeLevel,
} from '../constants.js';
import { EmberDevice } from '../emberDevice.js';
import { EmberError } from '../errors.js';
import { memoryStore } from '../persistence.js';
import { FakeBluetoothDevice } from '../testing/fakeGatt.js';
import { Char } from '../uuids.js';

let clock = 1_000_000;
const now = (): number => clock;

function makeDevice(options: Partial<ConstructorParameters<typeof FakeBluetoothDevice>[0]> = {}) {
  const fake = new FakeBluetoothDevice({ model: DeviceModel.MUG_2_10_OZ, ...options });
  const device = new EmberDevice(fake, { store: memoryStore(), now });
  return { fake, device };
}

beforeEach(() => {
  clock = 1_000_000;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('connect', () => {
  it('reads every supported attribute and reports the model', async () => {
    const { fake, device } = makeDevice();
    await device.connect();

    const state = device.getSnapshot();
    expect(state.connection.status).toBe('connected');
    expect(state.attrs.currentTemp).toBeCloseTo(23.5, 2);
    expect(state.attrs.targetTemp).toBeCloseTo(57, 2);
    expect(state.attrs.battery).toEqual({ percent: 87, onChargingBase: false });
    expect(state.attrs.liquidState).toBe(LiquidState.EMPTY);
    expect(state.attrs.firmware).toEqual({ version: 355, hardware: 128, bootloader: 18 });
    expect(state.attrs.meta?.serialNumber).toBe('AB12CD34EF');
    expect(state.attrs.name).toBe('Ember');

    // Never more than one GATT operation in flight, which is what Chrome enforces.
    expect(fake.maxConcurrentOps).toBe(1);

    device.destroy();
  });

  it('exposes unrecognised characteristics for the diagnostics report', async () => {
    const { device } = makeDevice();
    await device.connect();
    expect(device.getSnapshot().unknownCharUuids).toContain(
      '0000180a-0000-1000-8000-00805f9b34fb',
    );
    device.destroy();
  });

  it('derives capabilities from what the device really exposes', async () => {
    const { device } = makeDevice();
    await device.connect();
    const caps = device.getSnapshot().capabilities;
    expect(caps.has('ledColour')).toBe(true);
    expect(caps.has('name')).toBe(true);
    expect(caps.has('volumeLevel')).toBe(false);
    device.destroy();
  });

  it('handles a Travel Mug: volume instead of LED, and a 0-100 liquid scale', async () => {
    const { device } = makeDevice({ model: DeviceModel.TRAVEL_MUG_12_OZ });
    await device.connect();

    const state = device.getSnapshot();
    expect(state.detection?.model).toBe(DeviceModel.TRAVEL_MUG_12_OZ);
    expect(state.capabilities.has('volumeLevel')).toBe(true);
    expect(state.capabilities.has('ledColour')).toBe(false);
    expect(state.capabilities.has('batteryVoltage')).toBe(true);
    expect(device.liquidLevelMax).toBe(100);
    expect(state.attrs.volumeLevel).toBe(VolumeLevel.MEDIUM);

    device.destroy();
  });

  it('does not offer a name control on a Cup', async () => {
    const { device } = makeDevice({ model: DeviceModel.CUP_6_OZ, name: 'Ember Cup' });
    await device.connect();
    expect(device.getSnapshot().capabilities.has('name')).toBe(false);
    await expect(device.setName('Nope')).rejects.toBeInstanceOf(EmberError);
    device.destroy();
  });
});

describe('writes', () => {
  it('writes the target temperature and confirms it by read-back', async () => {
    const { fake, device } = makeDevice();
    await device.connect();

    const result = await device.setTargetTemp(58.5);
    expect(result.confirmed).toBe(true);
    expect(device.getSnapshot().attrs.targetTemp).toBeCloseTo(58.5, 2);
    expect(device.getSnapshot().writability).toBe('yes');

    const written = fake.writeLog.filter((w) => w.id === Char.TARGET_TEMPERATURE).at(-1);
    expect([...written!.bytes]).toEqual([0xda, 0x16]); // 5850, little-endian

    device.destroy();
  });

  it('detects a device that acknowledges writes but ignores them', async () => {
    const { device } = makeDevice({ writesAreIgnored: true });
    await device.connect();

    const result = await device.setTargetTemp(60);
    expect(result.confirmed).toBe(false);
    expect(device.getSnapshot().writability).toBe('no');
    expect(device.getSnapshot().lastFailure).toMatchObject({ kind: 'not-writable' });
    // The optimistic value must not be left behind after the read-back disagreed.
    expect(device.getSnapshot().attrs.targetTemp).toBeCloseTo(57, 2);

    device.destroy();
  });

  it('remembers the target across a temperature-control off/on cycle', async () => {
    const { device } = makeDevice();
    await device.connect();

    await device.setTargetTemp(59);
    await device.setTemperatureControl(false);
    expect(device.getSnapshot().attrs.targetTemp).toBe(0);

    await device.setTemperatureControl(true);
    expect(device.getSnapshot().attrs.targetTemp).toBeCloseTo(59, 2);

    device.destroy();
  });

  it('rejects an out-of-range target before touching the radio', async () => {
    const { fake, device } = makeDevice();
    await device.connect();
    const writesBefore = fake.writeLog.length;

    await expect(device.setTargetTemp(70)).rejects.toBeInstanceOf(EmberError);
    expect(fake.writeLog.length).toBe(writesBefore);

    device.destroy();
  });

  it('reverts the optimistic value when the write itself fails', async () => {
    const { fake, device } = makeDevice();
    await device.connect();
    const before = device.getSnapshot().attrs.ledColour;

    fake.failNext('write', 'NotSupportedError', 'GATT operation not permitted.');
    await expect(
      device.setLedColour({ red: 1, green: 2, blue: 3, brightness: 4 }),
    ).rejects.toBeInstanceOf(EmberError);

    expect(device.getSnapshot().attrs.ledColour).toEqual(before);
    expect(device.getSnapshot().pending.size).toBe(0);

    device.destroy();
  });

  it('writes the LED colour and the device unit', async () => {
    const { device } = makeDevice();
    await device.connect();

    await device.setLedColour({ red: 244, green: 0, blue: 161, brightness: 255 });
    expect(device.getSnapshot().attrs.ledColour).toEqual({
      red: 244,
      green: 0,
      blue: 161,
      brightness: 255,
    });

    await device.setTemperatureUnit(TemperatureUnit.FAHRENHEIT);
    expect(device.getSnapshot().attrs.temperatureUnit).toBe(TemperatureUnit.FAHRENHEIT);

    device.destroy();
  });
});

describe('optimistic writes', () => {
  async function connectWithLatency(latencyMs: number) {
    const made = makeDevice({ latencyMs });
    const connecting = made.device.connect();
    while (made.device.getSnapshot().connection.status !== 'connected') {
      await vi.advanceTimersByTimeAsync(5);
    }
    await connecting;
    return made;
  }

  it('writes only the newest of a burst and never flashes an older value', async () => {
    // Issued straight after connecting, so the burst also races the writability probe.
    const { fake, device } = await connectWithLatency(20);
    const seen: number[] = [];
    const writability: string[] = [];
    device.subscribe(() => {
      const state = device.getSnapshot();
      seen.push(state.attrs.targetTemp ?? -1);
      writability.push(state.writability);
    });
    const writesBefore = fake.writeLog.filter((w) => w.id === Char.TARGET_TEMPERATURE).length;

    const results = [55, 56, 57.5, 59, 60].map((celsius) => device.setTargetTemp(celsius));
    await vi.advanceTimersByTimeAsync(3_000);
    const settled = await Promise.all(results);

    expect(settled.every((r) => r.confirmed)).toBe(true);
    expect(device.getSnapshot().attrs.targetTemp).toBeCloseTo(60, 2);
    expect(device.getSnapshot().pending.size).toBe(0);
    // Once the final value is on screen it stays there.
    const shown = seen.findIndex((v) => Math.abs(v - 60) < 0.02);
    expect(seen.slice(shown).every((v) => Math.abs(v - 60) < 0.02)).toBe(true);
    expect(writability).not.toContain('no');

    // The values in between were superseded before their turn and never sent.
    const written = fake.writeLog
      .filter((w) => w.id === Char.TARGET_TEMPERATURE)
      .slice(writesBefore)
      .map((w) => (w.bytes[0]! | (w.bytes[1]! << 8)) / 100);
    for (const skipped of [56, 57.5, 59]) expect(written).not.toContain(skipped);
    expect(written.at(-1)).toBe(60);

    device.destroy();
  });

  it('ignores a poll value that was read before the user changed it', async () => {
    const { device } = await connectWithLatency(20);
    await vi.advanceTimersByTimeAsync(1_000);

    // A full sweep reads the target early and the rest afterwards.
    const refreshing = device.refresh();
    await vi.advanceTimersByTimeAsync(50);

    const seen: number[] = [];
    device.subscribe(() => seen.push(device.getSnapshot().attrs.targetTemp ?? -1));
    const write = device.setTargetTemp(60);
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.all([refreshing, write]);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((v) => Math.abs(v - 60) < 0.02)).toBe(true);
    device.destroy();
  });

  it('keeps a change made while disconnected and writes it after reconnecting', async () => {
    const { fake, device } = makeDevice();
    await device.connect();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    fake.simulateDisconnect();
    const write = device.setTargetTemp(60);
    expect(device.getSnapshot().attrs.targetTemp).toBeCloseTo(60, 2);
    expect(device.getSnapshot().pending.has('targetTemp')).toBe(true);

    await vi.advanceTimersByTimeAsync(1_100);
    await expect(write).resolves.toEqual({ confirmed: true });
    expect(device.getSnapshot().connection.status).toBe('connected');
    expect([...fake.getValue(Char.TARGET_TEMPERATURE)!]).toEqual([0x70, 0x17]);
    expect(device.getSnapshot().attrs.targetTemp).toBeCloseTo(60, 2);

    randomSpy.mockRestore();
    device.destroy();
  });

  it('drops unwritten changes when the user disconnects', async () => {
    const { fake, device } = makeDevice();
    await device.connect();
    fake.simulateDisconnect();

    const write = device.setTargetTemp(60);
    await device.disconnect();

    await expect(write).rejects.toBeInstanceOf(EmberError);
    expect(device.getSnapshot().attrs.targetTemp).toBeCloseTo(57, 2);
    device.destroy();
  });

  it('does not call a mug read-only on an auth event once writes are confirmed', async () => {
    const { fake, device } = makeDevice();
    await device.connect();
    await device.setTargetTemp(58);
    expect(device.getSnapshot().writability).toBe('yes');

    fake.emitPushEvent(PushEventId.AUTH_INFO_NOT_FOUND);
    expect(device.getSnapshot().writability).toBe('yes');
    device.destroy();
  });
});

describe('push events', () => {
  it('re-reads the affected attribute after a coalescing delay', async () => {
    const { fake, device } = makeDevice();
    await device.connect();

    fake.setTemperature(57.25);
    fake.emitPushEvent(PushEventId.DRINK_TEMPERATURE_CHANGED);

    // Nothing happens instantly: events are coalesced first.
    expect(device.getSnapshot().attrs.currentTemp).toBeCloseTo(23.5, 2);

    await vi.advanceTimersByTimeAsync(300);
    expect(device.getSnapshot().attrs.currentTemp).toBeCloseTo(57.25, 2);

    device.destroy();
  });

  it('applies a charger transition immediately, without waiting for a read', async () => {
    const { fake, device } = makeDevice();
    await device.connect();
    expect(device.getSnapshot().attrs.battery?.onChargingBase).toBe(false);

    fake.emitPushEvent(PushEventId.CHARGER_CONNECTED);
    expect(device.getSnapshot().attrs.battery?.onChargingBase).toBe(true);
    expect(device.getSnapshot().attrs.battery?.percent).toBe(87);

    device.destroy();
  });

  it('debounces a repeat of the same event within five seconds', async () => {
    const { fake, device } = makeDevice();
    await device.connect();

    const signals: string[] = [];
    device.subscribeSignals((signal) => {
      if (signal.type === 'push') signals.push(String(signal.id));
    });

    fake.emitPushEvent(PushEventId.LIQUID_STATE_CHANGED);
    fake.emitPushEvent(PushEventId.LIQUID_STATE_CHANGED);
    expect(signals).toHaveLength(1);

    clock += 5001;
    fake.emitPushEvent(PushEventId.LIQUID_STATE_CHANGED);
    expect(signals).toHaveLength(2);

    device.destroy();
  });

  it('treats a missing-auth-info event as definitively not writable', async () => {
    const { fake, device } = makeDevice();
    await device.connect();

    fake.emitPushEvent(PushEventId.AUTH_INFO_NOT_FOUND);
    expect(device.getSnapshot().authInfoMissing).toBe(true);
    expect(device.getSnapshot().writability).toBe('no');

    device.destroy();
  });
});

describe('polling', () => {
  it('reads the hot set frequently and everything on every sixth tick', async () => {
    const { fake, device } = makeDevice();
    await device.connect();

    fake.setValue(Char.MUG_NAME, new TextEncoder().encode('Renamed'));
    fake.setTemperature(41);

    // One hot tick: temperature moves, the name does not.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(device.getSnapshot().attrs.currentTemp).toBeCloseTo(41, 2);
    expect(device.getSnapshot().attrs.name).toBe('Ember');

    // Five more ticks reaches the full sweep.
    await vi.advanceTimersByTimeAsync(5_000 * 5);
    expect(device.getSnapshot().attrs.name).toBe('Renamed');

    device.destroy();
  });

  it('backs off to the idle cadence when standby and on the charger', async () => {
    const { fake, device } = makeDevice();
    await device.connect();

    fake.setLiquidState(LiquidState.STANDBY);
    fake.setBattery(90, true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(device.getSnapshot().attrs.battery?.onChargingBase).toBe(true);

    fake.setTemperature(30);
    // The next tick is now 30s away, so 10s of movement must not be picked up yet.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(device.getSnapshot().attrs.currentTemp).toBeCloseTo(23.5, 2);

    await vi.advanceTimersByTimeAsync(25_000);
    expect(device.getSnapshot().attrs.currentTemp).toBeCloseTo(30, 2);

    device.destroy();
  });

  it('survives a transient read failure and keeps polling', async () => {
    const { fake, device } = makeDevice();
    await device.connect();

    fake.failNext('read', 'NotSupportedError', 'GATT operation not permitted.');
    fake.setTemperature(44);

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(device.getSnapshot().attrs.currentTemp).toBeCloseTo(44, 2);
    expect(device.getSnapshot().connection.status).toBe('connected');

    device.destroy();
  });
});

describe('disconnection', () => {
  it('schedules a backoff reconnect and recovers', async () => {
    const { fake, device } = makeDevice();
    await device.connect();

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    fake.simulateDisconnect();

    const state = device.getSnapshot();
    expect(state.connection.status).toBe('reconnecting');
    if (state.connection.status === 'reconnecting') {
      expect(state.connection.attempt).toBe(1);
    }

    await vi.advanceTimersByTimeAsync(1_100);
    expect(device.getSnapshot().connection.status).toBe('connected');

    randomSpy.mockRestore();
    device.destroy();
  });

  it('keeps the last known values for a greyed-out UI after an intentional disconnect', async () => {
    const { device } = makeDevice();
    await device.connect();
    const temp = device.getSnapshot().attrs.currentTemp;

    await device.disconnect();

    expect(device.getSnapshot().connection.status).toBe('disconnected');
    expect(device.getSnapshot().attrs.currentTemp).toBe(temp);

    device.destroy();
  });

  it('does not reconnect after an intentional disconnect', async () => {
    const { device } = makeDevice();
    await device.connect();
    await device.disconnect();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(device.getSnapshot().connection.status).toBe('disconnected');
    await device.reconnectNow();
    expect(device.getSnapshot().connection.status).toBe('disconnected');

    device.destroy();
  });

  it('reconnectNow skips the backoff and restores the link', async () => {
    const { fake, device } = makeDevice();
    await device.connect();
    fake.simulateDisconnect();
    expect(device.getSnapshot().connection.status).toBe('reconnecting');

    await device.reconnectNow();
    expect(device.getSnapshot().connection.status).toBe('connected');

    device.destroy();
  });

  it('does not open two GATT sessions at once', async () => {
    const { fake, device } = makeDevice();
    await device.connect();
    fake.simulateDisconnect();

    const first = device.reconnectNow();
    const second = device.reconnectNow();
    await Promise.all([first, second]);

    expect(fake.connectCalls).toBe(2);
    expect(device.getSnapshot().connection.status).toBe('connected');

    device.destroy();
  });

  it('retries immediately when the tab becomes visible again', async () => {
    const { fake, device } = makeDevice();
    await device.connect();
    fake.simulateDisconnect();
    expect(device.getSnapshot().connection.status).toBe('reconnecting');

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);

    expect(device.getSnapshot().connection.status).toBe('connected');

    device.destroy();
  });

  it('reconnects after pagehide then pageshow without waiting for backoff', async () => {
    const { fake, device } = makeDevice();
    await device.connect();

    window.dispatchEvent(new Event('pagehide'));
    expect(device.getSnapshot().connection.status).toBe('disconnected');

    window.dispatchEvent(new Event('pageshow'));
    await vi.advanceTimersByTimeAsync(0);

    expect(device.getSnapshot().connection.status).toBe('connected');
    expect(fake.connectCalls).toBeGreaterThan(1);

    device.destroy();
  });

  it('retries when the Bluetooth adapter reports it is back', async () => {
    const listeners = new Set<(event: Event) => void>();
    const bluetooth = {
      addEventListener: (_type: string, listener: (event: Event) => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: (event: Event) => void) => {
        listeners.delete(listener);
      },
    };
    vi.stubGlobal('navigator', { ...navigator, bluetooth });

    const { fake, device } = makeDevice();
    await device.connect();
    fake.simulateDisconnect();
    expect(device.getSnapshot().connection.status).toBe('reconnecting');

    for (const listener of listeners) {
      listener({ type: 'availabilitychanged', value: false } as Event & { value: boolean });
    }
    expect(device.getSnapshot().connection.status).toBe('reconnecting');

    for (const listener of listeners) {
      listener({ type: 'availabilitychanged', value: true } as Event & { value: boolean });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(device.getSnapshot().connection.status).toBe('connected');

    vi.unstubAllGlobals();
    device.destroy();
  });

  it('wakes from an advertisement instead of waiting out the backoff', async () => {
    const { fake, device } = makeDevice();
    await device.connect();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    fake.simulateDisconnect();
    expect(device.getSnapshot().connection.status).toBe('reconnecting');

    fake.simulateAdvertisement();
    await vi.advanceTimersByTimeAsync(0);

    expect(device.getSnapshot().connection.status).toBe('connected');

    randomSpy.mockRestore();
    device.destroy();
  });

  it('emits connect and disconnect signals for the history recorder', async () => {
    const { fake, device } = makeDevice();
    const signals: string[] = [];
    device.subscribeSignals((signal) => signals.push(signal.type));

    await device.connect();
    fake.simulateDisconnect();

    expect(signals).toContain('connected');
    expect(signals).toContain('disconnected');

    device.destroy();
  });
});

describe('model override', () => {
  it('applies a user choice and persists it under the serial number', async () => {
    const store = memoryStore();
    const fake = new FakeBluetoothDevice({ model: DeviceModel.MUG_2_10_OZ });
    const device = new EmberDevice(fake, { store, now });
    await device.connect();

    device.setModelOverride(DeviceModel.MUG_2_14_OZ);
    expect(device.getSnapshot().detection?.model).toBe(DeviceModel.MUG_2_14_OZ);
    expect(device.getSnapshot().detection?.source).toBe('user-override');
    device.destroy();

    // A fresh instance for the same serial picks the choice back up.
    const again = new EmberDevice(new FakeBluetoothDevice({ model: DeviceModel.MUG_2_10_OZ }), {
      store,
      now,
    });
    await again.connect();
    expect(again.getSnapshot().detection?.model).toBe(DeviceModel.MUG_2_14_OZ);
    again.destroy();
  });
});
