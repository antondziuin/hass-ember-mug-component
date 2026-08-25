/**
 * GATT UUIDs for Ember drinkware.
 *
 * Every service and characteristic is a 128-bit vendor UUID in the
 * `fc54XXXX-236c-4c94-8fa9-944a3e5353fa` family — nothing here is a 16-bit SIG UUID,
 * so no shortening applies.
 *
 * Extracted from `python-ember-mug` v1.4.0b3 (`ember_mug/consts.py`).
 */

/** Ember's registered BLE SIG manufacturer id. */
export const EMBER_COMPANY_ID = 0x03c1; // 961
/** Some pre-production units advertise under the testing SIG instead. */
export const TESTING_COMPANY_ID = 0xffff;

/** `UUID_TEMPLATE.format(id)` from the reference implementation. */
export function emberUuid(id: number): string {
  return `fc54${id.toString(16).padStart(4, '0')}-236c-4c94-8fa9-944a3e5353fa`;
}

export const SERVICE = {
  /** Mug 1/2, Cup, Tumbler. */
  STANDARD: emberUuid(0x3622),
  /** Travel Mug. */
  TRAVEL_MUG: emberUuid(0x3621),
  /** Travel Mug, second advertised service. */
  TRAVEL_MUG_OTHER: emberUuid(0x21a1),
} as const;

export const ALL_EMBER_SERVICES: readonly string[] = [
  SERVICE.STANDARD,
  SERVICE.TRAVEL_MUG,
  SERVICE.TRAVEL_MUG_OTHER,
];

export const TRAVEL_MUG_SERVICES: readonly string[] = [SERVICE.TRAVEL_MUG, SERVICE.TRAVEL_MUG_OTHER];

/**
 * Characteristic ids. The numeric value is what goes into {@link emberUuid}.
 *
 * 10 (LAST_LOCATION), 11 (UUID_ACCELERATION) and 16 (CONTROL_REGISTER_ADDRESS) are
 * declared for completeness but unused — the reference implementation never touches them.
 */
export const Char = {
  MUG_NAME: 1,
  CURRENT_TEMPERATURE: 2,
  TARGET_TEMPERATURE: 3,
  TEMPERATURE_UNIT: 4,
  LIQUID_LEVEL: 5,
  DATE_TIME_AND_ZONE: 6,
  BATTERY: 7,
  LIQUID_STATE: 8,
  VOLUME: 9,
  LAST_LOCATION: 10,
  UUID_ACCELERATION: 11,
  FIRMWARE: 12,
  MUG_ID: 13,
  DSK: 14,
  UDSK: 15,
  CONTROL_REGISTER_ADDRESS: 16,
  CONTROL_REGISTER_DATA: 17,
  PUSH_EVENT: 18,
  STATISTICS: 19,
  LED: 20,
} as const;

export type CharId = (typeof Char)[keyof typeof Char];

export const ALL_CHAR_IDS: readonly CharId[] = Object.values(Char);

export const CHAR_NAME: Readonly<Record<CharId, string>> = Object.fromEntries(
  Object.entries(Char).map(([name, id]) => [id, name]),
) as Record<CharId, string>;

export const CHAR_UUID: Readonly<Record<CharId, string>> = Object.fromEntries(
  ALL_CHAR_IDS.map((id) => [id, emberUuid(id)]),
) as Record<CharId, string>;

/** Reverse lookup used when indexing a connected device's characteristics. */
export const UUID_TO_CHAR: ReadonlyMap<string, CharId> = new Map(
  ALL_CHAR_IDS.map((id) => [CHAR_UUID[id], id]),
);
