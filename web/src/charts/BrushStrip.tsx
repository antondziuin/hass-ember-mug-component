/**
 * All-time overview strip with a draggable selection.
 *
 * This is the affordance that makes "all time" navigable at all - without it, getting
 * from three years back to this morning is a chore of repeated zooming.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { Millis, SeriesFrame } from '../history/types.js';

export interface BrushStripProps {
  /** Daily overview of the entire history. */
  frame: SeriesFrame;
  bounds: { minTs: Millis; maxTs: Millis };
  selection: { from: Millis; to: Millis };
  onSelect: (from: Millis, to: Millis) => void;
  height?: number;
}

export function BrushStrip({
  frame,
  bounds,
  selection,
  onSelect,
  height = 56,
}: BrushStripProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drag, setDrag] = useState<{ startX: number; currentX: number } | null>(null);

  const span = Math.max(bounds.maxTs - bounds.minTs, 1);
  const toFraction = useCallback(
    (ts: Millis) => Math.min(Math.max((ts - bounds.minTs) / span, 0), 1),
    [bounds.minTs, span],
  );

  // Redraw on data, size or theme change.
  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return undefined;

    const draw = (): void => {
      const width = host.clientWidth;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const temps = frame.tempC ?? [];
      const values = temps.filter((v): v is number => v !== null);
      if (values.length === 0) return;
      const min = Math.min(...values);
      const max = Math.max(...values);
      const range = Math.max(max - min, 1);

      const style = getComputedStyle(document.documentElement);
      ctx.strokeStyle = style.getPropertyValue('--accent').trim() || '#e2725b';
      ctx.lineWidth = 1.25;
      ctx.beginPath();

      let started = false;
      for (let i = 0; i < frame.t.length; i += 1) {
        const value = temps[i];
        if (value === null || value === undefined) {
          started = false;
          continue;
        }
        const x = toFraction(frame.t[i]! * 1000) * width;
        const y = height - 6 - ((value - min) / range) * (height - 12);
        if (started) ctx.lineTo(x, y);
        else {
          ctx.moveTo(x, y);
          started = true;
        }
      }
      ctx.stroke();
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(host);
    return () => observer.disconnect();
  }, [frame, height, toFraction]);

  const positionFromEvent = (clientX: number): number => {
    const host = hostRef.current;
    if (!host) return 0;
    const rect = host.getBoundingClientRect();
    return Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
  };

  const commit = (a: number, b: number): void => {
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    // A click rather than a drag: treat it as "show me a day around here".
    if (hi - lo < 0.005) {
      const centre = bounds.minTs + lo * span;
      const half = Math.min(span / 2, 12 * 3_600_000);
      onSelect(Math.max(centre - half, bounds.minTs), Math.min(centre + half, bounds.maxTs));
      return;
    }
    onSelect(bounds.minTs + lo * span, bounds.minTs + hi * span);
  };

  const selectionLeft = toFraction(selection.from) * 100;
  const selectionWidth = Math.max((toFraction(selection.to) - toFraction(selection.from)) * 100, 0.6);

  return (
    <div
      ref={hostRef}
      className="brush"
      style={{ height }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        const x = positionFromEvent(event.clientX);
        setDrag({ startX: x, currentX: x });
      }}
      onPointerMove={(event) => {
        if (!drag) return;
        setDrag({ ...drag, currentX: positionFromEvent(event.clientX) });
      }}
      onPointerUp={(event) => {
        if (!drag) return;
        const end = positionFromEvent(event.clientX);
        setDrag(null);
        commit(drag.startX, end);
      }}
      onPointerCancel={() => setDrag(null)}
      role="slider"
      aria-label="History range"
      aria-valuemin={bounds.minTs}
      aria-valuemax={bounds.maxTs}
      aria-valuenow={selection.from}
      tabIndex={0}
    >
      <canvas ref={canvasRef} />
      <div
        className="brush-selection"
        style={
          drag
            ? {
                left: `${Math.min(drag.startX, drag.currentX) * 100}%`,
                width: `${Math.abs(drag.currentX - drag.startX) * 100}%`,
              }
            : { left: `${selectionLeft}%`, width: `${selectionWidth}%` }
        }
      />
    </div>
  );
}
