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
import { buildChartFrame } from '../charts/frame.js';
import { pickBucket } from '../history/constants.js';
import type { HistoryStore } from '../history/HistoryStore.js';
import {
  HISTORY_MODES,
  canShiftHistoryWindow,
  formatHistoryCaption,
  isShiftableMode,
  loadHistoryMode,
  resolveHistoryWindow,
  saveHistoryMode,
  sessionOffsetOf,
  type HistoryViewMode,
  type HistoryWindow,
} from '../history/ranges.js';
import type {
  Aggregates,
  Bounds,
  DeviceEvent,
  DeviceId,
  Millis,
  SeriesFrame,
  SessionRecord,
} from '../history/types.js';
import { LIQUID_STATE_LABEL, LiquidState } from '../lib/ember/constants.js';
import { coolingRateCPerMin, segmentBeverages } from '../stats/beverages.js';

import { Card, EmptyState, Spinner } from './components.js';
import { useAppState } from './context.js';
import { EventLog } from './history/EventLog.js';
import { SessionList } from './history/SessionList.js';
import { StatisticsPanel } from './history/StatisticsPanel.js';

interface Loaded {
  frame: SeriesFrame;
  overview: SeriesFrame | null;
  sessions: SessionRecord[];
  allSessions: SessionRecord[];
  events: DeviceEvent[];
  aggregates: Aggregates;
  bounds: Bounds;
  rawForStats: ReturnType<typeof segmentBeverages>;
  coolingRate: number | null;
}

export function HistoryView({ unit }: { unit: 'C' | 'F' }): JSX.Element {
  const state = useAppState();
  const deviceId = useDeviceId();
  const store = useHistoryStore();
  const [mode, setMode] = useState<HistoryViewMode>(() => loadHistoryMode());
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [window, setWindow] = useState<HistoryWindow | null>(null);
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
    async (target: HistoryWindow | null) => {
      if (!store || !deviceId) return;
      setPending(true);
      setError(null);
      try {
        const bounds = await store.bounds(deviceId);
        if (!bounds) {
          setLoaded(null);
          return;
        }

        const now = Date.now();
        const allSessions = await store.listSessions({
          deviceId,
          from: bounds.minTs,
          to: Math.max(bounds.maxTs, now) + 1,
        });

        const resolved =
          target ??
          resolveHistoryWindow({
            mode,
            now,
            bounds,
            sessions: allSessions,
            offset,
            custom: window,
          });

        const bucket = pickBucket(resolved.from, resolved.to, widthRef.current);
        const [frame, sessions, aggregates, events] = await Promise.all([
          store.queryRange({ deviceId, from: resolved.from, to: resolved.to, bucket }),
          store.listSessions({ deviceId, from: resolved.from, to: resolved.to }),
          store.aggregate({ deviceId, from: resolved.from, to: resolved.to }),
          store.queryEvents({ deviceId, from: resolved.from, to: resolved.to, limit: 200 }),
        ]);

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
          allSessions,
          events,
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
    [store, deviceId, mode, offset, window],
  );

  useEffect(() => {
    void load(mode === 'custom' ? window : null);
    // `window` is written by load itself; re-resolve only when the user changes the preset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, deviceId, mode, offset, revision]);

  useEffect(() => {
    if (state.deviceState.connection.status !== 'connected') return undefined;
    const timer = setInterval(() => {
      void load(mode === 'custom' ? window : null);
    }, 30_000);
    return () => clearInterval(timer);
  }, [state.deviceState.connection.status, load, mode, window]);

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

  const shift = loaded
    ? canShiftHistoryWindow({
        mode,
        now: Date.now(),
        bounds: loaded.bounds,
        sessions: loaded.allSessions,
        offset,
        custom: window,
      })
    : { prev: false, next: false };

  const selectMode = (next: HistoryViewMode): void => {
    setMode(next);
    setOffset(0);
    setWindow(null);
    setRevision((value) => value + 1);
    saveHistoryMode(next);
  };

  const zoomTo = (from: Millis, to: Millis): void => {
    setMode('custom');
    setWindow({ from, to });
    void load({ from, to });
  };

  if (!deviceId) {
    return (
      <EmptyState title="No history yet">Connect a mug to start recording.</EmptyState>
    );
  }

  return (
    <div className="stack" ref={hostRef}>
      <Card
        title="History"
        subtitle={window ? formatHistoryCaption(mode, window) : undefined}
        actions={
          <div className="history-toolbar">
            <div className="segmented" role="group" aria-label="Range">
              {HISTORY_MODES.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={mode === preset.id ? 'active' : ''}
                  onClick={() => selectMode(preset.id)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            {isShiftableMode(mode) && (
              <div className="row" style={{ gap: '0.15rem' }}>
                <button
                  type="button"
                  className="ghost icon"
                  aria-label="Previous"
                  title="Previous"
                  disabled={!shift.prev}
                  onClick={() => setOffset((value) => value + 1)}
                >
                  ‹
                </button>
                <button
                  type="button"
                  className="ghost icon"
                  aria-label="Next"
                  title="Next"
                  disabled={!shift.next}
                  onClick={() => setOffset((value) => Math.max(value - 1, 0))}
                >
                  ›
                </button>
              </div>
            )}
            {mode === 'custom' && (
              <button type="button" className="ghost" onClick={() => selectMode('today')}>
                Reset
              </button>
            )}
          </div>
        }
      >
        {error && <p className="field-error">{error}</p>}
        {pending && !loaded && <Spinner label="Loading…" />}
        {!pending && !loaded && !error && (
          <EmptyState title="Nothing recorded yet">
            Readings are saved while the mug is connected and this tab is open.
          </EmptyState>
        )}

        {loaded && chartFrame && (
          <>
            <TemperatureChart
              frame={chartFrame}
              unit={unit}
              onRangeChange={(fromSeconds, toSeconds) => {
                zoomTo(fromSeconds * 1000, toSeconds * 1000);
              }}
            />
            <div className="row between">
              <StateLegend />
              <span
                className="subtle small"
                title="Drag or scroll to zoom · shift+scroll to pan · double-click to reset"
              >
                Drag to zoom · double-click to reset
              </span>
            </div>
            {loaded.overview && window && (
              <BrushStrip
                frame={loaded.overview}
                bounds={loaded.bounds}
                selection={window}
                height={36}
                onSelect={(from, to) => zoomTo(from, to)}
              />
            )}
          </>
        )}
      </Card>

      {loaded && chartFrame && (
        <Card title="Battery">
          <BatteryChart
            frame={chartFrame}
            onRangeChange={(fromSeconds, toSeconds) => {
              zoomTo(fromSeconds * 1000, toSeconds * 1000);
            }}
          />
        </Card>
      )}

      {loaded && window && (
        <div className="history-split">
          <SessionList
            sessions={loaded.sessions}
            selectedId={mode === 'session' ? pickSelectedSession(loaded.sessions) : null}
            onSelect={(session) => {
              setMode('session');
              setOffset(sessionOffsetOf(loaded.allSessions, session.sessionId));
              setWindow(null);
              saveHistoryMode('session');
            }}
          />
          <EventLog events={loaded.events} />
        </div>
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

function pickSelectedSession(sessions: readonly SessionRecord[]): string | null {
  const open = sessions.find((session) => session.endedMs === null);
  if (open) return open.sessionId;
  const newest = [...sessions].sort((a, b) => b.startedMs - a.startedMs)[0];
  return newest?.sessionId ?? null;
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
