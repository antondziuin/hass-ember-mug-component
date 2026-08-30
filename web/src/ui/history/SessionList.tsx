import { formatDuration } from '../../charts/frame.js';
import type { SessionEndReason, SessionRecord } from '../../history/types.js';

import { Card, EmptyState } from '../components.js';

const END_REASON_LABEL: Record<SessionEndReason, string> = {
  user_disconnect: 'Disconnected',
  ble_disconnect: 'Link lost',
  tab_closed: 'Tab closed',
  error: 'Error',
  unknown: 'Ended',
};

export function SessionList({
  sessions,
  selectedId,
  onSelect,
}: {
  sessions: readonly SessionRecord[];
  selectedId?: string | null;
  onSelect: (session: SessionRecord) => void;
}): JSX.Element {
  const ordered = [...sessions].sort((a, b) => b.startedMs - a.startedMs);

  return (
    <Card title="Sessions" subtitle="Each row is one Bluetooth connection, not a drink.">
      {ordered.length === 0 ? (
        <EmptyState title="No connections in this window">
          A session is recorded while this tab is open and the mug is in range.
        </EmptyState>
      ) : (
        <ul className="timeline">
          {ordered.map((session) => {
            const open = session.endedMs === null;
            const duration = (session.endedMs ?? Date.now()) - session.startedMs;
            const active = session.sessionId === selectedId;
            return (
              <li key={session.sessionId}>
                <button
                  type="button"
                  className={`timeline-row${active ? ' active' : ''}`}
                  onClick={() => onSelect(session)}
                >
                  <span className="timeline-when">{formatWhen(session.startedMs)}</span>
                  <span className="timeline-title">
                    {open ? 'Recording now' : (END_REASON_LABEL[session.endReason ?? 'unknown'] ?? 'Ended')}
                  </span>
                  <span className="timeline-meta">
                    {formatDuration(duration)}
                    {session.sampleCount > 0 ? ` · ${session.sampleCount} samples` : ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function formatWhen(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms));
}
