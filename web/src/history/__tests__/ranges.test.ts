import { describe, expect, it } from 'vitest';

import {
  addLocalDays,
  canShiftHistoryWindow,
  pickSession,
  resolveHistoryWindow,
  sessionOffsetOf,
  startOfLocalDay,
  startOfLocalMonth,
  startOfLocalWeek,
} from '../ranges.js';
import type { Bounds, SessionRecord } from '../types.js';

function local(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

function bounds(minTs: number, maxTs: number): Bounds {
  return { minTs, maxTs, sampleCount: 10, eventCount: 2 };
}

function session(id: string, startedMs: number, endedMs: number | null = null): SessionRecord {
  return {
    sessionId: id,
    deviceId: 'sn:TEST',
    startedMs,
    endedMs,
    endReason: endedMs === null ? null : 'user_disconnect',
    sampleCount: 4,
    appVersion: 'test',
  };
}

describe('local calendar boundaries', () => {
  it('pins today to local midnight', () => {
    const noon = local(2026, 8, 30, 12, 15);
    expect(startOfLocalDay(noon)).toBe(local(2026, 8, 30));
  });

  it('starts the week on Monday, including when today is Sunday', () => {
    const sunday = local(2026, 8, 30, 18);
    expect(startOfLocalWeek(sunday)).toBe(local(2026, 8, 24));
    expect(startOfLocalWeek(local(2026, 8, 24, 9))).toBe(local(2026, 8, 24));
  });

  it('starts the month on the 1st', () => {
    expect(startOfLocalMonth(local(2026, 8, 30, 21))).toBe(local(2026, 8, 1));
  });
});

describe('resolveHistoryWindow', () => {
  const now = local(2026, 8, 30, 18, 30);
  const recorded = bounds(local(2026, 8, 1, 8), local(2026, 8, 30, 18));

  it('uses local midnight for today, not a rolling 24 hours', () => {
    const window = resolveHistoryWindow({
      mode: 'today',
      now,
      bounds: recorded,
      sessions: [],
    });
    expect(window.from).toBe(local(2026, 8, 30));
    expect(window.to).toBe(now + 1);
  });

  it('shifts today to yesterday with a closed end', () => {
    const window = resolveHistoryWindow({
      mode: 'today',
      now,
      bounds: recorded,
      sessions: [],
      offset: 1,
    });
    expect(window.from).toBe(local(2026, 8, 29));
    expect(window.to).toBe(local(2026, 8, 30));
  });

  it('uses the Monday-start calendar week', () => {
    const window = resolveHistoryWindow({
      mode: 'week',
      now,
      bounds: recorded,
      sessions: [],
    });
    expect(window.from).toBe(local(2026, 8, 24));
    expect(window.to).toBe(now + 1);
  });

  it('shifts a week back as a closed Mon–Sun span', () => {
    const window = resolveHistoryWindow({
      mode: 'week',
      now,
      bounds: recorded,
      sessions: [],
      offset: 1,
    });
    expect(window.from).toBe(local(2026, 8, 17));
    expect(window.to).toBe(local(2026, 8, 24));
  });

  it('uses the calendar month', () => {
    const window = resolveHistoryWindow({
      mode: 'month',
      now,
      bounds: recorded,
      sessions: [],
    });
    expect(window.from).toBe(local(2026, 8, 1));
    expect(window.to).toBe(now + 1);
  });

  it('shifts to the previous calendar month', () => {
    const window = resolveHistoryWindow({
      mode: 'month',
      now,
      bounds: recorded,
      sessions: [],
      offset: 1,
    });
    expect(window.from).toBe(local(2026, 7, 1));
    expect(window.to).toBe(local(2026, 8, 1));
  });

  it('rolls 7 days from now, not from the last sample', () => {
    const window = resolveHistoryWindow({
      mode: '7d',
      now,
      bounds: recorded,
      sessions: [],
    });
    expect(window.from).toBe(now - 7 * 86_400_000);
    expect(window.to).toBe(now + 1);
  });

  it('covers all recorded time', () => {
    const window = resolveHistoryWindow({
      mode: 'all',
      now,
      bounds: recorded,
      sessions: [],
    });
    expect(window.from).toBe(recorded.minTs);
    expect(window.to).toBe(now + 1);
  });

  it('prefers the open session, then the most recent closed one', () => {
    const open = session('open', local(2026, 8, 30, 17), null);
    const older = session('older', local(2026, 8, 29, 9), local(2026, 8, 29, 10));
    const current = resolveHistoryWindow({
      mode: 'session',
      now,
      bounds: recorded,
      sessions: [older, open],
    });
    expect(current.from).toBe(open.startedMs);
    expect(current.to).toBe(now + 1);

    const previous = resolveHistoryWindow({
      mode: 'session',
      now,
      bounds: recorded,
      sessions: [older, open],
      offset: 1,
    });
    expect(previous.from).toBe(older.startedMs);
    expect(previous.to).toBe(older.endedMs! + 1);
  });

  it('falls back to today when there are no sessions', () => {
    const window = resolveHistoryWindow({
      mode: 'session',
      now,
      bounds: recorded,
      sessions: [],
    });
    expect(window.from).toBe(startOfLocalDay(now));
  });
});

describe('session navigation', () => {
  const sessions = [
    session('b', local(2026, 8, 30, 12), null),
    session('a', local(2026, 8, 29, 8), local(2026, 8, 29, 9)),
    session('c', local(2026, 8, 28, 8), local(2026, 8, 28, 9)),
  ];

  it('picks the open session first', () => {
    expect(pickSession(sessions, 0)?.sessionId).toBe('b');
    expect(pickSession(sessions, 1)?.sessionId).toBe('a');
  });

  it('maps a session id back to a relative offset', () => {
    expect(sessionOffsetOf(sessions, 'b')).toBe(0);
    expect(sessionOffsetOf(sessions, 'a')).toBe(1);
    expect(sessionOffsetOf(sessions, 'c')).toBe(2);
  });
});

describe('canShiftHistoryWindow', () => {
  const now = local(2026, 8, 30, 12);
  const recorded = bounds(local(2026, 8, 29, 8), local(2026, 8, 30, 11));

  it('allows yesterday when data exists before today', () => {
    const shift = canShiftHistoryWindow({
      mode: 'today',
      now,
      bounds: recorded,
      sessions: [],
    });
    expect(shift.prev).toBe(true);
    expect(shift.next).toBe(false);
  });

  it('blocks a further calendar step that is entirely before the first sample', () => {
    const shift = canShiftHistoryWindow({
      mode: 'today',
      now,
      bounds: recorded,
      sessions: [],
      offset: 1,
    });
    expect(shift.prev).toBe(false);
    expect(shift.next).toBe(true);
  });

  it('walks sessions but not rolling ranges', () => {
    const sessions = [
      session('open', local(2026, 8, 30, 10), null),
      session('old', local(2026, 8, 29, 9), local(2026, 8, 29, 10)),
    ];
    expect(
      canShiftHistoryWindow({ mode: 'session', now, bounds: recorded, sessions }),
    ).toEqual({ prev: true, next: false });
    expect(
      canShiftHistoryWindow({ mode: '7d', now, bounds: recorded, sessions: [] }),
    ).toEqual({ prev: false, next: false });
  });
});

describe('addLocalDays', () => {
  it('crosses a month boundary in local time', () => {
    expect(addLocalDays(local(2026, 8, 31), 1)).toBe(local(2026, 9, 1));
  });
});
