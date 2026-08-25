/**
 * Temperature over time: mean line, min/max envelope, stepped target, state shading.
 */

import { useMemo, useRef } from 'react';
import uPlot from 'uplot';

import { celsiusToFahrenheit } from '../lib/ember/codecs.js';
import { LIQUID_STATE_LABEL, type LiquidState } from '../lib/ember/constants.js';
import type { SeriesFrame } from '../history/types.js';

import { toChartData } from './frame.js';
import {
  navigationPlugin,
  stateShadingPlugin,
  targetBandPlugin,
  type NavigationOptions,
} from './plugins.js';
import { UPlotChart, cssVar } from './UPlotChart.js';

export interface TemperatureChartProps {
  frame: SeriesFrame;
  unit: 'C' | 'F';
  height?: number;
  onRangeChange?: NavigationOptions['onRangeChange'];
}

const COLUMNS = ['tempMinC', 'tempMaxC', 'tempC', 'targetC'] as const;

export function TemperatureChart({
  frame,
  unit,
  height = 300,
  onRangeChange,
}: TemperatureChartProps): JSX.Element {
  // Held in a ref so the plugins read the current frame without rebuilding the plot.
  const frameRef = useRef(frame);
  frameRef.current = frame;

  const data = useMemo(() => {
    const base = toChartData(frame, COLUMNS as unknown as Array<keyof SeriesFrame>);
    if (unit === 'C') return base;
    const [t, ...series] = base;
    return [t, ...series.map((s) => s.map((v) => (v === null ? null : celsiusToFahrenheit(v))))] as typeof base;
  }, [frame, unit]);

  const makeOptions = useMemo(() => {
    return (width: number, chartHeight: number): uPlot.Options => {
      const accent = cssVar('--accent', '#e2725b');
      const muted = cssVar('--fg-muted', '#8b8b8b');
      const grid = cssVar('--grid', 'rgba(128,128,128,0.18)');
      const convert = (v: number): number => (unit === 'F' ? celsiusToFahrenheit(v) : v);

      return {
        width,
        height: chartHeight,
        cursor: { drag: { x: true, y: false }, focus: { prox: 24 } },
        scales: { x: { time: true } },
        legend: { show: false },
        plugins: [
          stateShadingPlugin(() => frameRef.current.liquidState),
          targetBandPlugin(
            () =>
              frameRef.current.targetC?.map((v) => (v === null ? null : convert(v))) ?? null,
            unit === 'F' ? 2.7 : 1.5,
          ),
          navigationPlugin(onRangeChange ? { onRangeChange } : {}),
        ],
        axes: [
          { stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid } },
          {
            stroke: muted,
            grid: { stroke: grid, width: 1 },
            ticks: { stroke: grid },
            size: 52,
            values: (_u, splits) => splits.map((v) => `${Math.round(v)}°`),
          },
        ],
        series: [
          {
            value: (_u, raw) =>
              raw === null ? '--' : new Date(raw * 1000).toLocaleString(),
          },
          { label: 'min', stroke: 'transparent', points: { show: false } },
          { label: 'max', stroke: 'transparent', points: { show: false } },
          {
            label: 'Temperature',
            stroke: accent,
            width: 2,
            points: { show: false },
            // Explicit breaks in the data must render as breaks in the line.
            spanGaps: false,
            value: (_u, raw) => (raw === null ? '--' : `${raw.toFixed(1)}°${unit}`),
          },
          {
            label: 'Target',
            stroke: muted,
            width: 1.5,
            dash: [6, 4],
            points: { show: false },
            spanGaps: false,
            // Target holds its value until changed, so it is drawn as steps.
            paths: uPlot.paths.stepped?.({ align: 1 }),
            value: (_u, raw) => (raw === null ? 'off' : `${raw.toFixed(1)}°${unit}`),
          },
        ],
        // Fills between the hidden min and max series to give the envelope.
        bands: [{ series: [2, 1], fill: withAlpha(accent, 0.16) }],
      };
    };
  }, [unit, onRangeChange]);

  return (
    <UPlotChart
      data={data}
      shapeKey={`temp-${unit}`}
      makeOptions={makeOptions}
      height={height}
      className="chart"
    />
  );
}

function withAlpha(colour: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(colour.trim());
  if (!hex) return colour;
  const n = Number.parseInt(hex[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function stateLabel(state: number | null): string {
  if (state === null) return 'Unknown';
  return LIQUID_STATE_LABEL[state as LiquidState] ?? 'Unknown';
}
