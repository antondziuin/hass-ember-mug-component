import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { aggregateSamples, bucketSamples } from '../bucketing.js';
import { MAX_GAP_MS } from '../constants.js';
import { deriveDeviceId } from '../HistoryStore.js';
import { IndexedDbStore } from '../stores/indexeddb/IndexedDbStore.js';
import {
  SampleFlag,
  type DeviceEvent,
  type DeviceRecord,
  type Sample,
  type SessionRecord,
} from '../types.js';

const DEVICE = 'sn:TESTDEVICE';
let dbSeq = 0;
let store: IndexedDbStore;

function device(deviceId = DEVICE): DeviceRecord {
  return {
    deviceId,
    serialNumber: deviceId.replace('sn:', ''),
    name: 'Ember',
    model: 'CM19/CM21M',
    deviceType: 'mug',
    capacityMl: 295,
    colour: null,
    fwVersion: '355',
    fwHardware: '128',
    fwBootloader: '18',
    liquidLevelMax: 30,
    firstSeenMs: 0,
    lastSeenMs: 0,
    bleHint: null,
    meta: null,
  };
}

function sample(ts: number, patch: Partial<Sample> = {}): Sample {
  return {
    deviceId: DEVICE,
    ts,
    sessionId: 'session-1',
    tempC: 5700,
    targetC: 5700,
    batteryDpc: 800,
    liquidDpc: 900,
    liquidState: 6,
    batteryMv: null,
    flags: SampleFlag.TempControlOn,
    ...patch,
  };
}

function event(ts: number, patch: Partial<DeviceEvent> = {}): DeviceEvent {
  return {
    eventId: crypto.randomUUID(),
    deviceId: DEVICE,
    ts,
    type: 'state_change',
    sessionId: 'session-1',
    numA: 5,
    numB: 6,
    textA: null,
    data: null,
    ...patch,
  };
}

function session(startedMs: number, endedMs: number | null): SessionRecord {
  return {
    sessionId: `session-${startedMs}`,
    deviceId: DEVICE,
    startedMs,
    endedMs,
    endReason: endedMs === null ? null : 'user_disconnect',
    sampleCount: 0,
    appVersion: '0.1.0',
  };
}

beforeEach(async () => {
  dbSeq += 1;
  store = new IndexedDbStore({ dbName: `test-history-${dbSeq}` });
  await store.open();
  await store.upsertDevice(device());
});

afterEach(async () => {
  await store.close();
});

describe('identity', () => {
  it('derives a stable id from a serial number', () => {
    expect(deriveDeviceId('AB12CD34EF')).toBe('sn:AB12CD34EF');
    expect(deriveDeviceId('ab-12-cd-34-ef')).toBe('sn:AB12CD34EF');
    // Two browsers looking at the same mug converge with no coordination.
    expect(deriveDeviceId('AB12CD34EF')).toBe(deriveDeviceId('AB12CD34EF'));
  });

  it('falls back to an anonymous id when the serial is unreadable', () => {
    expect(deriveDeviceId(null).startsWith('anon:')).toBe(true);
    expect(deriveDeviceId('12345').startsWith('anon:')).toBe(true);
    expect(deriveDeviceId(null)).not.toBe(deriveDeviceId(null));
  });
});

describe('append and dedupe', () => {
  it('stores samples and reports bounds', async () => {
    await store.appendSamples([sample(1000), sample(2000), sample(3000)]);
    const bounds = await store.bounds(DEVICE);
    expect(bounds).toEqual({ minTs: 1000, maxTs: 3000, sampleCount: 3, eventCount: 0 });
  });

  it('treats a replayed batch as a no-op', async () => {
    const rows = [sample(1000), sample(2000)];
    expect(await store.appendSamples(rows)).toMatchObject({ accepted: 2, deduped: 0 });
    // This is what makes a resumed or repeated migration safe.
    expect(await store.appendSamples(rows)).toMatchObject({ accepted: 0, deduped: 2 });
    expect((await store.bounds(DEVICE))?.sampleCount).toBe(2);
  });

  it('dedupes events on their natural key, not just their id', async () => {
    const first = event(5000);
    expect(await store.appendEvents([first])).toMatchObject({ accepted: 1, deduped: 0 });
    // Same transition, different client-minted id: what two browsers would produce.
    expect(await store.appendEvents([{ ...first, eventId: crypto.randomUUID() }])).toMatchObject({
      accepted: 0,
      deduped: 1,
    });
  });

  it('keeps events of different types at the same instant', async () => {
    await store.appendEvents([event(5000, { type: 'state_change' })]);
    await store.appendEvents([event(5000, { type: 'charger_on' })]);
    expect(await store.queryEvents({ deviceId: DEVICE, from: 0, to: 10_000 })).toHaveLength(2);
  });
});

describe('queries', () => {
  it('returns raw points in order', async () => {
    await store.appendSamples([sample(1000, { tempC: 5000 }), sample(2000, { tempC: 5100 })]);
    const frame = await store.queryRange({ deviceId: DEVICE, from: 0, to: 10_000, bucket: 'raw' });

    expect(frame.t).toEqual([1, 2]);
    expect(frame.tempC).toEqual([50, 51]);
    expect(frame.targetC).toEqual([57, 57]);
  });

  it('buckets by minute with a min/max envelope', async () => {
    await store.appendSamples([
      sample(0, { tempC: 5000 }),
      sample(20_000, { tempC: 5400 }),
      sample(40_000, { tempC: 5200 }),
      sample(60_000, { tempC: 3000 }),
    ]);

    const frame = await store.queryRange({
      deviceId: DEVICE,
      from: 0,
      to: 120_000,
      bucket: '1m',
    });

    expect(frame.t).toEqual([0, 60]);
    expect(frame.tempC![0]).toBeCloseTo(52, 5);
    expect(frame.tempMinC![0]).toBeCloseTo(50, 5);
    expect(frame.tempMaxC![0]).toBeCloseTo(54, 5);
    expect(frame.count).toEqual([3, 1]);
  });

  it('gives the same answer from hourly rollups as from a raw fold', async () => {
    // The rollups are maintained incrementally, so this is the check that keeps the
    // accelerated path and the exact path from drifting apart.
    const rows: Sample[] = [];
    for (let i = 0; i < 500; i += 1) {
      rows.push(
        sample(i * 30_000, {
          tempC: 4000 + ((i * 137) % 2000),
          batteryDpc: 500 + (i % 400),
          liquidDpc: (i * 7) % 1000,
          liquidState: (i % 8) as Sample['liquidState'],
          flags: i % 3 === 0 ? SampleFlag.OnChargingBase : 0,
          targetC: i % 5 === 0 ? null : 5700,
        }),
      );
    }
    // Written in several batches, so incremental merging is genuinely exercised.
    for (let i = 0; i < rows.length; i += 37) {
      await store.appendSamples(rows.slice(i, i + 37));
    }

    const from = 0;
    const to = 500 * 30_000;
    const viaRollups = await store.queryRange({ deviceId: DEVICE, from, to, bucket: '1h' });
    const viaRaw = bucketSamples(rows, { deviceId: DEVICE, from, to, bucket: '1h' });

    expect(viaRollups.t).toEqual(viaRaw.t);
    expect(viaRollups.tempC).toEqual(viaRaw.tempC);
    expect(viaRollups.tempMinC).toEqual(viaRaw.tempMinC);
    expect(viaRollups.tempMaxC).toEqual(viaRaw.tempMaxC);
    expect(viaRollups.batteryPct).toEqual(viaRaw.batteryPct);
    expect(viaRollups.liquidPct).toEqual(viaRaw.liquidPct);
    expect(viaRollups.liquidState).toEqual(viaRaw.liquidState);
    expect(viaRollups.targetC).toEqual(viaRaw.targetC);
    expect(viaRollups.chargeFrac).toEqual(viaRaw.chargeFrac);
    expect(viaRollups.count).toEqual(viaRaw.count);
  });

  it('rebuilds rollups to the same values after a delete', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => sample(i * 60_000, { tempC: 5000 + i }));
    await store.appendSamples(rows);
    await store.deleteRange({ deviceId: DEVICE, from: 0, to: 30 * 60_000, include: ['samples'] });

    const remaining = rows.filter((r) => r.ts >= 30 * 60_000);
    const viaRollups = await store.queryRange({
      deviceId: DEVICE,
      from: 0,
      to: 200 * 60_000,
      bucket: '1h',
    });
    const viaRaw = bucketSamples(remaining, {
      deviceId: DEVICE,
      from: 0,
      to: 200 * 60_000,
      bucket: '1h',
    });
    expect(viaRollups.tempC).toEqual(viaRaw.tempC);
  });
});

describe('aggregates', () => {
  it('clamps a gap so a disconnect is not scored as time at temperature', async () => {
    // Two samples eight hours apart, both reading "perfect".
    const rows = [sample(0), sample(8 * 3_600_000), sample(8 * 3_600_000 + 30_000)];
    await store.appendSamples(rows);
    await store.startSession(session(0, 8 * 3_600_000 + 30_000));

    const result = await store.aggregate({ deviceId: DEVICE, from: 0, to: 9 * 3_600_000 });

    // Without the clamp this would be eight hours of "perfect".
    expect(result.msPerState[6]).toBe(MAX_GAP_MS + 30_000);
  });

  it('attributes an interval to the state observed at its start', async () => {
    await store.appendSamples([
      sample(0, { liquidState: 5 }),
      sample(60_000, { liquidState: 6 }),
      sample(90_000, { liquidState: 6 }),
    ]);

    const result = await store.aggregate({ deviceId: DEVICE, from: 0, to: 120_000 });
    // The first minute belongs to "heating", not to the "perfect" that followed it.
    expect(result.msPerState[5]).toBe(60_000);
    expect(result.msPerState[6]).toBe(30_000);
  });

  it('reports coverage from session overlap, not from the sample span', async () => {
    await store.appendSamples([sample(0), sample(3_600_000)]);
    await store.startSession(session(0, 3_600_000));

    const result = await store.aggregate({ deviceId: DEVICE, from: 0, to: 4 * 3_600_000 });
    expect(result.coverage).toBeCloseTo(0.25, 5);
    expect(result.observedMs).toBe(3_600_000);
  });

  it('does not count overlapping sessions twice', async () => {
    await store.startSession(session(0, 2_000));
    await store.startSession(session(1_000, 3_000));
    const result = await store.aggregate({ deviceId: DEVICE, from: 0, to: 10_000 });
    expect(result.observedMs).toBe(3_000);
  });

  it('separates charged from discharged battery movement', async () => {
    await store.appendSamples([
      sample(0, { batteryDpc: 800 }),
      sample(30_000, { batteryDpc: 750 }),
      sample(60_000, { batteryDpc: 900 }),
    ]);
    const result = await store.aggregate({ deviceId: DEVICE, from: 0, to: 120_000 });
    expect(result.battery.dischargedPct).toBeCloseTo(5, 5);
    expect(result.battery.chargedPct).toBeCloseTo(15, 5);
  });

  it('matches the pure fold exactly', async () => {
    const rows = Array.from({ length: 200 }, (_, i) =>
      sample(i * 20_000, {
        tempC: 4000 + ((i * 91) % 2000),
        batteryDpc: 400 + (i % 500),
        liquidState: (i % 8) as Sample['liquidState'],
        targetC: i % 4 === 0 ? null : 5600 + (i % 3) * 50,
        flags: i % 2 === 0 ? SampleFlag.OnChargingBase : 0,
      }),
    );
    await store.appendSamples(rows);
    const sessions = [session(0, 200 * 20_000)];
    await store.startSession(sessions[0]!);

    const from = 0;
    const to = 200 * 20_000;
    const viaStore = await store.aggregate({ deviceId: DEVICE, from, to });
    const viaFold = aggregateSamples(rows, { from, to, sessions });

    expect(viaStore).toEqual(viaFold);
  });
});

describe('export and import', () => {
  it('round-trips through another store', async () => {
    await store.appendSamples([sample(1000), sample(2000), sample(3000)]);
    await store.appendEvents([event(1500)]);
    await store.startSession(session(0, 5000));

    const target = new IndexedDbStore({ dbName: `test-history-target-${dbSeq}` });
    await target.open();
    const progress: number[] = [];
    for await (const step of target.importStream(store.exportStream({}))) {
      progress.push(step.rowsAccepted);
    }

    expect((await target.bounds(DEVICE))?.sampleCount).toBe(3);
    expect(await target.queryEvents({ deviceId: DEVICE, from: 0, to: 10_000 })).toHaveLength(1);
    expect(await target.listSessions({ deviceId: DEVICE, from: 0, to: 10_000 })).toHaveLength(1);
    expect(progress.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);

    await target.close();
  });

  it('is idempotent when the same export is imported twice', async () => {
    await store.appendSamples([sample(1000), sample(2000)]);
    await store.appendEvents([event(1500)]);

    const target = new IndexedDbStore({ dbName: `test-history-twice-${dbSeq}` });
    await target.open();
    for await (const _ of target.importStream(store.exportStream({}))) void _;

    let deduped = 0;
    for await (const step of target.importStream(store.exportStream({}))) {
      deduped += step.rowsDeduped;
    }

    expect(deduped).toBe(3);
    expect((await target.bounds(DEVICE))?.sampleCount).toBe(2);
    await target.close();
  });

  it('pages a large export by timestamp', async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => sample(i * 1000));
    await store.appendSamples(rows);

    let seen = 0;
    for await (const chunk of store.exportStream({ batchRows: 500 })) {
      if (chunk.kind === 'samples') seen += chunk.rows.length;
    }
    expect(seen).toBe(2500);
  });
});

describe('device merge', () => {
  it('folds an anonymous device into the one that later reported a serial', async () => {
    const anon = 'anon:11111111-1111-4111-8111-111111111111';
    await store.upsertDevice({ ...device(anon), serialNumber: null });
    await store.appendSamples([
      { ...sample(1000), deviceId: anon },
      { ...sample(2000), deviceId: anon },
    ]);
    await store.appendSamples([sample(3000)]);

    const moved = await store.mergeDevices(anon, DEVICE);

    expect(moved.movedSamples).toBe(2);
    expect((await store.bounds(DEVICE))?.sampleCount).toBe(3);
    expect(await store.bounds(anon)).toBeNull();
    expect(await store.getDevice(anon)).toBeNull();
  });
});
