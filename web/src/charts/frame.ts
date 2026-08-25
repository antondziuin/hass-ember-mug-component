/**
 * Turns a stored series into something a chart can draw honestly.
 *
 * The store returns rows, not gaps. If the rows are handed straight to the chart it draws
 * a clean line from Tuesday evening to Wednesday morning, across eight hours when the app
 * was not even running. So an explicit break is inserted after each connected session.
 */

import { lttb } from '../history/bucketing.js';
import { BUCKET_MS, type Bucket, type Millis, type SeriesFrame, type SessionRecord } from '../history/types.js';

/** uPlot's data layout: x first, then one array per series. */
export type ChartData = [number[], ...(number | null)[][]];

export interface RunLength<T> {
  from: number;
  to: number;
  value: T;
}

/**
 * Groups equal consecutive values into spans, for background shading.
 * `null` values are skipped so unknown stretches are simply not painted.
 */
export function runLengths<T>(
  xs: readonly number[],
  values: readonly (T | null)[] | null,
): Array<RunLength<T>> {
  if (!values) return [];
  const runs: Array<RunLength<T>> = [];
  let start = -1;
  let current: T | null = null;

  const close = (endIndex: number): void => {
    if (start >= 0 && current !== null) {
      runs.push({ from: xs[start]!, to: xs[endIndex]!, value: current });
    }
    start = -1;
    current = null;
  };

  for (let i = 0; i < xs.length; i += 1) {
    const value = values[i] ?? null;
    if (value === null) {
      close(Math.max(i - 1, 0));
      continue;
    }
    if (current === null) {
      start = i;
      current = value;
    } else if (value !== current) {
      close(i);
      start = i;
      current = value;
    }
  }
  if (start >= 0) close(xs.length - 1);
  return runs;
}

/** Seconds of silence after which the line should break even without session data. */
function implicitGapSeconds(bucket: Bucket): number {
  return bucket === 'raw' ? 300 : (BUCKET_MS[bucket] / 1000) * 3;
}

export interface BuildOptions {
  sessions?: readonly SessionRecord[];
  /** Chart width in CSS pixels; drives whether the mean line is downsampled. */
  pxWidth?: number;
  downsample?: boolean;
}

/**
 * Inserts explicit breaks and optionally thins the mean lines.
 *
 * Downsampling is applied to the mean series only. Running it over the min/max envelope
 * would discard exactly the extremes the envelope exists to show.
 */
export function buildChartFrame(frame: SeriesFrame, options: BuildOptions = {}): SeriesFrame {
  const { sessions = [], pxWidth = 800, downsample = true } = options;

  const breaks = new Set<number>();
  for (const session of sessions) {
    if (session.endedMs === null) continue;
    breaks.add(session.endedMs / 1000);
  }

  const gapSeconds = implicitGapSeconds(frame.bucket);
  const t: number[] = [];
  const indices: Array<number | null> = [];

  for (let i = 0; i < frame.t.length; i += 1) {
    const time = frame.t[i]!;
    const previous = i > 0 ? frame.t[i - 1]! : null;

    if (previous !== null) {
      const crossedSessionEnd = [...breaks].some((b) => b > previous && b <= time);
      if (crossedSessionEnd || time - previous > gapSeconds) {
        // A single null row is enough to break the path.
        t.push(previous + Math.min(gapSeconds, (time - previous) / 2));
        indices.push(null);
      }
    }
    t.push(time);
    indices.push(i);
  }

  const project = (column: (number | null)[] | null): (number | null)[] | null => {
    if (!column) return null;
    return indices.map((index) => (index === null ? null : (column[index] ?? null)));
  };

  const out: SeriesFrame = {
    ...frame,
    t,
    tempC: project(frame.tempC),
    tempMinC: project(frame.tempMinC),
    tempMaxC: project(frame.tempMaxC),
    targetC: project(frame.targetC),
    batteryPct: project(frame.batteryPct),
    batteryMinPct: project(frame.batteryMinPct),
    batteryMaxPct: project(frame.batteryMaxPct),
    liquidPct: project(frame.liquidPct),
    liquidState: project(frame.liquidState),
    chargeFrac: project(frame.chargeFrac),
    count: frame.count ? indices.map((index) => (index === null ? 0 : (frame.count![index] ?? 0))) : null,
  };

  // Below roughly four points per pixel, thinning costs more than it saves.
  if (!downsample || out.t.length <= pxWidth * 4) return out;

  const thinned = lttb(out.t, out.tempC ?? [], pxWidth);
  const keep = new Set(thinned.xs);
  const keepIndices: number[] = [];
  for (let i = 0; i < out.t.length; i += 1) {
    if (keep.has(out.t[i]!)) keepIndices.push(i);
  }
  const take = (column: (number | null)[] | null): (number | null)[] | null =>
    column ? keepIndices.map((i) => column[i] ?? null) : null;

  return {
    ...out,
    t: keepIndices.map((i) => out.t[i]!),
    tempC: take(out.tempC),
    tempMinC: take(out.tempMinC),
    tempMaxC: take(out.tempMaxC),
    targetC: take(out.targetC),
    batteryPct: take(out.batteryPct),
    batteryMinPct: take(out.batteryMinPct),
    batteryMaxPct: take(out.batteryMaxPct),
    liquidPct: take(out.liquidPct),
    liquidState: take(out.liquidState),
    chargeFrac: take(out.chargeFrac),
    count: out.count ? keepIndices.map((i) => out.count![i] ?? 0) : null,
  };
}

/** Extracts uPlot data arrays in a fixed order. */
export function toChartData(
  frame: SeriesFrame,
  columns: ReadonlyArray<keyof SeriesFrame>,
): ChartData {
  const series = columns.map((key) => {
    const column = frame[key];
    return Array.isArray(column) ? (column as (number | null)[]) : frame.t.map(() => null);
  });
  return [frame.t, ...series];
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const totalMinutes = Math.round(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatRange(from: Millis, to: Millis): string {
  const span = to - from;
  const fmt = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    ...(span < 3 * 86_400_000 ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
  return `${fmt.format(new Date(from))} – ${fmt.format(new Date(to))}`;
}
