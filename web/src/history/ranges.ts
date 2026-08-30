/**
 * Calendar- and session-aware history windows.
 *
 * Rolling 24h/7d/30d ranges used to be anchored to the latest sample, so "today" was
 * never actually today. These helpers use local midnight, Monday-start weeks, and the
 * BLE session list instead.
 */

import type { Bounds, Millis, SessionRecord } from './types.js';

export const HISTORY_MODES = [
  { id: 'session', label: 'Session' },
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'all', label: 'All' },
] as const;

export type HistoryMode = (typeof HISTORY_MODES)[number]['id'];

/** Named presets plus a user-drawn zoom that is not persisted. */
export type HistoryViewMode = HistoryMode | 'custom';

export const HISTORY_MODE_KEY = 'ember.historyMode';

const DAY_MS = 86_400_000;
const SHIFTABLE = new Set<HistoryViewMode>(['session', 'today', 'week', 'month']);

export function isHistoryMode(value: string | null | undefined): value is HistoryMode {
  return HISTORY_MODES.some((mode) => mode.id === value);
}

export function loadHistoryMode(storage: Pick<Storage, 'getItem'> | null = defaultStorage()): HistoryMode {
  if (!storage) return 'today';
  try {
    const stored = storage.getItem(HISTORY_MODE_KEY);
    return isHistoryMode(stored) ? stored : 'today';
  } catch {
    return 'today';
  }
}

export function saveHistoryMode(
  mode: HistoryViewMode,
  storage: Pick<Storage, 'setItem'> | null = defaultStorage(),
): void {
  if (!storage || mode === 'custom') return;
  try {
    storage.setItem(HISTORY_MODE_KEY, mode);
  } catch {
    // A blocked store just means the next visit starts on Today.
  }
}

export function isShiftableMode(mode: HistoryViewMode): boolean {
  return SHIFTABLE.has(mode);
}

export function startOfLocalDay(ms: Millis): Millis {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Monday 00:00 local time of the week that contains `ms`. */
export function startOfLocalWeek(ms: Millis): Millis {
  const date = new Date(startOfLocalDay(ms));
  const weekday = date.getDay();
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  date.setDate(date.getDate() + mondayOffset);
  return date.getTime();
}

export function startOfLocalMonth(ms: Millis): Millis {
  const date = new Date(ms);
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function addLocalDays(ms: Millis, days: number): Millis {
  const date = new Date(ms);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

export function addLocalMonths(ms: Millis, months: number): Millis {
  const date = new Date(ms);
  date.setMonth(date.getMonth() + months);
  return date.getTime();
}

export interface HistoryWindow {
  from: Millis;
  to: Millis;
}

export interface ResolveHistoryWindowInput {
  mode: HistoryViewMode;
  now: Millis;
  bounds: Bounds;
  sessions: readonly SessionRecord[];
  offset?: number;
  /** Used when `mode === 'custom'`. */
  custom?: HistoryWindow | null;
}

export function sortSessionsNewestFirst(sessions: readonly SessionRecord[]): SessionRecord[] {
  return [...sessions].sort((a, b) => b.startedMs - a.startedMs || a.sessionId.localeCompare(b.sessionId));
}

export function pickSession(sessions: readonly SessionRecord[], offset = 0): SessionRecord | null {
  const sorted = sortSessionsNewestFirst(sessions);
  if (sorted.length === 0) return null;
  const openIndex = sorted.findIndex((session) => session.endedMs === null);
  const start = openIndex >= 0 ? openIndex : 0;
  return sorted[Math.min(start + offset, sorted.length - 1)] ?? null;
}

export function sessionOffsetOf(sessions: readonly SessionRecord[], sessionId: string): number {
  const sorted = sortSessionsNewestFirst(sessions);
  const openIndex = sorted.findIndex((session) => session.endedMs === null);
  const start = openIndex >= 0 ? openIndex : 0;
  const index = sorted.findIndex((session) => session.sessionId === sessionId);
  return index < 0 ? 0 : Math.max(index - start, 0);
}

export function resolveHistoryWindow(input: ResolveHistoryWindowInput): HistoryWindow {
  const offset = Math.max(input.offset ?? 0, 0);
  const liveEnd = Math.max(input.now, input.bounds.maxTs) + 1;

  if (input.mode === 'custom' && input.custom) {
    return clampWindow(input.custom, input.bounds, liveEnd);
  }

  if (input.mode === 'session') {
    const session = pickSession(input.sessions, offset);
    if (!session) {
      return resolveHistoryWindow({ ...input, mode: 'today', offset: 0 });
    }
    return {
      from: session.startedMs,
      to: session.endedMs === null ? liveEnd : session.endedMs + 1,
    };
  }

  if (input.mode === 'all') {
    return { from: input.bounds.minTs, to: liveEnd };
  }

  if (input.mode === '7d' || input.mode === '30d') {
    const span = input.mode === '7d' ? 7 * DAY_MS : 30 * DAY_MS;
    return {
      from: Math.max(liveEnd - 1 - span, input.bounds.minTs),
      to: liveEnd,
    };
  }

  if (input.mode === 'today') {
    const start = addLocalDays(startOfLocalDay(input.now), -offset);
    const next = addLocalDays(start, 1);
    return {
      from: start,
      to: offset === 0 ? liveEnd : next,
    };
  }

  if (input.mode === 'week') {
    const start = addLocalDays(startOfLocalWeek(input.now), -offset * 7);
    const next = addLocalDays(start, 7);
    return {
      from: start,
      to: offset === 0 ? liveEnd : next,
    };
  }

  const start = addLocalMonths(startOfLocalMonth(input.now), -offset);
  const next = addLocalMonths(start, 1);
  return {
    from: start,
    to: offset === 0 ? liveEnd : next,
  };
}

export function canShiftHistoryWindow(input: ResolveHistoryWindowInput): { prev: boolean; next: boolean } {
  if (!isShiftableMode(input.mode)) return { prev: false, next: false };
  const offset = Math.max(input.offset ?? 0, 0);

  if (input.mode === 'session') {
    const sorted = sortSessionsNewestFirst(input.sessions);
    const current = pickSession(input.sessions, offset);
    if (!current) return { prev: false, next: false };
    const index = sorted.findIndex((session) => session.sessionId === current.sessionId);
    return { prev: index >= 0 && index < sorted.length - 1, next: offset > 0 };
  }

  const previous = resolveHistoryWindow({ ...input, offset: offset + 1 });
  return {
    prev: previous.to > input.bounds.minTs,
    next: offset > 0,
  };
}

export function formatHistoryCaption(
  mode: HistoryViewMode,
  window: HistoryWindow,
  now: Millis = Date.now(),
): string {
  if (mode === 'custom') return formatRangePair(window.from, window.to);
  if (mode === 'session') return `Session · ${formatRangePair(window.from, window.to)}`;
  if (mode === 'all') return 'All recorded time';
  if (mode === '7d' || mode === '30d') return formatRangePair(window.from, window.to);

  if (mode === 'today') {
    const start = startOfLocalDay(window.from);
    if (start === startOfLocalDay(now)) return 'Today';
    if (start === startOfLocalDay(addLocalDays(now, -1))) return 'Yesterday';
    return formatDay(window.from);
  }

  if (mode === 'week') {
    const end = Math.max(window.to - 1, window.from);
    return `${formatDay(window.from)} – ${formatDay(end)}`;
  }

  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(window.from));
}

function clampWindow(window: HistoryWindow, bounds: Bounds, liveEnd: Millis): HistoryWindow {
  const from = Math.max(window.from, bounds.minTs);
  const to = Math.min(Math.max(window.to, from + 1), liveEnd);
  return { from, to };
}

function formatDay(ms: Millis): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(ms));
}

function formatRangePair(from: Millis, to: Millis): string {
  const span = to - from;
  const fmt = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    ...(span < 3 * DAY_MS ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
  return `${fmt.format(new Date(from))} – ${fmt.format(new Date(Math.max(to - 1, from)))}`;
}

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
