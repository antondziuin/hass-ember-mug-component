/**
 * Protocol enums, validation rules and timing constants.
 *
 * Values mirror `python-ember-mug` v1.4.0b3 unless a comment says otherwise.
 */

/** Liquid state reported by characteristic 8. */
export const LiquidState = {
  STANDBY: 0,
  EMPTY: 1,
  FILLING: 2,
  COLD_NO_CONTROL: 3,
  COOLING: 4,
  HEATING: 5,
  /** The library calls this TARGET_TEMPERATURE; the UI everywhere calls it "Perfect". */
  PERFECT: 6,
  WARM_NO_CONTROL: 7,
} as const;
export type LiquidState = (typeof LiquidState)[keyof typeof LiquidState];

export const LIQUID_STATE_LABEL: Readonly<Record<LiquidState, string>> = {
  [LiquidState.STANDBY]: 'Standby',
  [LiquidState.EMPTY]: 'Empty',
  [LiquidState.FILLING]: 'Filling',
  [LiquidState.COLD_NO_CONTROL]: 'Cold (no control)',
  [LiquidState.COOLING]: 'Cooling',
  [LiquidState.HEATING]: 'Heating',
  [LiquidState.PERFECT]: 'Perfect',
  [LiquidState.WARM_NO_CONTROL]: 'Warm (no control)',
};

/** Device's own display unit (characteristic 4). Not the unit this app renders in. */
export const TemperatureUnit = { CELSIUS: 'C', FAHRENHEIT: 'F' } as const;
export type TemperatureUnit = (typeof TemperatureUnit)[keyof typeof TemperatureUnit];

/** Travel Mug button-beep volume (characteristic 9). */
export const VolumeLevel = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;
export type VolumeLevel = (typeof VolumeLevel)[keyof typeof VolumeLevel];

export const VOLUME_LEVEL_LABEL: Readonly<Record<VolumeLevel, string>> = {
  [VolumeLevel.LOW]: 'Low',
  [VolumeLevel.MEDIUM]: 'Medium',
  [VolumeLevel.HIGH]: 'High',
};

/**
 * Push-event ids delivered on characteristic 18.
 *
 * The payload carries no value — only `data[0]`. Each id means "this attribute changed,
 * go and read it".
 */
export const PushEventId = {
  BATTERY_CHANGED: 1,
  CHARGER_CONNECTED: 2,
  CHARGER_DISCONNECTED: 3,
  TARGET_TEMPERATURE_CHANGED: 4,
  DRINK_TEMPERATURE_CHANGED: 5,
  /** The device has no auth info — writes will be silently ignored. */
  AUTH_INFO_NOT_FOUND: 6,
  LIQUID_LEVEL_CHANGED: 7,
  LIQUID_STATE_CHANGED: 8,
  BATTERY_VOLTAGE_STATE_CHANGED: 9,
} as const;
export type PushEventId = (typeof PushEventId)[keyof typeof PushEventId];

export const DeviceType = {
  MUG: 'mug',
  CUP: 'cup',
  TUMBLER: 'tumbler',
  TRAVEL_MUG: 'travel_mug',
} as const;
export type DeviceType = (typeof DeviceType)[keyof typeof DeviceType];

/** Model codes exactly as Ember stamps them. */
export const DeviceModel = {
  CUP_6_OZ: 'CM21S',
  MUG_1_10_OZ: 'CM17',
  MUG_1_14_OZ: 'CM17P',
  MUG_2_10_OZ: 'CM19/CM21M',
  MUG_2_14_OZ: 'CM19P/CM21L',
  TRAVEL_MUG_12_OZ: 'TM19',
  TUMBLER_16_OZ: 'CM21XL',
} as const;
export type DeviceModel = (typeof DeviceModel)[keyof typeof DeviceModel];

export const DeviceColour = {
  SAGE_GREEN: 'Sage Green',
  SANDSTONE: 'Sandstone',
  BLACK: 'Black',
  WHITE: 'White',
  GREY: 'Grey',
  BLUE: 'Blue',
  RED: 'Red',
  COPPER: 'Copper',
  GOLD: 'Gold',
  STAINLESS_STEEL: 'Stainless Steel',
  ROSE_GOLD: 'Rose Gold',
} as const;
export type DeviceColour = (typeof DeviceColour)[keyof typeof DeviceColour];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Device name rules, mirroring `MUG_NAME_REGEX`. The extra escaping in the original is
 * for Home Assistant's stricter LitElement pattern mode and is not needed here.
 */
export const MUG_NAME_PATTERN = /^[A-Za-z0-9,.[\]#()!"';:|\-_+<>%= ]{1,16}$/;
export const MUG_NAME_MAX_LENGTH = 16;

/** Writing 0 to the target-temperature characteristic turns temperature control off. */
export const TEMP_OFF = 0;

/**
 * Celsius is the single source of truth: the wire format is always Celsius, and the
 * reference library validates 49-63 C. Fahrenheit is derived for display only.
 *
 * Note that the Home Assistant integration's own bounds (48.8-63 C / 120-150 F) are
 * internally inconsistent - 63 C is 145.4 F - so they are deliberately not reproduced.
 */
export const MIN_TEMP_C = 49;
export const MAX_TEMP_C = 63;
/** Fallback used when temperature control is switched on with no remembered target. */
export const DEFAULT_TARGET_C = 57;

/** Presets carried over verbatim from the Home Assistant integration's `const.py`. */
export const DEFAULT_PRESETS: ReadonlyArray<{ id: string; label: string; celsius: number }> = [
  { id: 'latte', label: 'Latte', celsius: 55 },
  { id: 'cappuccino', label: 'Cappuccino', celsius: 56 },
  { id: 'coffee', label: 'Coffee', celsius: 57 },
  { id: 'black-tea', label: 'Black tea', celsius: 58.5 },
  { id: 'green-tea', label: 'Green tea', celsius: 59 },
];

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** Per-event-id debounce for push notifications, matching the reference implementation. */
export const PUSH_DEBOUNCE_MS = 5_000;
/** Push events mark attributes dirty; they are drained after this delay to coalesce bursts. */
export const PUSH_COALESCE_MS = 250;

/** Poll cadence while the device is actively heating, cooling or holding. */
export const HOT_POLL_MS = 5_000;
/** Poll cadence while standby/empty and sitting on the charger. */
export const IDLE_POLL_MS = 30_000;
/** Every Nth tick reads every attribute rather than just the fast-moving ones. */
export const FULL_POLL_EVERY_N_TICKS = 6;

export const DEFAULT_OP_TIMEOUT_MS = 10_000;
export const CONNECT_TIMEOUT_MS = 20_000;
export const DISCOVER_TIMEOUT_MS = 20_000;

/** Jittered reconnect backoff. The last entry repeats indefinitely. */
export const RECONNECT_BACKOFF_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000, 15_000, 30_000,
];

/** Retry delays for a transient GATT failure inside a single operation. */
export const GATT_RETRY_BACKOFF_MS: readonly number[] = [100, 250, 600];

/**
 * After this many consecutive failed connection attempts, tell the user that the Ember
 * phone app may be holding the connection - the device accepts only one central at a time.
 */
export const CONNECT_FAILURES_BEFORE_HINT = 3;
