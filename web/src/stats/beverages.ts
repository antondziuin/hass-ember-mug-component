/**
 * Beverage segmentation.
 *
 * Deliberately client-side and deliberately not part of any store: this is a heuristic
 * that will be retuned against real data, and baking it into three backends would
 * guarantee three subtly different answers.
 */

import { MAX_GAP_MS } from '../history/constants.js';
import { LiquidState } from '../lib/ember/constants.js';
import type { Millis, Sample } from '../history/types.js';

export interface BeverageConfig {
  /** Liquid level below which the mug counts as empty. */
  emptyPct: number;
  /** Level above which it counts as filled. */
  filledPct: number;
  /** How quickly the level has to rise for it to count as a fill rather than a drift. */
  fillWindowMs: number;
  /** Continuous empty/standby time that ends a beverage. */
  endAfterEmptyMs: number;
}

export const DEFAULT_BEVERAGE_CONFIG: BeverageConfig = {
  emptyPct: 15,
  filledPct: 40,
  fillWindowMs: 5 * 60_000,
  endAfterEmptyMs: 10 * 60_000,
};

export interface Beverage {
  startedMs: Millis;
  endedMs: Millis;
  durationMs: number;
  /** Temperature when the drink was poured. */
  startTempC: number | null;
  peakTempC: number | null;
  /** Time from the fill to the first reading at target, when it got there. */
  timeToTargetMs: number | null;
  msAtPerfect: number;
  targetC: number | null;
}

/** Samples must be ascending by timestamp. */
export function segmentBeverages(
  samples: readonly Sample[],
  config: BeverageConfig = DEFAULT_BEVERAGE_CONFIG,
): Beverage[] {
  const beverages: Beverage[] = [];
  let open: {
    startedMs: Millis;
    startTempC: number | null;
    peak: number | null;
    firstPerfectMs: Millis | null;
    msAtPerfect: number;
    targetC: number | null;
    emptySince: Millis | null;
    lastMs: Millis;
  } | null = null;

  const close = (endedMs: Millis): void => {
    if (!open) return;
    const duration = endedMs - open.startedMs;
    // Anything under a minute is noise, not a drink.
    if (duration >= 60_000) {
      beverages.push({
        startedMs: open.startedMs,
        endedMs,
        durationMs: duration,
        startTempC: open.startTempC,
        peakTempC: open.peak,
        timeToTargetMs:
          open.firstPerfectMs === null ? null : open.firstPerfectMs - open.startedMs,
        msAtPerfect: open.msAtPerfect,
        targetC: open.targetC,
      });
    }
    open = null;
  };

  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i]!;
    const levelPct = sample.liquidDpc === null ? null : sample.liquidDpc / 10;
    const tempC = sample.tempC === null ? null : sample.tempC / 100;
    const previous = i > 0 ? samples[i - 1]! : null;

    const rose =
      previous !== null &&
      previous.liquidDpc !== null &&
      levelPct !== null &&
      previous.liquidDpc / 10 < config.emptyPct &&
      levelPct > config.filledPct &&
      sample.ts - previous.ts <= config.fillWindowMs;

    const startedFilling =
      previous !== null &&
      previous.liquidState !== LiquidState.FILLING &&
      sample.liquidState === LiquidState.FILLING;

    if (!open && (rose || startedFilling)) {
      open = {
        startedMs: sample.ts,
        startTempC: tempC,
        peak: tempC,
        firstPerfectMs: null,
        msAtPerfect: 0,
        targetC: sample.targetC === null ? null : sample.targetC / 100,
        emptySince: null,
        lastMs: sample.ts,
      };
      continue;
    }

    if (!open) continue;

    if (tempC !== null && (open.peak === null || tempC > open.peak)) open.peak = tempC;
    if (sample.liquidState === LiquidState.PERFECT) {
      open.firstPerfectMs ??= sample.ts;
      const next = samples[i + 1];
      if (next) open.msAtPerfect += Math.min(next.ts - sample.ts, MAX_GAP_MS);
    }
    if (open.targetC === null && sample.targetC !== null) open.targetC = sample.targetC / 100;

    const isEmpty =
      (levelPct !== null && levelPct < 10) ||
      sample.liquidState === LiquidState.EMPTY ||
      sample.liquidState === LiquidState.STANDBY;

    if (isEmpty) {
      open.emptySince ??= sample.ts;
      if (sample.ts - open.emptySince >= config.endAfterEmptyMs) {
        close(open.emptySince);
        continue;
      }
    } else {
      open.emptySince = null;
    }

    // A long silence means the app stopped watching, not that the drink continued.
    if (sample.ts - open.lastMs > MAX_GAP_MS) {
      close(open.lastMs);
      continue;
    }
    open.lastMs = sample.ts;
  }

  if (open) close((open as { lastMs: Millis }).lastMs);
  return beverages;
}

export interface BeverageSummary {
  count: number;
  medianDurationMs: number | null;
  medianTimeToTargetMs: number | null;
  medianStartTempC: number | null;
  /** Median local hour of the first drink of each day. */
  medianFirstDrinkHour: number | null;
  weekdayFirstDrinkHour: number | null;
  weekendFirstDrinkHour: number | null;
  perDay: Array<{ day: string; count: number }>;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

export function summariseBeverages(beverages: readonly Beverage[]): BeverageSummary {
  const byDay = new Map<string, Beverage[]>();
  for (const beverage of beverages) {
    const date = new Date(beverage.startedMs);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
      date.getDate(),
    ).padStart(2, '0')}`;
    const list = byDay.get(key);
    if (list) list.push(beverage);
    else byDay.set(key, [beverage]);
  }

  const firstHours: number[] = [];
  const weekdayHours: number[] = [];
  const weekendHours: number[] = [];
  for (const list of byDay.values()) {
    const first = list.reduce((a, b) => (a.startedMs <= b.startedMs ? a : b));
    const date = new Date(first.startedMs);
    const hour = date.getHours() + date.getMinutes() / 60;
    firstHours.push(hour);
    if (date.getDay() === 0 || date.getDay() === 6) weekendHours.push(hour);
    else weekdayHours.push(hour);
  }

  return {
    count: beverages.length,
    medianDurationMs: median(beverages.map((b) => b.durationMs)),
    medianTimeToTargetMs: median(
      beverages.map((b) => b.timeToTargetMs).filter((v): v is number => v !== null),
    ),
    medianStartTempC: median(
      beverages.map((b) => b.startTempC).filter((v): v is number => v !== null),
    ),
    medianFirstDrinkHour: median(firstHours),
    weekdayFirstDrinkHour: median(weekdayHours),
    weekendFirstDrinkHour: median(weekendHours),
    perDay: [...byDay.entries()]
      .map(([day, list]) => ({ day, count: list.length }))
      .sort((a, b) => a.day.localeCompare(b.day)),
  };
}

/**
 * Cooling rate in degrees per minute while off the charger with temperature control off.
 *
 * This is the mug's real insulation performance, and it degrades measurably as the
 * battery ages.
 */
export function coolingRateCPerMin(samples: readonly Sample[]): number | null {
  let totalDrop = 0;
  let totalMs = 0;

  for (let i = 1; i < samples.length; i += 1) {
    const previous = samples[i - 1]!;
    const sample = samples[i]!;
    if (previous.targetC !== null) continue;
    if ((previous.flags & 1) !== 0) continue;
    if (previous.tempC === null || sample.tempC === null) continue;

    const dt = sample.ts - previous.ts;
    if (dt <= 0 || dt > MAX_GAP_MS) continue;
    const drop = previous.tempC - sample.tempC;
    // Only falling temperature counts; a rise means something else was going on.
    if (drop <= 0) continue;
    totalDrop += drop;
    totalMs += dt;
  }

  if (totalMs < 5 * 60_000) return null;
  return totalDrop / 100 / (totalMs / 60_000);
}
