/**
 * uPlot plugins: background shading, the target band, and wheel/pinch navigation.
 */

import type uPlot from 'uplot';

import { runLengths, type RunLength } from './frame.js';
import { LiquidState } from '../lib/ember/constants.js';

/** Background tint per liquid state. Standby and empty are left unpainted. */
export const STATE_COLOURS: Readonly<Record<number, string>> = {
  [LiquidState.FILLING]: 'rgba(20, 184, 166, 0.16)',
  [LiquidState.COLD_NO_CONTROL]: 'rgba(100, 116, 139, 0.14)',
  [LiquidState.COOLING]: 'rgba(59, 130, 246, 0.16)',
  [LiquidState.HEATING]: 'rgba(245, 158, 11, 0.18)',
  [LiquidState.PERFECT]: 'rgba(16, 185, 129, 0.16)',
  [LiquidState.WARM_NO_CONTROL]: 'rgba(148, 163, 184, 0.14)',
};

const MAX_RECTS = 2000;

/**
 * Paints state bands behind the series.
 *
 * `drawClear` fires after the canvas is cleared and before the series are drawn, which is
 * exactly where a background belongs.
 */
export function stateShadingPlugin(getStates: () => (number | null)[] | null): uPlot.Plugin {
  return {
    hooks: {
      drawClear: (u: uPlot) => {
        const states = getStates();
        if (!states) return;
        const xs = u.data[0] as number[];
        const runs = runLengths(xs, states).filter((run) => STATE_COLOURS[run.value]);
        if (runs.length === 0) return;

        const ctx = u.ctx;
        ctx.save();
        ctx.beginPath();
        ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
        ctx.clip();

        let painted = 0;
        for (const run of runs) {
          if (painted >= MAX_RECTS) break;
          const left = u.valToPos(run.from, 'x', true);
          const right = u.valToPos(run.to, 'x', true);
          const width = Math.max(right - left, 1);
          // Sub-pixel bands are invisible anyway and just cost fill calls.
          if (width < 0.75) continue;
          ctx.fillStyle = STATE_COLOURS[run.value]!;
          ctx.fillRect(left, u.bbox.top, width, u.bbox.height);
          painted += 1;
        }
        ctx.restore();
      },
    },
  };
}

/**
 * Draws a tolerance ribbon around the target temperature, one span per stretch of
 * constant target. Nothing is drawn where temperature control was off, which is why the
 * target is stored as null rather than as the device's zero.
 */
export function targetBandPlugin(
  getTargets: () => (number | null)[] | null,
  toleranceC = 1.5,
  colour = 'rgba(16, 185, 129, 0.12)',
): uPlot.Plugin {
  return {
    hooks: {
      drawClear: (u: uPlot) => {
        const targets = getTargets();
        if (!targets) return;
        const xs = u.data[0] as number[];
        const runs: Array<RunLength<number>> = runLengths(xs, targets);
        if (runs.length === 0) return;

        const ctx = u.ctx;
        ctx.save();
        ctx.beginPath();
        ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
        ctx.clip();
        ctx.fillStyle = colour;

        for (const run of runs) {
          const left = u.valToPos(run.from, 'x', true);
          const right = u.valToPos(run.to, 'x', true);
          const top = u.valToPos(run.value + toleranceC, 'y', true);
          const bottom = u.valToPos(run.value - toleranceC, 'y', true);
          ctx.fillRect(left, top, Math.max(right - left, 1), Math.max(bottom - top, 1));
        }
        ctx.restore();
      },
    },
  };
}

export interface NavigationOptions {
  onRangeChange?: (fromSeconds: number, toSeconds: number) => void;
  minSpanSeconds?: number;
}

/**
 * Wheel to zoom around the cursor, shift+wheel to pan, double-click to reset.
 *
 * uPlot handles drag-to-zoom itself; this adds the rest, which is what makes an all-time
 * chart navigable.
 */
export function navigationPlugin(options: NavigationOptions = {}): uPlot.Plugin {
  const minSpan = options.minSpanSeconds ?? 60;
  let cleanup: (() => void) | null = null;

  return {
    hooks: {
      ready: (u: uPlot) => {
        const over = u.over;

        const onWheel = (event: WheelEvent): void => {
          event.preventDefault();
          const rect = over.getBoundingClientRect();
          const scale = u.scales.x;
          const min = scale?.min ?? 0;
          const max = scale?.max ?? 1;
          const span = max - min;

          if (event.shiftKey) {
            const shift = (event.deltaY / rect.width) * span;
            u.setScale('x', { min: min + shift, max: max + shift });
            options.onRangeChange?.(min + shift, max + shift);
            return;
          }

          const factor = event.deltaY < 0 ? 0.8 : 1.25;
          const nextSpan = Math.max(span * factor, minSpan);
          // Anchor on the cursor so zooming feels like it is aimed at what you look at.
          const anchor = min + ((event.clientX - rect.left) / rect.width) * span;
          const leftShare = (anchor - min) / span;
          const nextMin = anchor - nextSpan * leftShare;
          const nextMax = nextMin + nextSpan;
          u.setScale('x', { min: nextMin, max: nextMax });
          options.onRangeChange?.(nextMin, nextMax);
        };

        const onDoubleClick = (): void => {
          const xs = u.data[0] as number[];
          if (xs.length === 0) return;
          const min = xs[0]!;
          const max = xs[xs.length - 1]!;
          u.setScale('x', { min, max });
          options.onRangeChange?.(min, max);
        };

        over.addEventListener('wheel', onWheel, { passive: false });
        over.addEventListener('dblclick', onDoubleClick);
        cleanup = () => {
          over.removeEventListener('wheel', onWheel);
          over.removeEventListener('dblclick', onDoubleClick);
        };
      },
      destroy: () => {
        cleanup?.();
        cleanup = null;
      },
    },
  };
}

/** Shades stretches where the device was on its charger. */
export function chargingShadingPlugin(
  getChargeFrac: () => (number | null)[] | null,
  colour = 'rgba(16, 185, 129, 0.14)',
): uPlot.Plugin {
  return {
    hooks: {
      drawClear: (u: uPlot) => {
        const fractions = getChargeFrac();
        if (!fractions) return;
        const xs = u.data[0] as number[];
        // Collapse to a boolean first, so a bucket that was mostly on the charger counts.
        const onCharger = fractions.map((f) => (f === null ? null : f > 0.5 ? 1 : null));
        const runs = runLengths(xs, onCharger);

        const ctx = u.ctx;
        ctx.save();
        ctx.beginPath();
        ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
        ctx.clip();
        ctx.fillStyle = colour;
        for (const run of runs.slice(0, MAX_RECTS)) {
          const left = u.valToPos(run.from, 'x', true);
          const right = u.valToPos(run.to, 'x', true);
          ctx.fillRect(left, u.bbox.top, Math.max(right - left, 1), u.bbox.height);
        }
        ctx.restore();
      },
    },
  };
}
