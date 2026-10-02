import { useMemo } from 'react';

import { formatDuration } from '../../charts/frame.js';
import type { Aggregates, Millis } from '../../history/types.js';
import { celsiusToFahrenheit } from '../../lib/ember/codecs.js';
import { LiquidState } from '../../lib/ember/constants.js';
import { segmentBeverages, summariseBeverages } from '../../stats/beverages.js';

import { Card, Stat } from '../components.js';

export function StatisticsPanel({
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

  const longestPerfect = beverages.reduce((max, drink) => Math.max(max, drink.msAtPerfect), 0);
  const cycles = aggregates.battery.dischargedPct / 100;
  const favouriteTarget = aggregates.targetHistogram.reduce<{ targetC: number; ms: number } | null>(
    (best, bin) => (best === null || bin.ms > best.ms ? bin : best),
    null,
  );

  const coverage = Math.min(aggregates.coverage * 100, 100);

  return (
    <Card
      title="Statistics"
      subtitle={`${aggregates.sessionCount} session${aggregates.sessionCount === 1 ? '' : 's'} over ${days.toFixed(1)} days`}
    >
      <div className="coverage" title="Rates count recorded time only, so treat them as a floor.">
        <div className="row between small">
          <span className="muted">Coverage</span>
          <span>
            {formatDuration(aggregates.observedMs)} of {formatDuration(window.to - window.from)} ·{' '}
            <strong>{coverage.toFixed(0)}%</strong>
          </span>
        </div>
        <div className="coverage-bar">
          <span style={{ width: `${coverage}%` }} />
        </div>
      </div>

      <section className="stat-group">
        <h3>Temperature</h3>
        <div className="readings">
          <Stat
            label="At perfect"
            value={formatDuration(perfectMs)}
            hint={perfectShare === null ? undefined : `${perfectShare.toFixed(0)}% of drinking time`}
            tone="good"
          />
          <Stat
            label="Time to target"
            value={
              summary.medianTimeToTargetMs === null ? '--' : formatDuration(summary.medianTimeToTargetMs)
            }
            hint="median"
          />
          <Stat
            label="Cooling rate"
            value={coolingRate === null ? '--' : `${coolingRate.toFixed(2)}°/min`}
            hint="off charger"
          />
          <Stat
            label="Favourite target"
            value={favouriteTarget === null ? '--' : temp(favouriteTarget.targetC)}
          />
          <Stat label="Pour temperature" value={temp(summary.medianStartTempC)} hint="median" />
          <Stat label="Longest perfect" value={formatDuration(longestPerfect)} />
          <Stat label="Hottest" value={temp(aggregates.temp.maxC)} />
        </div>
      </section>

      <section className="stat-group">
        <h3>Drinks</h3>
        <div className="readings">
          <Stat
            label="Drinks"
            value={summary.count}
            hint={`${(summary.count / observedDays).toFixed(1)} per day`}
          />
          <Stat
            label="Average drink"
            value={summary.medianDurationMs === null ? '--' : formatDuration(summary.medianDurationMs)}
            hint="fill to empty"
          />
          <Stat
            label="First drink"
            value={hour(summary.medianFirstDrinkHour)}
            hint={
              summary.weekdayFirstDrinkHour === null
                ? undefined
                : `weekday ${hour(summary.weekdayFirstDrinkHour)} · weekend ${hour(
                    summary.weekendFirstDrinkHour,
                  )}`
            }
          />
        </div>
      </section>

      <section className="stat-group">
        <h3>Power</h3>
        <div className="readings">
          <Stat label="Battery cycles" value={`≈ ${cycles.toFixed(1)}`} />
          <Stat label="On charger" value={formatDuration(aggregates.msOnCharger)} />
          <Stat
            label="Off charger / day"
            value={formatDuration(Math.max(aggregates.observedMs - aggregates.msOnCharger, 0) / observedDays)}
          />
          <Stat
            label="Heating on"
            value={formatDuration(aggregates.msTempControlOn)}
            hint={`${((aggregates.msTempControlOn / Math.max(aggregates.observedMs, 1)) * 100).toFixed(0)}% of recorded`}
          />
        </div>
      </section>
    </Card>
  );
}
