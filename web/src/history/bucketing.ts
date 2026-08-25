/**
 * The one implementation of bucketing and time-weighted aggregation.
 *
 * Three callers depend on it: the IndexedDB store (which has no GROUP BY of its own), the
 * outbox when it merges not-yet-uploaded rows onto a remote result, and the conformance
 * suite that holds the SQL backends to the same answers.
 *
 * Pure and synchronous - no storage, no clock.
 */

import {
  LIQUID_PRESENT_DPC,
  LIQUID_STATE_COUNT,
  MAX_GAP_MS,
  TARGET_HISTOGRAM_BIN_CENTI_C,
} from './constants.js';
import {
  BUCKET_MS,
  SampleFlag,
  type Aggregates,
  type Bucket,
  type DeviceId,
  type Millis,
  type Sample,
  type SeriesField,
  type SeriesFrame,
  type SessionRecord,
} from './types.js';

export const centiToCelsius = (v: number | null): number | null => (v === null ? null : v / 100);
export const celsiusToCenti = (v: number): number => Math.round(v * 100);
export const dpcToPercent = (v: number | null): number | null => (v === null ? null : v / 10);
export const percentToDpc = (v: number): number => Math.round(v * 10);

const ALL_FIELDS: readonly SeriesField[] = [
  'tempC',
  'tempMinC',
  'tempMaxC',
  'targetC',
  'batteryPct',
  'batteryMinPct',
  'batteryMaxPct',
  'liquidPct',
  'liquidState',
  'chargeFrac',
  'count',
];

/**
 * Widens a window to whole buckets.
 *
 * A bucketed query returns whole buckets, so the requested window has to be snapped
 * outwards before it is used. Without this the first bucket of a window that starts
 * mid-bucket is either dropped (when reading materialised rollups, whose keys are bucket
 * starts) or silently computed from a partial set of samples (when folding raw rows) -
 * and the two paths then disagree.
 */
export function alignWindow(
  from: Millis,
  to: Millis,
  bucket: Bucket,
): { from: Millis; to: Millis } {
  if (bucket === 'raw') return { from, to };
  const size = BUCKET_MS[bucket];
  return {
    from: Math.floor(from / size) * size,
    to: Math.ceil(to / size) * size,
  };
}

export interface BucketOptions {
  deviceId: DeviceId;
  from: Millis;
  to: Millis;
  bucket: Bucket;
  fields?: readonly SeriesField[];
  limit?: number;
}

/**
 * Partial aggregate for one bucket.
 *
 * Exported and structured-clone friendly because the IndexedDB store persists these as
 * its rollups: merging is exact for sums, extremes, counts and last-value, so an
 * incrementally maintained rollup equals a full re-fold of the same samples.
 */
export interface Accumulator {
  bucketMs: Millis;
  n: number;
  tempSum: number;
  tempCount: number;
  tempMin: number;
  tempMax: number;
  battSum: number;
  battCount: number;
  battMin: number;
  battMax: number;
  liquidSum: number;
  liquidCount: number;
  chargerCount: number;
  lastTs: Millis;
  lastTarget: number | null;
  lastState: number | null;
}

export function newAccumulator(bucketMs: Millis): Accumulator {
  return {
    bucketMs,
    n: 0,
    tempSum: 0,
    tempCount: 0,
    tempMin: Number.POSITIVE_INFINITY,
    tempMax: Number.NEGATIVE_INFINITY,
    battSum: 0,
    battCount: 0,
    battMin: Number.POSITIVE_INFINITY,
    battMax: Number.NEGATIVE_INFINITY,
    liquidSum: 0,
    liquidCount: 0,
    chargerCount: 0,
    lastTs: Number.NEGATIVE_INFINITY,
    lastTarget: null,
    lastState: null,
  };
}

export function accumulate(acc: Accumulator, sample: Sample): void {
  acc.n += 1;
  if (sample.tempC !== null) {
    acc.tempSum += sample.tempC;
    acc.tempCount += 1;
    if (sample.tempC < acc.tempMin) acc.tempMin = sample.tempC;
    if (sample.tempC > acc.tempMax) acc.tempMax = sample.tempC;
  }
  if (sample.batteryDpc !== null) {
    acc.battSum += sample.batteryDpc;
    acc.battCount += 1;
    if (sample.batteryDpc < acc.battMin) acc.battMin = sample.batteryDpc;
    if (sample.batteryDpc > acc.battMax) acc.battMax = sample.batteryDpc;
  }
  if (sample.liquidDpc !== null) {
    acc.liquidSum += sample.liquidDpc;
    acc.liquidCount += 1;
  }
  if ((sample.flags & SampleFlag.OnChargingBase) !== 0) acc.chargerCount += 1;
  // "Last in bucket" is the value from the row with the greatest timestamp, matching the
  // SQL backends' bare-column-with-max(ts) behaviour.
  if (sample.ts >= acc.lastTs) {
    acc.lastTs = sample.ts;
    acc.lastTarget = sample.targetC;
    acc.lastState = sample.liquidState;
  }
}

/** Folds `other` into `into`. Both must describe the same bucket. */
export function mergeAccumulators(into: Accumulator, other: Accumulator): Accumulator {
  const merged: Accumulator = {
    bucketMs: into.bucketMs,
    n: into.n + other.n,
    tempSum: into.tempSum + other.tempSum,
    tempCount: into.tempCount + other.tempCount,
    tempMin: Math.min(into.tempMin, other.tempMin),
    tempMax: Math.max(into.tempMax, other.tempMax),
    battSum: into.battSum + other.battSum,
    battCount: into.battCount + other.battCount,
    battMin: Math.min(into.battMin, other.battMin),
    battMax: Math.max(into.battMax, other.battMax),
    liquidSum: into.liquidSum + other.liquidSum,
    liquidCount: into.liquidCount + other.liquidCount,
    chargerCount: into.chargerCount + other.chargerCount,
    lastTs: Math.max(into.lastTs, other.lastTs),
    lastTarget: other.lastTs >= into.lastTs ? other.lastTarget : into.lastTarget,
    lastState: other.lastTs >= into.lastTs ? other.lastState : into.lastState,
  };
  return merged;
}

/** The finished values for one bucket, in the units the chart layer expects. */
export interface BucketPoint {
  temp: number | null;
  tempMin: number | null;
  tempMax: number | null;
  target: number | null;
  batt: number | null;
  battMin: number | null;
  battMax: number | null;
  liquid: number | null;
  state: number | null;
  chargeFrac: number | null;
  count: number;
}

export function finalizeAccumulator(acc: Accumulator): BucketPoint {
  return {
    temp: acc.tempCount > 0 ? acc.tempSum / acc.tempCount / 100 : null,
    tempMin: acc.tempCount > 0 ? acc.tempMin / 100 : null,
    tempMax: acc.tempCount > 0 ? acc.tempMax / 100 : null,
    target: centiToCelsius(acc.lastTarget),
    batt: acc.battCount > 0 ? acc.battSum / acc.battCount / 10 : null,
    battMin: acc.battCount > 0 ? acc.battMin / 10 : null,
    battMax: acc.battCount > 0 ? acc.battMax / 10 : null,
    liquid: acc.liquidCount > 0 ? acc.liquidSum / acc.liquidCount / 10 : null,
    state: acc.lastState,
    chargeFrac: acc.n > 0 ? acc.chargerCount / acc.n : null,
    count: acc.n,
  };
}

function emptyFrame(options: BucketOptions, fields: ReadonlySet<SeriesField>): SeriesFrame {
  const column = (name: SeriesField): [] | null => (fields.has(name) ? [] : null);
  return {
    deviceId: options.deviceId,
    bucket: options.bucket,
    from: options.from,
    to: options.to,
    t: [],
    tempC: column('tempC'),
    tempMinC: column('tempMinC'),
    tempMaxC: column('tempMaxC'),
    targetC: column('targetC'),
    batteryPct: column('batteryPct'),
    batteryMinPct: column('batteryMinPct'),
    batteryMaxPct: column('batteryMaxPct'),
    liquidPct: column('liquidPct'),
    liquidState: column('liquidState'),
    chargeFrac: column('chargeFrac'),
    count: column('count'),
    truncated: false,
  };
}

/**
 * Folds samples into a columnar frame.
 *
 * Samples must already be filtered to `[from, to)` and sorted ascending by timestamp.
 */
export function bucketSamples(
  samples: readonly Sample[],
  options: BucketOptions,
): SeriesFrame {
  const fields = new Set<SeriesField>(options.fields ?? ALL_FIELDS);
  const frame = emptyFrame(options, fields);
  const limit = options.limit ?? Number.POSITIVE_INFINITY;

  const push = (
    tSeconds: number,
    values: {
      temp: number | null;
      tempMin: number | null;
      tempMax: number | null;
      target: number | null;
      batt: number | null;
      battMin: number | null;
      battMax: number | null;
      liquid: number | null;
      state: number | null;
      chargeFrac: number | null;
      count: number;
    },
  ): void => {
    frame.t.push(tSeconds);
    frame.tempC?.push(values.temp);
    frame.tempMinC?.push(values.tempMin);
    frame.tempMaxC?.push(values.tempMax);
    frame.targetC?.push(values.target);
    frame.batteryPct?.push(values.batt);
    frame.batteryMinPct?.push(values.battMin);
    frame.batteryMaxPct?.push(values.battMax);
    frame.liquidPct?.push(values.liquid);
    frame.liquidState?.push(values.state);
    frame.chargeFrac?.push(values.chargeFrac);
    frame.count?.push(values.count);
  };

  if (options.bucket === 'raw') {
    for (const sample of samples) {
      if (frame.t.length >= limit) {
        frame.truncated = true;
        break;
      }
      push(sample.ts / 1000, {
        temp: centiToCelsius(sample.tempC),
        // A raw point has no spread of its own; the envelope is only meaningful once
        // several samples have been folded together.
        tempMin: null,
        tempMax: null,
        target: centiToCelsius(sample.targetC),
        batt: dpcToPercent(sample.batteryDpc),
        battMin: null,
        battMax: null,
        liquid: dpcToPercent(sample.liquidDpc),
        state: sample.liquidState,
        chargeFrac: (sample.flags & SampleFlag.OnChargingBase) !== 0 ? 1 : 0,
        count: 1,
      });
    }
    return frame;
  }

  const bucketMs = BUCKET_MS[options.bucket];
  let current: Accumulator | null = null;

  const flush = (acc: Accumulator): boolean => {
    if (frame.t.length >= limit) {
      frame.truncated = true;
      return false;
    }
    push(acc.bucketMs / 1000, finalizeAccumulator(acc));
    return true;
  };

  for (const sample of samples) {
    const start = Math.floor(sample.ts / bucketMs) * bucketMs;
    if (current === null) {
      current = newAccumulator(start);
    } else if (current.bucketMs !== start) {
      if (!flush(current)) return frame;
      current = newAccumulator(start);
    }
    accumulate(current, sample);
  }
  if (current !== null) flush(current);

  return frame;
}

export interface AggregateOptions {
  from: Millis;
  to: Millis;
  sessions?: readonly SessionRecord[];
}

/** Overlap of a session with the window, so coverage never counts time twice. */
function observedMs(sessions: readonly SessionRecord[], from: Millis, to: Millis): number {
  const intervals = sessions
    .map((session) => {
      const start = Math.max(session.startedMs, from);
      const end = Math.min(session.endedMs ?? to, to);
      return [start, end] as const;
    })
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);

  let total = 0;
  let cursor = -Infinity;
  for (const [start, end] of intervals) {
    const begin = Math.max(start, cursor);
    if (end > begin) {
      total += end - begin;
      cursor = end;
    }
  }
  return total;
}

/**
 * Time-weighted statistics.
 *
 * Every interval is clamped to `MAX_GAP_MS` and attributed to the state observed at its
 * start. Both rules have to hold in the SQL backends too, or the numbers diverge.
 */
export function aggregateSamples(
  samples: readonly Sample[],
  options: AggregateOptions,
): Aggregates {
  const { from, to, sessions = [] } = options;

  const msPerState = new Array<number>(LIQUID_STATE_COUNT).fill(0);
  const targetMs = new Map<number, number>();
  let msOnCharger = 0;
  let msTempControlOn = 0;
  let msLiquidPresent = 0;

  let tempMin: number | null = null;
  let tempMax: number | null = null;
  let tempSum = 0;
  let tempCount = 0;

  let battMin: number | null = null;
  let battMax: number | null = null;
  let discharged = 0;
  let charged = 0;
  let previousBattery: number | null = null;

  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i]!;

    if (sample.tempC !== null) {
      tempSum += sample.tempC;
      tempCount += 1;
      if (tempMin === null || sample.tempC < tempMin) tempMin = sample.tempC;
      if (tempMax === null || sample.tempC > tempMax) tempMax = sample.tempC;
    }

    if (sample.batteryDpc !== null) {
      if (battMin === null || sample.batteryDpc < battMin) battMin = sample.batteryDpc;
      if (battMax === null || sample.batteryDpc > battMax) battMax = sample.batteryDpc;
      if (previousBattery !== null) {
        const delta = sample.batteryDpc - previousBattery;
        if (delta < 0) discharged += -delta;
        else charged += delta;
      }
      previousBattery = sample.batteryDpc;
    }

    const next = samples[i + 1];
    if (!next) continue;
    const dt = Math.min(next.ts - sample.ts, MAX_GAP_MS);
    if (dt <= 0) continue;

    if (sample.liquidState !== null) msPerState[sample.liquidState]! += dt;
    if ((sample.flags & SampleFlag.OnChargingBase) !== 0) msOnCharger += dt;
    if (sample.targetC !== null) {
      msTempControlOn += dt;
      const bin =
        Math.round(sample.targetC / TARGET_HISTOGRAM_BIN_CENTI_C) * TARGET_HISTOGRAM_BIN_CENTI_C;
      targetMs.set(bin, (targetMs.get(bin) ?? 0) + dt);
    }
    if (sample.liquidDpc !== null && sample.liquidDpc >= LIQUID_PRESENT_DPC) {
      msLiquidPresent += dt;
    }
  }

  const window = Math.max(to - from, 1);
  const observed = observedMs(sessions, from, to);

  return {
    from,
    to,
    observedMs: observed,
    coverage: Math.min(observed / window, 1),
    sampleCount: samples.length,
    temp: {
      minC: centiToCelsius(tempMin),
      maxC: centiToCelsius(tempMax),
      meanC: tempCount > 0 ? tempSum / tempCount / 100 : null,
    },
    msPerState,
    msOnCharger,
    msTempControlOn,
    msLiquidPresent,
    battery: {
      minPct: dpcToPercent(battMin),
      maxPct: dpcToPercent(battMax),
      dischargedPct: discharged / 10,
      chargedPct: charged / 10,
    },
    targetHistogram: [...targetMs.entries()]
      .map(([centi, ms]) => ({ targetC: centi / 100, ms }))
      .sort((a, b) => a.targetC - b.targetC),
    sessionCount: sessions.filter((s) => s.startedMs < to && (s.endedMs ?? to) > from).length,
  };
}

/**
 * Largest-triangle-three-buckets downsampling for a single line.
 *
 * Applied only to the mean series. Running it over a min/max envelope would defeat the
 * envelope's whole purpose, which is to preserve extremes.
 */
export function lttb(
  xs: readonly number[],
  ys: readonly (number | null)[],
  threshold: number,
): { xs: number[]; ys: (number | null)[] } {
  const n = xs.length;
  if (threshold >= n || threshold < 3) return { xs: [...xs], ys: [...ys] };

  const outX: number[] = [xs[0]!];
  const outY: (number | null)[] = [ys[0]!];
  const every = (n - 2) / (threshold - 2);
  let a = 0;

  for (let i = 0; i < threshold - 2; i += 1) {
    const rangeStart = Math.floor((i + 1) * every) + 1;
    const rangeEnd = Math.min(Math.floor((i + 2) * every) + 1, n);

    // Average of the next bucket forms the third point of the triangle.
    let avgX = 0;
    let avgY = 0;
    let avgCount = 0;
    for (let j = rangeStart; j < rangeEnd; j += 1) {
      const y = ys[j];
      if (y === null || y === undefined) continue;
      avgX += xs[j]!;
      avgY += y;
      avgCount += 1;
    }
    if (avgCount > 0) {
      avgX /= avgCount;
      avgY /= avgCount;
    }

    const bucketStart = Math.floor(i * every) + 1;
    const bucketEnd = Math.floor((i + 1) * every) + 1;
    const anchorX = xs[a]!;
    const anchorY = ys[a] ?? 0;

    let bestArea = -1;
    let bestIndex = bucketStart;
    for (let j = bucketStart; j < Math.min(bucketEnd, n); j += 1) {
      const y = ys[j];
      // A gap must survive downsampling, otherwise the line closes over a disconnect.
      if (y === null || y === undefined) {
        bestIndex = j;
        bestArea = Number.POSITIVE_INFINITY;
        break;
      }
      const area = Math.abs(
        (anchorX - avgX) * (y - anchorY) - (anchorX - xs[j]!) * (avgY - anchorY),
      );
      if (area > bestArea) {
        bestArea = area;
        bestIndex = j;
      }
    }

    outX.push(xs[bestIndex]!);
    outY.push(ys[bestIndex] ?? null);
    a = bestIndex;
  }

  outX.push(xs[n - 1]!);
  outY.push(ys[n - 1] ?? null);
  return { xs: outX, ys: outY };
}

export interface RollupPoint {
  bucketMs: Millis;
  acc: Accumulator;
}

/**
 * Builds a frame from persisted rollups instead of raw samples.
 *
 * Because it finalises through the same function the raw path uses, a rollup-backed chart
 * and a raw-backed chart cannot disagree.
 */
export function frameFromRollups(
  rollups: readonly RollupPoint[],
  options: BucketOptions,
): SeriesFrame {
  const fields = new Set<SeriesField>(options.fields ?? ALL_FIELDS);
  const frame = emptyFrame(options, fields);
  const limit = options.limit ?? Number.POSITIVE_INFINITY;

  for (const { bucketMs, acc } of rollups) {
    if (frame.t.length >= limit) {
      frame.truncated = true;
      break;
    }
    const point = finalizeAccumulator(acc);
    frame.t.push(bucketMs / 1000);
    frame.tempC?.push(point.temp);
    frame.tempMinC?.push(point.tempMin);
    frame.tempMaxC?.push(point.tempMax);
    frame.targetC?.push(point.target);
    frame.batteryPct?.push(point.batt);
    frame.batteryMinPct?.push(point.battMin);
    frame.batteryMaxPct?.push(point.battMax);
    frame.liquidPct?.push(point.liquid);
    frame.liquidState?.push(point.state);
    frame.chargeFrac?.push(point.chargeFrac);
    frame.count?.push(point.count);
  }
  return frame;
}
