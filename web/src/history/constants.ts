/**
 * Shared numeric policy for the history layer.
 *
 * Everything here has to be identical across the IndexedDB, SQLite and Postgres
 * implementations, otherwise two screens will quietly disagree about how long the coffee
 * was at the right temperature.
 */

import type { Bucket, Millis } from './types.js';

/**
 * Longest interval that may be credited to the state observed at its start.
 *
 * Without this clamp, one overnight disconnect while the mug sat at "perfect" is scored
 * as eight hours at perfect temperature. Every time-weighted aggregate, in every backend,
 * must use this constant.
 */
export const MAX_GAP_MS = 120_000;

/**
 * Intervals are left-attributed: `[ts, tsNext)` belongs to the state observed *at* `ts`.
 * Right attribution would credit a new state with time before it existed.
 */
export const INTERVAL_ATTRIBUTION = 'left' as const;

export const APP_VERSION = '0.1.0';

/** Liquid level at or above this counts as "liquid present" for the statistics. */
export const LIQUID_PRESENT_DPC = 100; // 10.0 %

/** Target-temperature histogram bin width, in hundredths of a degree. */
export const TARGET_HISTOGRAM_BIN_CENTI_C = 50; // 0.5 C

export const LIQUID_STATE_COUNT = 8;

/** Ladder used to choose a bucket for a viewport. Must stay ascending. */
export const BUCKET_LADDER: ReadonlyArray<readonly [Bucket, number]> = [
  ['raw', 0],
  ['1m', 60_000],
  ['5m', 300_000],
  ['1h', 3_600_000],
  ['1d', 86_400_000],
];

/** Target points per CSS pixel. Two keeps min/max detail without oversampling. */
export const POINTS_PER_PIXEL = 2;

/**
 * Picks the coarsest bucket that still gives roughly two points per pixel.
 *
 * This is what makes an all-time chart fast: cost becomes a function of the viewport
 * width rather than of how much history exists.
 */
export function pickBucket(from: Millis, to: Millis, pxWidth: number): Bucket {
  const width = Math.max(pxWidth, 320);
  const msPerPx = (to - from) / width;
  const target = msPerPx / POINTS_PER_PIXEL;
  for (const [bucket, ms] of BUCKET_LADDER) {
    if (ms >= target) return bucket;
  }
  return '1d';
}

/** Default row cap for a single range query. */
export const DEFAULT_QUERY_LIMIT = 20_000;

export const MAX_BATCH_ROWS = {
  indexeddb: 5_000,
  server: 1_000,
  supabase: 1_000,
} as const;
