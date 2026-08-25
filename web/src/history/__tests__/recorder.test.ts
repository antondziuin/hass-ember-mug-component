import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeviceModel, LiquidState, PushEventId } from '../../lib/ember/constants.js';
import { EmberDevice } from '../../lib/ember/emberDevice.js';
import { memoryStore } from '../../lib/ember/persistence.js';
import { FakeBluetoothDevice } from '../../lib/ember/testing/fakeGatt.js';

import { HistoryRecorder } from '../recorder.js';
import { IndexedDbStore } from '../stores/indexeddb/IndexedDbStore.js';
import { SampleFlag } from '../types.js';

/**
 * End to end through the real pieces: a fake radio, the real device layer, the real gate
 * and the real IndexedDB store. Only the hardware is substituted.
 */

let clock = 1_700_000_000_000;
const now = (): number => clock;
let seq = 0;

let fake: FakeBluetoothDevice;
let device: EmberDevice;
let store: IndexedDbStore;
let recorder: HistoryRecorder;

/**
 * Lets the recorder's async reaction to a device signal finish.
 *
 * Signals are fire-and-forget by design - the device layer must never block on a store
 * write - so a test has to give the resulting session work a chance to land. Timers are
 * advanced rather than just yielding, because under happy-dom fake-indexeddb schedules its
 * transaction queue on setTimeout, which the fake timers otherwise hold.
 */
async function settle(): Promise<void> {
  // Generous: closing a session flushes the write buffer first, and each IndexedDB
  // transaction needs its own turn of the (faked) timer queue.
  for (let i = 0; i < 40; i += 1) {
    await vi.advanceTimersByTimeAsync(2);
  }
}

beforeEach(async () => {
  // Only the timer functions the poll loop uses are faked. fake-indexeddb drives its
  // transaction queue with setImmediate, and faking that deadlocks every database call.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  clock = 1_700_000_000_000;
  seq += 1;

  fake = new FakeBluetoothDevice({ model: DeviceModel.MUG_2_10_OZ, serial: 'RECORDER01' });
  // Auto-reconnect is exercised in the device layer's own tests; here it would just
  // re-open sessions against a store the next test has already closed.
  device = new EmberDevice(fake, { store: memoryStore(), now, autoReconnect: false });
  store = new IndexedDbStore({ dbName: `recorder-test-${seq}` });
  await store.open();
  // singleTab skips Web Locks, which happy-dom does not implement.
  recorder = new HistoryRecorder(device, store, { now, singleTab: true });
});

afterEach(async () => {
  await recorder.stop();
  device.destroy();
  await store.close();
  vi.useRealTimers();
});

describe('HistoryRecorder', () => {
  it('opens a session and records the first reading on connect', async () => {
    await recorder.start();
    await device.connect();
    await settle();
    await settle();
    await recorder.flush();

    const status = recorder.getStatus();
    expect(status.deviceId).toBe('sn:RECORDER01');
    expect(status.recording).toBe(true);

    const bounds = await store.bounds('sn:RECORDER01');
    expect(bounds?.sampleCount).toBeGreaterThanOrEqual(1);

    const sessions = await store.listSessions({
      deviceId: 'sn:RECORDER01',
      from: 0,
      to: Number.MAX_SAFE_INTEGER,
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.endedMs).toBeNull();
  });

  it('writes a device record with the detected model', async () => {
    await recorder.start();
    await device.connect();
    await settle();

    const record = await store.getDevice('sn:RECORDER01');
    expect(record?.serialNumber).toBe('RECORDER01');
    expect(record?.liquidLevelMax).toBe(30);
    expect(record?.fwVersion).toBe('355');
    // Without manufacturer data - which needs an experimental Chrome flag - a standard mug
    // cannot be narrowed to a size or generation, so the exact model is honestly left
    // null and the device type is what gets recorded.
    expect(record?.deviceType).toBe('mug');
    expect(record?.model).toBeNull();
    expect(device.getSnapshot().detection?.confidence).toBe('family');
  });

  it('stores a reading when the temperature moves past the dead-band', async () => {
    await recorder.start();
    await device.connect();
    await settle();
    await recorder.flush();
    const before = (await store.bounds('sn:RECORDER01'))!.sampleCount;

    // Well past the 0.20 C threshold, and past the minimum interval.
    clock += 10_000;
    fake.setTemperature(45);
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    await recorder.flush();

    expect((await store.bounds('sn:RECORDER01'))!.sampleCount).toBeGreaterThan(before);
  });

  it('does not store readings that sit inside the dead-band', async () => {
    await recorder.start();
    await device.connect();
    await settle();
    await recorder.flush();
    const before = (await store.bounds('sn:RECORDER01'))!.sampleCount;

    for (let i = 0; i < 6; i += 1) {
      clock += 10_000;
      fake.setTemperature(23.5 + i * 0.02);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    await settle();
    await recorder.flush();

    expect((await store.bounds('sn:RECORDER01'))!.sampleCount).toBe(before);
  });

  it('records a state change with an event', async () => {
    await recorder.start();
    await device.connect();
    await settle();
    await recorder.flush();

    clock += 10_000;
    fake.setLiquidState(LiquidState.HEATING);
    fake.emitPushEvent(PushEventId.LIQUID_STATE_CHANGED);
    await vi.advanceTimersByTimeAsync(500);
    await settle();
    await recorder.flush();

    const events = await store.queryEvents({
      deviceId: 'sn:RECORDER01',
      from: 0,
      to: Number.MAX_SAFE_INTEGER,
    });
    expect(events.map((e) => e.type)).toContain('state_change');
  });

  it('stores temperature control off as null, not as the device zero', async () => {
    await recorder.start();
    await device.connect();
    await settle();
    await recorder.flush();

    clock += 10_000;
    await device.setTemperatureControl(false);
    await vi.advanceTimersByTimeAsync(500);
    await settle();
    await recorder.flush();

    const raw = await store.rawSamples('sn:RECORDER01', 0, Number.MAX_SAFE_INTEGER);
    const last = raw[raw.length - 1]!;
    expect(last.targetC).toBeNull();
    expect(last.flags & SampleFlag.TempControlOn).toBe(0);
  });

  it('closes the session when the device disconnects', async () => {
    await recorder.start();
    await device.connect();
    await settle();
    await recorder.flush();

    clock += 30_000;
    fake.simulateDisconnect();
    await vi.advanceTimersByTimeAsync(100);
    await settle();

    const sessions = await store.listSessions({
      deviceId: 'sn:RECORDER01',
      from: 0,
      to: Number.MAX_SAFE_INTEGER,
    });
    expect(sessions[0]!.endedMs).not.toBeNull();
    expect(sessions[0]!.endReason).toBe('ble_disconnect');

    const events = await store.queryEvents({
      deviceId: 'sn:RECORDER01',
      from: 0,
      to: Number.MAX_SAFE_INTEGER,
    });
    expect(events.map((e) => e.type)).toContain('session_end');
  });

  it('produces a session that makes coverage meaningful', async () => {
    await recorder.start();
    await device.connect();
    await settle();

    // Ten minutes of use with the temperature moving, then a disconnect.
    for (let i = 0; i < 20; i += 1) {
      clock += 30_000;
      fake.setTemperature(25 + i);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    const endedAt = clock;
    fake.simulateDisconnect();
    await vi.advanceTimersByTimeAsync(100);
    await settle();

    // A window twice as long as the session should read as roughly half covered.
    const from = 1_700_000_000_000;
    const to = from + (endedAt - from) * 2;
    const aggregates = await store.aggregate({ deviceId: 'sn:RECORDER01', from, to });

    expect(aggregates.coverage).toBeGreaterThan(0.4);
    expect(aggregates.coverage).toBeLessThan(0.6);
    expect(aggregates.sampleCount).toBeGreaterThan(5);
  });

  it('keeps buffered rows when the store write fails', async () => {
    await recorder.start();
    await device.connect();
    await settle();
    await settle();
    await recorder.flush();

    const failing = vi
      .spyOn(store, 'appendSamples')
      .mockRejectedValueOnce(new Error('disk on fire'));

    clock += 10_000;
    fake.setTemperature(50);
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    await recorder.flush();

    expect(failing).toHaveBeenCalled();
    expect(recorder.getStatus().lastError).toContain('disk on fire');

    // The rows were put back, so the next flush persists them rather than losing them.
    failing.mockRestore();
    await recorder.flush();
    const raw = await store.rawSamples('sn:RECORDER01', 0, Number.MAX_SAFE_INTEGER);
    expect(raw.some((s) => s.tempC === 5000)).toBe(true);
  });
});
