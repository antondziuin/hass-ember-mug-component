/**
 * React wrapper around uPlot.
 *
 * The rule that matters for performance: never re-create the plot when the *data*
 * changes, only when the series shape does. Re-creating on every viewport change is the
 * classic mistake and turns a smooth chart into a stuttering one.
 */

import { useEffect, useLayoutEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

import type { ChartData } from './frame.js';

export interface UPlotChartProps {
  data: ChartData;
  /** Changing this key rebuilds the plot. Include anything that alters series or axes. */
  shapeKey: string;
  makeOptions: (width: number, height: number) => uPlot.Options;
  height?: number;
  className?: string;
  onCreate?: (plot: uPlot) => void;
}

export function UPlotChart({
  data,
  shapeKey,
  makeOptions,
  height = 280,
  className,
  onCreate,
}: UPlotChartProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const dataRef = useRef<ChartData>(data);
  const optionsRef = useRef(makeOptions);
  const onCreateRef = useRef(onCreate);

  dataRef.current = data;
  optionsRef.current = makeOptions;
  onCreateRef.current = onCreate;

  // Build (and rebuild only on a shape change).
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const width = host.clientWidth || 600;
    const plot = new uPlot(
      optionsRef.current(width, height),
      dataRef.current as unknown as uPlot.AlignedData,
      host,
    );
    plotRef.current = plot;
    onCreateRef.current?.(plot);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const next = Math.max(Math.floor(entry.contentRect.width), 120);
      plot.setSize({ width: next, height });
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
  }, [shapeKey, height]);

  // Data-only updates go through setData, which keeps the instance alive.
  useEffect(() => {
    plotRef.current?.setData(data as unknown as uPlot.AlignedData);
  }, [data]);

  return <div ref={hostRef} className={className} />;
}

/** Reads a CSS custom property, so charts follow the app's theme rather than hard-coding it. */
export function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}
