/**
 * Charts and statistics over the recorded history.
 *
 * Every rate statistic is shown next to a data-coverage figure. The app only records
 * while the tab is open and the mug is in range, and Chrome throttles background tabs, so
 * "drinks per day" over a period with 30% coverage would otherwise be wrong by roughly
 * three times without anything on screen saying so.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { BatteryChart } from '../charts/BatteryChart.js';
import { BrushStrip } from '../charts/BrushStrip.js';
import { TemperatureChart } from '../charts/TemperatureChart.js';
import { buildChartFrame, formatDuration, formatRange } from '../charts/frame.js';
import { pickBucket } from '../history/constants.js';
import type { HistoryStore } from '../history/HistoryStore.js';
import type {
  Aggregates,
  Bounds,
  DeviceId,
  Millis,
  SeriesFrame,
  SessionRecord,
} from '../history/types.js';
import { celsiusToFahrenheit } from '../lib/ember/codecs.js';
import { LIQUID_STATE_LABEL, LiquidState } from '../lib/ember/constants.js';
import {
  coolingRateCPerMin,
  segmentBeverages,
  summariseBeverages,
} from '../stats/beverages.js';

import { Card, EmptyState, Spinner, Stat } from './components.js';
import { useAppState } from './context.js';

const RANGES = [
  { id: '24h', label: '24 hours', ms: 86_400_000 },
  { id: '7d', label: '7 days', ms: 7 * 86_400_000 },
  { id: '30d', label: '30 days', ms: 30 * 86_400_000 },
  { id: 'all', label: 'All time', ms: Number.POSITIVE_INFINITY },
] as const;

interface Loaded {
  frame: SeriesFrame;
  overview: SeriesFrame | null;
  sessions: SessionRecord[];
  aggregates: Aggregates;
  bounds: Bounds;
  rawForStats: ReturnType<typeof segmentBeverages>;
  coolingRate: number | null;
}

export function HistoryView({ unit }: { unit: 'C' | 'F' }): JSX.Element {
  const state = useAppState();
  const deviceId = useDeviceId();
  const store = useHistoryStore();
  const [rangeId, setRangeId] = useState<(typeof RANGES)[number]['id']>('24h');
  const [window, setWindow] = useState<{ from: Millis; to: Millis } | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const widthRef = useRef(900);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const observer = new ResizeObserver(() => {
      widthRef.current = host.clientWidth || 900;
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const load = useCallback(
    async (target: { from: Millis; to: Millis } | null) => {
      if (!store || !deviceId) return;
      setPending(true);
      setError(null);
      try {
        const bounds = await store.bounds(deviceId);
        if (!bounds) {
          setLoaded(null);
          return;
        }

        const range = RANGES.find((r) => r.id === rangeId)!;
        const resolved =
          target ??
          (range.ms === Number.POSITIVE_INFINITY
            ? { from: bounds.minTs, to: bounds.maxTs + 1 }
            : { from: Math.max(bounds.maxTs - range.ms, bounds.minTs), to: bounds.maxTs + 1 });

        const bucket = pickBucket(resolved.from, resolved.to, widthRef.current);
        const [frame, sessions, aggregates] = await Promise.all([
          store.queryRange({ deviceId, from: resolved.from, to: resolved.to, bucket }),
          store.listSessions({ deviceId, from: resolved.from, to: resolved.to }),
          store.aggregate({ deviceId, from: resolved.from, to: resolved.to }),
        ]);

        // The overview strip always shows everything, so the selection has context.
        const overview =
          bounds.maxTs - bounds.minTs > 0
            ? await store.queryRange({
                deviceId,
                from: bounds.minTs,
                to: bounds.maxTs + 1,
                bucket: '1d',
                fields: ['tempC'],
              })
            : null;

        // Beverage segmentation and the cooling rate need raw rows, not buckets.
        const raw = await store.queryRange({
          deviceId,
          from: resolved.from,
          to: resolved.to,
          bucket: 'raw',
          limit: 40_000,
        });
        const rawSamples = frameToSamples(deviceId, raw);

        setWindow(resolved);
        setLoaded({
          frame,
          overview,
          sessions,
          aggregates,
          bounds,
          rawForStats: segmentBeverages(rawSamples),
          coolingRate: coolingRateCPerMin(rawSamples),
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPending(false);
      }
    },
    [store, deviceId, rangeId],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  // Refresh while connected, so the chart follows the mug rather than going stale.
  useEffect(() => {
    if (state.deviceState.connection.status !== 'connected') return undefined;
    const timer = setInterval(() => void load(window), 30_000);
    return () => clearInterval(timer);
  }, [state.deviceState.connection.status, load, window]);

  const chartFrame = useMemo(
    () =>
      loaded
        ? buildChartFrame(loaded.frame, {
            sessions: loaded.sessions,
            pxWidth: widthRef.current,
          })
        : null,
    [loaded],
  );

  if (!deviceId) {
    return (
      <EmptyState title="No history yet">
        Connect the mug once and readings will start being recorded.
      </EmptyState>
    );
  }

  return (
    <div className="stack" ref={hostRef}>
      <Card
        title="History"
        subtitle={window ? formatRange(window.from, window.to) : undefined}
        actions={
          <div className="segmented" role="group" aria-label="Range">
            {RANGES.map((range) => (
              <button
                key={range.id}
                type="button"
                className={rangeId === range.id ? 'active' : ''}
                onClick={() => {
                  setRangeId(range.id);
                  setWindow(null);
                }}
              >
                {range.label}
              </button>
            ))}
          </div>
        }
      >
        {error && <p className="field-error">{error}</p>}
        {pending && !loaded && <Spinner label="Reading history…" />}
        {!pending && !loaded && !error && (
          <EmptyState title="Nothing recorded yet">
            Readings are stored while the mug is connected and this tab is open.
          </EmptyState>
        )}

        {loaded && chartFrame && (
          <>
            <TemperatureChart
              frame={chartFrame}
              unit={unit}
              onRangeChange={(fromSeconds, toSeconds) => {
                void load({ from: fromSeconds * 1000, to: toSeconds * 1000 });
              }}
            />
            <p className="muted small">
              Drag to zoom · scroll to zoom around the cursor · shift+scroll to pan · double-click
              to reset
            </p>
            {loaded.overview && window && (
              <BrushStrip
                frame={loaded.overview}
                bounds={loaded.bounds}
                selection={window}
                onSelect={(from, to) => void load({ from, to })}
              />
            )}
            <StateLegend />
          </>
        )}
      </Card>

      {loaded && chartFrame && (
        <Card title="Battery">
          <BatteryChart
            frame={chartFrame}
            onRangeChange={(fromSeconds, toSeconds) => {
              void load({ from: fromSeconds * 1000, to: toSeconds * 1000 });
            }}
          />
        </Card>
      )}

      {loaded && window && (
        <StatisticsPanel
          aggregates={loaded.aggregates}
          beverages={loaded.rawForStats}
          coolingRate={loaded.coolingRate}
          unit={unit}
          window={window}
        />
      )}
    </div>
  );
}

function StateLegend(): JSX.Element {
  const shown = [
    LiquidState.HEATING,
    LiquidState.PERFECT,
    LiquidState.COOLING,
    LiquidState.FILLING,
    LiquidState.WARM_NO_CONTROL,
  ];
  return (
    <div className="legend">
      {shown.map((state) => (
        <span key={state} className="legend-item">
          <span className={`swatch swatch-${state}`} />
          {LIQUID_STATE_LABEL[state]}
        </span>
      ))}
    </div>
  );
}

function StatisticsPanel({
  aggregates,
  beverages,
  coolingRate,
  unit,
  window,
}: {
  aggregates: Aggregates;
  beverages: ReturnType<typeof segmentBeverages>;
  coolingRate: number | null;
  unit: 'C' | 'F';
  window: { from: Millis; to: Millis };
}): JSX.Element {
  const summary = useMemo(() => summariseBeverages(beverages), [beverages]);
  const days = Math.max((window.to - window.from) / 86_400_000, 1 / 24);
  const observedDays = Math.max(aggregates.observedMs / 86_400_000, 1e-6);

  const perfectMs = aggregates.msPerState[LiquidState.PERFECT] ?? 0;
  const perfectShare =
    aggregates.msLiquidPresent > 0 ? (perfectMs / aggregates.msLiquidPresent) * 100 : null;

  const temp = (celsius: number | null): string =>
    celsius === null
      ? '--'
      : `${(unit === 'F' ? celsiusToFahrenheit(celsius) : celsius).toFixed(1)}°${unit}`;

  const hour = (value: number | null): string => {
    if (value === null) return '--';
    const h = Math.floor(value);
    const m = Math.round((value - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  };

  const longestPerfect = beverages.reduce((max, b) => Math.max(max, b.msAtPerfect), 0);
  const cycles = aggregates.battery.dischargedPct / 100;
  const favouriteTarget = aggregates.targetHistogram.reduce<{ targetC: number; ms: number } | null>(
    (best, bin) => (best === null || bin.ms > best.ms ? bin : best),
    null,
  );

  return (
    <>
      <Card
        title="Coverage"
        subtitle="How much of this period the app was actually watching."
      >
        <div className="coverage">
          <div className="coverage-bar">
            <span style={{ width: `${Math.min(aggregates.coverage * 100, 100)}%` }} />
          </div>
          <p className="muted">
            Recorded for {formatDuration(aggregates.observedMs)} of{' '}
            {formatDuration(window.to - window.from)} —{' '}
            <strong>{(aggregates.coverage * 100).toFixed(0)}%</strong>. Per-day figures below are
            counted over the recorded time only, so treat them as a floor rather than a total.
          </p>
        </div>
      </Card>

      <Card title="Thermal">
        <div className="readings">
          <Stat
            label="Time at perfect temperature"
            value={formatDuration(perfectMs)}
            hint={perfectShare === null ? undefined : `${perfectShare.toFixed(0)}% of drinking time`}
            tone="good"
          />
          <Stat
            label="Time to reach target"
            value={
              summary.medianTimeToTargetMs === null
                ? '--'
                : formatDuration(summary.medianTimeToTargetMs)
            }
            hint="median, from filling"
          />
          <Stat
            label="Cooling rate"
            value={coolingRate === null ? '--' : `${coolingRate.toFixed(2)} °C/min`}
            hint="off charger, control off"
          />
          <Stat
            label="Favourite target"
            value={favouriteTarget === null ? '--' : temp(favouriteTarget.targetC)}
            hint={favouriteTarget === null ? undefined : formatDuration(favouriteTarget.ms)}
          />
          <Stat
            label="Average pour temperature"
            value={temp(summary.medianStartTempC)}
            hint="median at fill"
          />
          <Stat label="Longest perfect streak" value={formatDuration(longestPerfect)} />
          <Stat label="Hottest reading" value={temp(aggregates.temp.maxC)} />
        </div>
      </Card>

      <Card title="Drinks">
        <div className="readings">
          <Stat
            label="Drinks recorded"
            value={summary.count}
            hint={`${(summary.count / observedDays).toFixed(1)} per recorded day`}
          />
          <Stat
            label="Average drink"
            value={
              summary.medianDurationMs === null ? '--' : formatDuration(summary.medianDurationMs)
            }
            hint="median, fill to empty"
          />
          <Stat
            label="First drink"
            value={hour(summary.medianFirstDrinkHour)}
            hint={
              summary.weekdayFirstDrinkHour === null
                ? undefined
                : `weekdays ${hour(summary.weekdayFirstDrinkHour)} · weekends ${hour(
                    summary.weekendFirstDrinkHour,
                  )}`
            }
          />
          <Stat label="Sessions" value={aggregates.sessionCount} />
        </div>
      </Card>

      <Card title="Power">
        <div className="readings">
          <Stat
            label="Battery cycles"
            value={`≈ ${cycles.toFixed(1)}`}
            hint="total discharge ÷ 100%"
          />
          <Stat label="Time on charger" value={formatDuration(aggregates.msOnCharger)} />
          <Stat
            label="Off-charger time per day"
            value={formatDuration(
              Math.max(aggregates.observedMs - aggregates.msOnCharger, 0) / observedDays,
            )}
          />
          <Stat
            label="Temperature control on"
            value={formatDuration(aggregates.msTempControlOn)}
            hint={`${((aggregates.msTempControlOn / Math.max(aggregates.observedMs, 1)) * 100).toFixed(0)}% of recorded time`}
          />
        </div>
        <p className="muted small">
          Energy use is deliberately not shown: the mug has no current sensor, so any figure would
          be invented. Averaged over {days.toFixed(1)} days of wall clock.
        </p>
      </Card>
    </>
  );
}

function useDeviceId(): DeviceId | null {
  const state = useAppState();
  return state.recorder?.deviceId ?? null;
}

function useHistoryStore(): HistoryStore | null {
  return useAppState().historyStore;
}

/** Rebuilds sample rows from a raw frame, for the statistics that need them. */
function frameToSamples(
  deviceId: DeviceId,
  frame: SeriesFrame,
): Array<{
  deviceId: DeviceId;
  ts: Millis;
  sessionId: null;
  tempC: number | null;
  targetC: number | null;
  batteryDpc: number | null;
  liquidDpc: number | null;
  liquidState: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | null;
  batteryMv: null;
  flags: number;
}> {
  return frame.t.map((seconds, i) => ({
    deviceId,
    ts: Math.round(seconds * 1000),
    sessionId: null,
    tempC: valueAt(frame.tempC, i, 100),
    targetC: valueAt(frame.targetC, i, 100),
    batteryDpc: valueAt(frame.batteryPct, i, 10),
    liquidDpc: valueAt(frame.liquidPct, i, 10),
    liquidState: (frame.liquidState?.[i] ?? null) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | null,
    batteryMv: null,
    flags: (frame.chargeFrac?.[i] ?? 0) > 0.5 ? 1 : 0,
  }));
}

function valueAt(column: (number | null)[] | null, index: number, scale: number): number | null {
  const value = column?.[index];
  return value === null || value === undefined ? null : Math.round(value * scale);
}
