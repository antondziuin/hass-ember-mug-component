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

  return (
    <>
      <Card title="Coverage" subtitle="How much of this period the app was actually watching.">
        <div className="coverage">
          <div className="coverage-bar">
            <span style={{ width: `${Math.min(aggregates.coverage * 100, 100)}%` }} />
          </div>
          <p className="muted">
            Recorded for {formatDuration(aggregates.observedMs)} of {formatDuration(window.to - window.from)}{' '}
            — <strong>{(aggregates.coverage * 100).toFixed(0)}%</strong>. Per-day figures below are
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
              summary.medianTimeToTargetMs === null ? '--' : formatDuration(summary.medianTimeToTargetMs)
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
          <Stat label="Average pour temperature" value={temp(summary.medianStartTempC)} hint="median at fill" />
          <Stat label="Longest perfect streak" value={formatDuration(longestPerfect)} />
          <Stat label="Hottest reading" value={temp(aggregates.temp.maxC)} />
        </div>
      </Card>

      <Card
        title="Drinks"
        subtitle="Fill-to-empty cycles inferred from liquid level. Not the same as a Bluetooth session."
      >
        <div className="readings">
          <Stat
            label="Drinks recorded"
            value={summary.count}
            hint={`${(summary.count / observedDays).toFixed(1)} per recorded day`}
          />
          <Stat
            label="Average drink"
            value={summary.medianDurationMs === null ? '--' : formatDuration(summary.medianDurationMs)}
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
        </div>
      </Card>

      <Card
        title="Power"
        subtitle={`${aggregates.sessionCount} Bluetooth session${aggregates.sessionCount === 1 ? '' : 's'} in this window.`}
      >
        <div className="readings">
          <Stat
            label="Battery cycles"
            value={`≈ ${cycles.toFixed(1)}`}
            hint="total discharge ÷ 100%"
          />
          <Stat label="Time on charger" value={formatDuration(aggregates.msOnCharger)} />
          <Stat
            label="Off-charger time per day"
            value={formatDuration(Math.max(aggregates.observedMs - aggregates.msOnCharger, 0) / observedDays)}
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
