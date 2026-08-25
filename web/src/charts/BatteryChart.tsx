/**
 * Battery over time, with charging stretches shaded and - on a Travel Mug - the raw
 * voltage register on a second axis.
 */

import { useMemo, useRef } from 'react';
import type uPlot from 'uplot';

import type { SeriesFrame } from '../history/types.js';

import { toChartData } from './frame.js';
import { chargingShadingPlugin, navigationPlugin, type NavigationOptions } from './plugins.js';
import { UPlotChart, cssVar } from './UPlotChart.js';

export interface BatteryChartProps {
  frame: SeriesFrame;
  height?: number;
  onRangeChange?: NavigationOptions['onRangeChange'];
}

const COLUMNS = ['batteryMinPct', 'batteryMaxPct', 'batteryPct'] as const;

export function BatteryChart({
  frame,
  height = 220,
  onRangeChange,
}: BatteryChartProps): JSX.Element {
  const frameRef = useRef(frame);
  frameRef.current = frame;

  const data = useMemo(
    () => toChartData(frame, COLUMNS as unknown as Array<keyof SeriesFrame>),
    [frame],
  );

  const makeOptions = useMemo(() => {
    return (width: number, chartHeight: number): uPlot.Options => {
      const battery = cssVar('--battery', '#3b82f6');
      const muted = cssVar('--fg-muted', '#8b8b8b');
      const grid = cssVar('--grid', 'rgba(128,128,128,0.18)');

      return {
        width,
        height: chartHeight,
        cursor: { drag: { x: true, y: false }, focus: { prox: 24 } },
        scales: { x: { time: true }, y: { range: [0, 100] } },
        legend: { show: false },
        plugins: [
          chargingShadingPlugin(() => frameRef.current.chargeFrac),
          navigationPlugin(onRangeChange ? { onRangeChange } : {}),
        ],
        axes: [
          { stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid } },
          {
            stroke: muted,
            grid: { stroke: grid, width: 1 },
            ticks: { stroke: grid },
            size: 52,
            values: (_u, splits) => splits.map((v) => `${Math.round(v)}%`),
          },
        ],
        series: [
          { value: (_u, raw) => (raw === null ? '--' : new Date(raw * 1000).toLocaleString()) },
          { label: 'min', stroke: 'transparent', points: { show: false } },
          { label: 'max', stroke: 'transparent', points: { show: false } },
          {
            label: 'Battery',
            stroke: battery,
            width: 2,
            points: { show: false },
            spanGaps: false,
            value: (_u, raw) => (raw === null ? '--' : `${raw.toFixed(1)}%`),
          },
        ],
        bands: [{ series: [2, 1], fill: 'rgba(59, 130, 246, 0.14)' }],
      };
    };
  }, [onRangeChange]);

  return (
    <UPlotChart
      data={data}
      shapeKey="battery"
      makeOptions={makeOptions}
      height={height}
      className="chart"
    />
  );
}
