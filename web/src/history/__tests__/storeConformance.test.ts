// @vitest-environment node
//
// Runs under Node rather than happy-dom so `node:sqlite` resolves: the browser-ish
// environment makes Vite try to load it as an npm package called "sqlite".

import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import { aggregateSamples, alignWindow, bucketSamples } from '../bucketing.js';
import { BUCKET_MS, SampleFlag, type Sample, type SessionRecord } from '../types.js';
import { IndexedDbStore } from '../stores/indexeddb/IndexedDbStore.js';

/**
 * Holds every backend to the same numbers.
 *
 * Three independent implementations of gap-clamped, left-attributed, time-weighted
 * bucketing will drift apart, and the drift is invisible until two screens disagree about
 * how long the coffee was at the right temperature. This is the suite that catches it.
 *
 * The SQLite backend is exercised through `server/src/db.js` directly, which needs
 * `node:sqlite`. Where that is unavailable the SQL half is skipped with a warning rather
 * than silently passing.
 */

const DEVICE = 'sn:CONFORMANCE';
const HOUR = 3_600_000;

/**
 * A 30-day fixture with the awkward cases in it: disconnect gaps, a backwards clock jump,
 * temperature control switching off, charger transitions, and both liquid-level scales.
 */
export function buildFixture(): { samples: Sample[]; sessions: SessionRecord[] } {
  const samples: Sample[] = [];
  const sessions: SessionRecord[] = [];
  const start = Date.UTC(2026, 0, 1, 6, 0, 0);
  let seed = 12345;
  const rand = (): number => {
    // Deterministic, so a failure is reproducible.
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  for (let day = 0; day < 30; day += 1) {
    const dayStart = start + day * 24 * HOUR;

    // Two connected stretches a day, with a long gap between them.
    for (const offsetHours of [0, 9]) {
      const sessionStart = dayStart + offsetHours * HOUR;
      const sessionId = `s-${day}-${offsetHours}`;
      const durationMs = (40 + Math.floor(rand() * 30)) * 60_000;
      sessions.push({
        sessionId,
        deviceId: DEVICE,
        startedMs: sessionStart,
        endedMs: sessionStart + durationMs,
        endReason: 'user_disconnect',
        sampleCount: 0,
        appVersion: '0.1.0',
      });

      let ts = sessionStart;
      let temp = 2000 + Math.floor(rand() * 500);
      let battery = 900 - day * 3;
      let state: Sample['liquidState'] = 2;

      while (ts < sessionStart + durationMs) {
        const controlOff = day % 7 === 3 && ts > sessionStart + durationMs / 2;
        samples.push({
          deviceId: DEVICE,
          ts,
          sessionId,
          tempC: temp,
          // Null, never 0, when control is off.
          targetC: controlOff ? null : 5700,
          batteryDpc: battery,
          liquidDpc: state === 1 ? 0 : 600 + Math.floor(rand() * 400),
          liquidState: state,
          batteryMv: null,
          flags:
            (day % 3 === 0 ? SampleFlag.OnChargingBase : 0) |
            (controlOff ? 0 : SampleFlag.TempControlOn),
        });

        // Heat towards target, then hold, then cool as it is drunk.
        if (temp < 5650) {
          temp += 120 + Math.floor(rand() * 60);
          state = 5;
        } else if (ts < sessionStart + durationMs * 0.7) {
          temp = 5700 + Math.floor(rand() * 30) - 15;
          state = 6;
        } else {
          temp -= 40 + Math.floor(rand() * 40);
          state = 4;
        }
        if (ts > sessionStart + durationMs * 0.95) state = 1;

        battery = Math.max(50, battery - (day % 3 === 0 ? -2 : 1));
        ts += 15_000 + Math.floor(rand() * 45_000);
      }
    }
  }

  // A clock that jumped backwards, which the recorder guards against but a stored history
  // may still contain. Sorting must not leave duplicate timestamps behind.
  samples.push({
    deviceId: DEVICE,
    ts: start + 10 * 24 * HOUR,
    sessionId: null,
    tempC: 4200,
    targetC: 5700,
    batteryDpc: 500,
    liquidDpc: 300,
    liquidState: 5,
    batteryMv: null,
    flags: SampleFlag.TempControlOn,
  });

  const unique = new Map<number, Sample>();
  for (const sample of samples) unique.set(sample.ts, sample);
  return {
    samples: [...unique.values()].sort((a, b) => a.ts - b.ts),
    sessions,
  };
}

const { samples: FIXTURE, sessions: SESSIONS } = buildFixture();
const FROM = FIXTURE[0]!.ts;
const TO = FIXTURE[FIXTURE.length - 1]!.ts + 1;

/** Compares numbers with a tolerance, since SQL AVG and a JS mean differ in the last bits. */
function expectSeriesClose(
  actual: (number | null)[] | null,
  expected: (number | null)[] | null,
  label: string,
): void {
  expect(actual === null, `${label}: nullness`).toBe(expected === null);
  if (actual === null || expected === null) return;
  expect(actual.length, `${label}: length`).toBe(expected.length);
  for (let i = 0; i < actual.length; i += 1) {
    const a = actual[i] ?? null;
    const b = expected[i] ?? null;
    if (a === null || b === null) {
      expect(a, `${label}[${i}]`).toBe(b);
    } else {
      expect(Math.abs(a - b), `${label}[${i}] ${a} vs ${b}`).toBeLessThan(1e-6);
    }
  }
}

describe('IndexedDB conforms to the shared fold', () => {
  it('produces identical frames and aggregates', async () => {
    const store = new IndexedDbStore({ dbName: `conformance-${Date.now()}` });
    await store.open();
    await store.upsertDevice({
      deviceId: DEVICE,
      serialNumber: 'CONFORMANCE',
      name: 'Fixture',
      model: 'CM19/CM21M',
      deviceType: 'mug',
      capacityMl: 295,
      colour: null,
      fwVersion: null,
      fwHardware: null,
      fwBootloader: null,
      liquidLevelMax: 30,
      firstSeenMs: FROM,
      lastSeenMs: TO,
      bleHint: null,
      meta: null,
    });

    // Written in uneven batches, so incremental rollup merging is genuinely exercised.
    for (let i = 0; i < FIXTURE.length; i += 137) {
      await store.appendSamples(FIXTURE.slice(i, i + 137));
    }
    for (const session of SESSIONS) await store.startSession(session);

    for (const bucket of ['1m', '5m', '1h', '1d'] as const) {
      // A bucketed query returns whole buckets, so the expectation is built over the same
      // outward-snapped window the store uses.
      const w = alignWindow(FROM, TO, bucket);
      const actual = await store.queryRange({ deviceId: DEVICE, from: FROM, to: TO, bucket });
      const expected = bucketSamples(FIXTURE, {
        deviceId: DEVICE,
        from: w.from,
        to: w.to,
        bucket,
      });
      expect(actual.t, `${bucket}: t`).toEqual(expected.t);
      expectSeriesClose(actual.tempC, expected.tempC, `${bucket}: tempC`);
      expectSeriesClose(actual.tempMinC, expected.tempMinC, `${bucket}: tempMinC`);
      expectSeriesClose(actual.tempMaxC, expected.tempMaxC, `${bucket}: tempMaxC`);
      expectSeriesClose(actual.targetC, expected.targetC, `${bucket}: targetC`);
      expectSeriesClose(actual.batteryPct, expected.batteryPct, `${bucket}: batteryPct`);
      expectSeriesClose(actual.liquidState, expected.liquidState, `${bucket}: liquidState`);
      expectSeriesClose(actual.chargeFrac, expected.chargeFrac, `${bucket}: chargeFrac`);
    }

    const aggregate = await store.aggregate({ deviceId: DEVICE, from: FROM, to: TO });
    const expected = aggregateSamples(FIXTURE, { from: FROM, to: TO, sessions: SESSIONS });
    expect(aggregate).toEqual(expected);

    await store.close();
  }, 60_000);
});

describe('SQLite conforms to the shared fold', () => {
  it('produces identical frames and aggregates', async () => {
    let HistoryDb: typeof import('../../../server/src/db.d.ts').HistoryDb;
    let DatabaseSync: new (path: string) => unknown;
    try {
      // Loaded through createRequire rather than a bare import: without the
      // --experimental-sqlite flag Node does not list `sqlite` as a builtin, so Vite
      // tries to resolve it as an npm package and fails before the fork ever runs.
      const { createRequire } = await import('node:module');
      const nodeRequire = createRequire(import.meta.url);
      ({ DatabaseSync } = nodeRequire('node:sqlite'));
      ({ HistoryDb } = await import('../../../server/src/db.js'));
    } catch (error) {
      console.warn(
        'Skipping the SQLite half of the conformance suite: node:sqlite is unavailable. ' +
          `Run vitest with --experimental-sqlite, or on Node 24+. ${String(error)}`,
      );
      return;
    }

    const raw = new DatabaseSync(':memory:') as never;
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const schemaPath = fileURLToPath(new URL('../../../server/src/schema.sql', import.meta.url));
    (raw as { exec(sql: string): void }).exec(readFileSync(schemaPath, 'utf8'));
    const db = new HistoryDb(raw);

    db.upsertDevice({
      deviceId: DEVICE,
      serialNumber: 'CONFORMANCE',
      name: 'Fixture',
      model: 'CM19/CM21M',
      deviceType: 'mug',
      liquidLevelMax: 30,
      firstSeenMs: FROM,
      lastSeenMs: TO,
    });
    for (const session of SESSIONS) db.upsertSession(session);
    db.insertSamples(
      DEVICE,
      FIXTURE.map((s) => [
        s.ts,
        s.tempC,
        s.targetC,
        s.batteryDpc,
        s.liquidDpc,
        s.liquidState,
        s.batteryMv,
        s.flags,
        s.sessionId,
      ]),
    );

    for (const bucket of ['1m', '5m', '1h', '1d'] as const) {
      const w = alignWindow(FROM, TO, bucket);
      const rows = db.bucketed(DEVICE, w.from, w.to, BUCKET_MS[bucket], 100_000);
      const expected = bucketSamples(FIXTURE, {
        deviceId: DEVICE,
        from: w.from,
        to: w.to,
        bucket,
      });

      expect(rows.map((r) => Number(r.b) / 1000), `${bucket}: t`).toEqual(expected.t);
      expectSeriesClose(
        rows.map((r) => (r.temp_avg === null ? null : r.temp_avg / 100)),
        expected.tempC,
        `${bucket}: tempC`,
      );
      expectSeriesClose(
        rows.map((r) => (r.temp_min === null ? null : r.temp_min / 100)),
        expected.tempMinC,
        `${bucket}: tempMinC`,
      );
      expectSeriesClose(
        rows.map((r) => (r.temp_max === null ? null : r.temp_max / 100)),
        expected.tempMaxC,
        `${bucket}: tempMaxC`,
      );
      expectSeriesClose(
        rows.map((r) => (r.target_last === null ? null : r.target_last / 100)),
        expected.targetC,
        `${bucket}: targetC`,
      );
      expectSeriesClose(
        rows.map((r) => (r.batt_avg === null ? null : r.batt_avg / 10)),
        expected.batteryPct,
        `${bucket}: batteryPct`,
      );
      expectSeriesClose(
        rows.map((r) => r.state_last),
        expected.liquidState,
        `${bucket}: liquidState`,
      );
      expectSeriesClose(
        rows.map((r) => r.charge_frac),
        expected.chargeFrac,
        `${bucket}: chargeFrac`,
      );
    }

    const actual = db.aggregate(DEVICE, FROM, TO);
    const expected = aggregateSamples(FIXTURE, { from: FROM, to: TO, sessions: SESSIONS });

    expect(actual.msPerState, 'msPerState').toEqual(expected.msPerState);
    expect(actual.msOnCharger, 'msOnCharger').toBe(expected.msOnCharger);
    expect(actual.msTempControlOn, 'msTempControlOn').toBe(expected.msTempControlOn);
    expect(actual.msLiquidPresent, 'msLiquidPresent').toBe(expected.msLiquidPresent);
    expect(actual.observedMs, 'observedMs').toBe(expected.observedMs);
    expect(actual.coverage, 'coverage').toBeCloseTo(expected.coverage, 10);
    expect(actual.sampleCount, 'sampleCount').toBe(expected.sampleCount);
    expect(actual.temp.minC).toBeCloseTo(expected.temp.minC!, 10);
    expect(actual.temp.maxC).toBeCloseTo(expected.temp.maxC!, 10);
    expect(actual.temp.meanC).toBeCloseTo(expected.temp.meanC!, 8);
    expect(actual.battery.dischargedPct).toBeCloseTo(expected.battery.dischargedPct, 8);
    expect(actual.battery.chargedPct).toBeCloseTo(expected.battery.chargedPct, 8);
    expect(actual.targetHistogram, 'targetHistogram').toEqual(expected.targetHistogram);

    db.close();
  }, 60_000);
});
