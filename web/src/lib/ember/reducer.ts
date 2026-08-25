/**
 * Pure state transitions for the device layer.
 *
 * The one invariant that matters: a transition that changes nothing must return the
 * *identical* object, because the snapshot feeds `useSyncExternalStore`. Returning a
 * fresh-but-equal object on every poll is an infinite render loop.
 */

import type { EmberFailure } from './errors.js';
import type {
  Attribute,
  ConnectionState,
  EmberAttributes,
  EmberDeviceState,
  ModelDetection,
  Writability,
} from './types.js';

export type EmberAction =
  | { type: 'connection'; connection: ConnectionState }
  | { type: 'identified'; detection: ModelDetection; capabilities: ReadonlySet<Attribute> }
  | { type: 'attrs'; attrs: Partial<EmberAttributes>; at: number }
  | { type: 'device-info'; bleId: string | null; bleName: string | null }
  | { type: 'unknown-chars'; uuids: readonly string[] }
  | { type: 'optimistic'; attr: Attribute; value: unknown }
  | { type: 'settle'; attr: Attribute; value: unknown; at: number }
  | { type: 'revert'; attr: Attribute; value: unknown }
  | { type: 'writability'; value: Writability }
  | { type: 'auth-info-missing' }
  | { type: 'failure'; failure: EmberFailure | null };

export const EMPTY_CAPABILITIES: ReadonlySet<Attribute> = new Set<Attribute>();
const EMPTY_PENDING: ReadonlySet<Attribute> = new Set<Attribute>();

export function initialState(connection: ConnectionState = { status: 'idle' }): EmberDeviceState {
  return {
    connection,
    detection: null,
    capabilities: EMPTY_CAPABILITIES,
    attrs: {},
    pending: EMPTY_PENDING,
    writability: 'unknown',
    bleName: null,
    bleId: null,
    unknownCharUuids: [],
    lastUpdate: null,
    lastFailure: null,
    authInfoMissing: false,
  };
}

/** Structural equality for the small, flat values an attribute can hold. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

function sameConnection(a: ConnectionState, b: ConnectionState): boolean {
  return sameValue(a, b);
}

function withoutPending(pending: ReadonlySet<Attribute>, attr: Attribute): ReadonlySet<Attribute> {
  if (!pending.has(attr)) return pending;
  const next = new Set(pending);
  next.delete(attr);
  return next.size === 0 ? EMPTY_PENDING : next;
}

function mergeAttrs(
  state: EmberDeviceState,
  incoming: Partial<EmberAttributes>,
  at: number,
): EmberDeviceState {
  let changed = false;
  const attrs: EmberAttributes = { ...state.attrs };

  for (const [key, value] of Object.entries(incoming) as Array<
    [keyof EmberAttributes, EmberAttributes[keyof EmberAttributes]]
  >) {
    if (value === undefined) continue;
    if (!sameValue(state.attrs[key], value)) {
      (attrs as Record<string, unknown>)[key] = value;
      changed = true;
    }
  }

  // A poll that found nothing new still advances `lastUpdate`, which the UI uses for its
  // staleness stamp - but only ever forwards, so the object identity stays stable when
  // the timestamp is unchanged.
  const lastUpdate = at > (state.lastUpdate ?? 0) ? at : state.lastUpdate;
  if (!changed && lastUpdate === state.lastUpdate) return state;

  return { ...state, attrs: changed ? attrs : state.attrs, lastUpdate };
}

export function emberReducer(state: EmberDeviceState, action: EmberAction): EmberDeviceState {
  switch (action.type) {
    case 'connection': {
      if (sameConnection(state.connection, action.connection)) return state;
      const next: EmberDeviceState = { ...state, connection: action.connection };
      // Leaving a live connection clears transient bookkeeping but keeps the last
      // known attribute values, so the UI can render them greyed out.
      if (action.connection.status === 'disconnected' || action.connection.status === 'idle') {
        next.pending = EMPTY_PENDING;
      }
      return next;
    }

    case 'identified': {
      if (
        sameValue(state.detection, action.detection) &&
        sameCapabilities(state.capabilities, action.capabilities)
      ) {
        return state;
      }
      return { ...state, detection: action.detection, capabilities: action.capabilities };
    }

    case 'attrs':
      return mergeAttrs(state, action.attrs, action.at);

    case 'device-info': {
      if (state.bleId === action.bleId && state.bleName === action.bleName) return state;
      return { ...state, bleId: action.bleId, bleName: action.bleName };
    }

    case 'unknown-chars': {
      if (
        state.unknownCharUuids.length === action.uuids.length &&
        state.unknownCharUuids.every((u, i) => u === action.uuids[i])
      ) {
        return state;
      }
      return { ...state, unknownCharUuids: [...action.uuids] };
    }

    case 'optimistic': {
      const pending = new Set(state.pending);
      pending.add(action.attr);
      return {
        ...state,
        attrs: { ...state.attrs, [action.attr]: action.value },
        pending,
      };
    }

    case 'settle': {
      const merged = mergeAttrs(state, { [action.attr]: action.value }, action.at);
      const pending = withoutPending(merged.pending, action.attr);
      if (pending === merged.pending) return merged;
      return { ...merged, pending };
    }

    case 'revert': {
      const attrs = { ...state.attrs };
      if (action.value === undefined) {
        delete attrs[action.attr];
      } else {
        (attrs as Record<string, unknown>)[action.attr] = action.value;
      }
      return { ...state, attrs, pending: withoutPending(state.pending, action.attr) };
    }

    case 'writability':
      if (state.writability === action.value) return state;
      return { ...state, writability: action.value };

    case 'auth-info-missing':
      if (state.authInfoMissing && state.writability === 'no') return state;
      return { ...state, authInfoMissing: true, writability: 'no' };

    case 'failure':
      if (sameValue(state.lastFailure, action.failure)) return state;
      return { ...state, lastFailure: action.failure };
  }
}

function sameCapabilities(a: ReadonlySet<Attribute>, b: ReadonlySet<Attribute>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}
