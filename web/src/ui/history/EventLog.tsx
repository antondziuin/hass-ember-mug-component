import type { DeviceEvent, EventType } from '../../history/types.js';
import { LIQUID_STATE_LABEL, LiquidState } from '../../lib/ember/constants.js';

import { Card, EmptyState } from '../components.js';

const HIDDEN: ReadonlySet<EventType> = new Set([
  'visibility_hidden',
  'visibility_visible',
  'session_start',
  'session_end',
]);

const EVENT_LABEL: Partial<Record<EventType, string>> = {
  state_change: 'State',
  charger_on: 'On charger',
  charger_off: 'Off charger',
  target_change: 'Target',
  temp_control_on: 'Heat on',
  temp_control_off: 'Heat off',
  liquid_filled: 'Filled',
  liquid_emptied: 'Emptied',
  battery_low: 'Battery low',
  battery_full: 'Battery full',
  unit_change: 'Display unit',
  led_change: 'LED',
  name_change: 'Name',
  firmware_change: 'Firmware',
  device_added: 'Device added',
  note: 'Note',
};

export function EventLog({ events }: { events: readonly DeviceEvent[] }): JSX.Element {
  const shown = [...events]
    .filter((event) => !HIDDEN.has(event.type))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 80);

  return (
    <Card title="Events" subtitle="Fills, empties, charger and target changes in this window.">
      {shown.length === 0 ? (
        <EmptyState title="No events in this window">
          Discrete changes are stored alongside the temperature samples.
        </EmptyState>
      ) : (
        <ul className="timeline">
          {shown.map((event) => (
            <li key={event.eventId} className="timeline-static">
              <span className="timeline-when">{formatWhen(event.ts)}</span>
              <span className="timeline-title">{EVENT_LABEL[event.type] ?? event.type}</span>
              <span className="timeline-meta">{describeEvent(event)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function describeEvent(event: DeviceEvent): string {
  if (event.type === 'state_change') {
    const from = labelState(event.numA);
    const to = labelState(event.numB);
    if (from && to) return `${from} → ${to}`;
    return to ?? from ?? '';
  }
  if ((event.type === 'target_change' || event.type === 'temp_control_on') && event.numB !== null) {
    return `${event.numB.toFixed(1)}°C`;
  }
  if (event.textA) return event.textA;
  return '';
}

function labelState(code: number | null): string | null {
  if (code === null) return null;
  return LIQUID_STATE_LABEL[code as LiquidState] ?? null;
}

function formatWhen(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms));
}
