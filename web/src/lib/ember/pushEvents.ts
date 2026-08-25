/**
 * Push-event handling.
 *
 * Notifications on characteristic 18 carry no value - only an event id. They mean
 * "this attribute changed, go and read it", so each one marks an attribute dirty.
 */

import { PUSH_DEBOUNCE_MS, PushEventId } from './constants.js';
import type { Attribute } from './types.js';

/** Which attribute each event invalidates. Event 6 carries no attribute of its own. */
export const PUSH_EVENT_ATTRIBUTES: Readonly<Record<PushEventId, readonly Attribute[]>> = {
  [PushEventId.BATTERY_CHANGED]: ['battery'],
  [PushEventId.CHARGER_CONNECTED]: ['battery'],
  [PushEventId.CHARGER_DISCONNECTED]: ['battery'],
  [PushEventId.TARGET_TEMPERATURE_CHANGED]: ['targetTemp'],
  [PushEventId.DRINK_TEMPERATURE_CHANGED]: ['currentTemp'],
  [PushEventId.AUTH_INFO_NOT_FOUND]: [],
  [PushEventId.LIQUID_LEVEL_CHANGED]: ['liquidLevel'],
  [PushEventId.LIQUID_STATE_CHANGED]: ['liquidState'],
  [PushEventId.BATTERY_VOLTAGE_STATE_CHANGED]: ['batteryVoltage'],
};

export const PUSH_EVENT_LABEL: Readonly<Record<PushEventId, string>> = {
  [PushEventId.BATTERY_CHANGED]: 'Battery changed',
  [PushEventId.CHARGER_CONNECTED]: 'Placed on charger',
  [PushEventId.CHARGER_DISCONNECTED]: 'Lifted off charger',
  [PushEventId.TARGET_TEMPERATURE_CHANGED]: 'Target temperature changed',
  [PushEventId.DRINK_TEMPERATURE_CHANGED]: 'Drink temperature changed',
  [PushEventId.AUTH_INFO_NOT_FOUND]: 'Device reports missing auth info',
  [PushEventId.LIQUID_LEVEL_CHANGED]: 'Liquid level changed',
  [PushEventId.LIQUID_STATE_CHANGED]: 'Liquid state changed',
  [PushEventId.BATTERY_VOLTAGE_STATE_CHANGED]: 'Battery voltage changed',
};

/**
 * Suppresses a repeat of the same event id inside the debounce window, matching the
 * reference implementation. The clock is injectable so tests need no real timers.
 */
export class PushEventDebouncer {
  readonly #last = new Map<PushEventId, number>();
  readonly #windowMs: number;
  readonly #now: () => number;

  constructor(windowMs: number = PUSH_DEBOUNCE_MS, now: () => number = Date.now) {
    this.#windowMs = windowMs;
    this.#now = now;
  }

  shouldHandle(id: PushEventId): boolean {
    const now = this.#now();
    const previous = this.#last.get(id);
    if (previous !== undefined && now - previous < this.#windowMs) return false;
    this.#last.set(id, now);
    return true;
  }

  reset(): void {
    this.#last.clear();
  }
}
