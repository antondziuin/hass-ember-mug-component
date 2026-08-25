/**
 * Per-device preferences that outlive a connection.
 *
 * Keyed by serial number where possible, because that is portable across browsers and
 * profiles. The Web Bluetooth `device.id` is origin-scoped and resets when site data is
 * cleared, so it is only a fallback.
 */

import type { DeviceModel } from './constants.js';
import type { EmberAttributes, KeyValueStore, RememberedDevice } from './types.js';

const PREFIX = 'ember.device.';
const LAST_DEVICE_KEY = 'ember.lastDevice';

export interface DevicePrefs {
  /** User's explicit model choice, when detection was not confident. */
  modelOverride?: DeviceModel | null;
  /** Last non-zero target, restored when temperature control is switched back on. */
  lastTargetC?: number;
  /** Friendly label shown in the UI, independent of the mug's own name. */
  label?: string;
}

export const memoryStore = (initial: Record<string, string> = {}): KeyValueStore => {
  const map = new Map(Object.entries(initial));
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => void map.set(key, value),
    remove: (key) => void map.delete(key),
  };
};

/** Falls back to an in-memory store when storage is unavailable (private mode, iframes). */
export function browserStore(): KeyValueStore {
  try {
    const probe = '__ember_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return {
      get: (key) => window.localStorage.getItem(key),
      set: (key, value) => window.localStorage.setItem(key, value),
      remove: (key) => window.localStorage.removeItem(key),
    };
  } catch {
    return memoryStore();
  }
}

function parse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Prefers the serial number; falls back to the origin-scoped Bluetooth id. */
export function devicePrefsKey(serialNumber: string | null, bleId: string | null): string {
  if (serialNumber) return `${PREFIX}sn:${serialNumber}`;
  return `${PREFIX}ble:${bleId ?? 'unknown'}`;
}

export function loadDevicePrefs(store: KeyValueStore, key: string): DevicePrefs {
  return parse<DevicePrefs>(store.get(key)) ?? {};
}

export function saveDevicePrefs(store: KeyValueStore, key: string, prefs: DevicePrefs): void {
  store.set(key, JSON.stringify(prefs));
}

/**
 * Moves preferences from the Bluetooth-id key to the serial key once the serial is known,
 * so a choice made before the first read is not lost.
 */
export function rekeyDevicePrefs(store: KeyValueStore, fromKey: string, toKey: string): void {
  if (fromKey === toKey) return;
  const existing = store.get(fromKey);
  if (!existing) return;
  const target = store.get(toKey);
  if (!target) store.set(toKey, existing);
  store.remove(fromKey);
}

/** Attribute values worth restoring into a greyed-out UI after a reload. */
function serialisableAttrs(attrs: EmberAttributes): EmberAttributes {
  const { dateTimeZone: _dateTimeZone, dsk: _dsk, udsk: _udsk, ...rest } = attrs;
  return rest;
}

export function saveRememberedDevice(store: KeyValueStore, device: RememberedDevice): void {
  store.set(
    LAST_DEVICE_KEY,
    JSON.stringify({ ...device, attrs: serialisableAttrs(device.attrs) }),
  );
}

export function loadRememberedDevice(store: KeyValueStore): RememberedDevice | null {
  const remembered = parse<RememberedDevice>(store.get(LAST_DEVICE_KEY));
  if (!remembered || typeof remembered.bleId !== 'string') return null;
  return { ...remembered, attrs: remembered.attrs ?? {} };
}

export function clearRememberedDevice(store: KeyValueStore): void {
  store.remove(LAST_DEVICE_KEY);
}
