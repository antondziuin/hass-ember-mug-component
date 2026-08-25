/**
 * Encode/decode for every Ember characteristic this app touches.
 *
 * Pure functions - no DOM, no Bluetooth - so they are fully unit-testable.
 *
 * Endianness is mixed and deliberate:
 *   little-endian: temperatures, liquid level/state, firmware, volume
 *   big-endian:    date/time (characteristic 6) and the advertisement's short model id
 */

import {
  LiquidState,
  MAX_TEMP_C,
  MIN_TEMP_C,
  MUG_NAME_MAX_LENGTH,
  MUG_NAME_PATTERN,
  PushEventId,
  TEMP_OFF,
  TemperatureUnit,
  VolumeLevel,
} from './constants.js';
import { validationError } from './errors.js';
import { bytesToBase64 } from './base64.js';
import type { BatteryInfo, Colour, DateTimeZone, FirmwareInfo, MugMeta } from './types.js';

const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

/**
 * A characteristic's `DataView` frequently sits at a non-zero offset inside a larger
 * buffer. Reading `dv.buffer` directly is the single most common bug in Web Bluetooth
 * code; always go through this.
 */
export function viewBytes(dv: DataView): Uint8Array {
  return new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** `int.from_bytes(data, "little", signed=False)` over a value of any length. */
export function readUintLE(dv: DataView): number {
  let value = 0;
  for (let i = dv.byteLength - 1; i >= 0; i -= 1) value = value * 256 + dv.getUint8(i);
  return value;
}

/** `int.from_bytes(data, "big", signed=...)` over a value of any length. */
export function readIntBE(bytes: Uint8Array, signed = false): number {
  if (bytes.length === 0) return 0;
  let value = signed ? (bytes[0]! << 24) >> 24 : bytes[0]!;
  for (let i = 1; i < bytes.length; i += 1) value = value * 256 + bytes[i]!;
  return value;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// --- 1  MUG_NAME  (R/W) ----------------------------------------------------

export function decodeName(dv: DataView): string {
  return decoder.decode(viewBytes(dv)).replace(/\0+$/, '');
}

const NAME_RULE_MESSAGE =
  'Use 1-16 characters: letters, digits, space, and the punctuation the mug accepts.';

export function encodeName(name: string): ArrayBuffer {
  if (!MUG_NAME_PATTERN.test(name)) {
    throw validationError('name', NAME_RULE_MESSAGE);
  }
  const bytes = encoder.encode(name);
  if (bytes.length > MUG_NAME_MAX_LENGTH) {
    throw validationError('name', `Name must encode to at most ${MUG_NAME_MAX_LENGTH} bytes.`);
  }
  return toArrayBuffer(bytes);
}

// --- 2 CURRENT_TEMPERATURE / 3 TARGET_TEMPERATURE  -------------------------

/** uint16 LE in hundredths of a degree Celsius. Always Celsius on the wire. */
export function decodeTemperature(dv: DataView): number {
  return dv.getUint16(0, true) / 100;
}

export function encodeTemperature(celsius: number): ArrayBuffer {
  // The reference does `round(temp / 0.01)`, but `57.5 / 0.01` is 5749.999... in IEEE 754.
  // Multiplying by 100 gives the intended value.
  const raw = Math.round(celsius * 100);
  if (!Number.isFinite(raw) || raw < 0 || raw > 0xffff) {
    throw validationError('targetTemp', 'Temperature is out of the representable range.');
  }
  const buffer = new ArrayBuffer(2);
  new DataView(buffer).setUint16(0, raw, true);
  return buffer;
}

/** Throws unless the value is 0 (control off) or inside the writable Celsius band. */
export function validateTargetTemp(celsius: number): void {
  if (celsius === TEMP_OFF) return;
  if (!(celsius >= MIN_TEMP_C && celsius <= MAX_TEMP_C)) {
    throw validationError(
      'targetTemp',
      `Target must be 0 (off) or between ${MIN_TEMP_C} and ${MAX_TEMP_C} C.`,
    );
  }
}

export const celsiusToFahrenheit = (c: number): number => (c * 9) / 5 + 32;
export const fahrenheitToCelsius = (f: number): number => ((f - 32) * 5) / 9;

// --- 4  TEMPERATURE_UNIT  (R/W) -------------------------------------------

export function decodeTemperatureUnit(dv: DataView): TemperatureUnit {
  return readUintLE(dv) === 1 ? TemperatureUnit.FAHRENHEIT : TemperatureUnit.CELSIUS;
}

export function encodeTemperatureUnit(unit: TemperatureUnit): ArrayBuffer {
  const buffer = new ArrayBuffer(1);
  new DataView(buffer).setUint8(0, unit === TemperatureUnit.FAHRENHEIT ? 1 : 0);
  return buffer;
}

// --- 5  LIQUID_LEVEL  (R) --------------------------------------------------

export function decodeLiquidLevel(dv: DataView): number {
  return readUintLE(dv);
}

/** Full scale is 30 on a Mug/Cup/Tumbler and 100 on a Travel Mug. */
export function liquidLevelPercent(level: number, maxLevel: 30 | 100): number {
  return clamp((level / maxLevel) * 100, 0, 100);
}

// --- 6  DATE_TIME_AND_ZONE  (R) -------------------------------------------

/** Big-endian unix seconds in the first four bytes; 0 means unset. */
export function decodeDateTimeZone(dv: DataView): DateTimeZone {
  if (dv.byteLength < 4) return { date: null, offsetHours: null };
  const seconds = dv.getUint32(0, false);
  if (seconds === 0) return { date: null, offsetHours: null };
  return {
    date: new Date(seconds * 1000),
    offsetHours: dv.byteLength > 4 ? dv.getInt8(4) : null,
  };
}

// --- 7  BATTERY  (R) -------------------------------------------------------

export function decodeBattery(dv: DataView): BatteryInfo {
  return {
    percent: dv.getUint8(0),
    onChargingBase: dv.byteLength > 1 && dv.getUint8(1) === 1,
  };
}

// --- 8  LIQUID_STATE  (R) --------------------------------------------------

export function decodeLiquidState(dv: DataView): LiquidState | null {
  const value = readUintLE(dv);
  return value >= LiquidState.STANDBY && value <= LiquidState.WARM_NO_CONTROL
    ? (value as LiquidState)
    : null;
}

// --- 9  VOLUME  (R/W, Travel Mug) -----------------------------------------

export function decodeVolumeLevel(dv: DataView): VolumeLevel | null {
  const value = readUintLE(dv);
  return value === 0 || value === 1 || value === 2 ? (value as VolumeLevel) : null;
}

export function encodeVolumeLevel(level: VolumeLevel): ArrayBuffer {
  if (level !== 0 && level !== 1 && level !== 2) {
    throw validationError('volumeLevel', 'Volume must be low, medium or high.');
  }
  const buffer = new ArrayBuffer(1);
  new DataView(buffer).setUint8(0, level);
  return buffer;
}

// --- 12  FIRMWARE  (R) -----------------------------------------------------

export function decodeFirmware(dv: DataView): FirmwareInfo {
  return {
    version: dv.getUint16(0, true),
    hardware: dv.getUint16(2, true),
    bootloader: dv.byteLength >= 6 ? dv.getUint16(4, true) : null,
  };
}

// --- 13  MUG_ID  (R) -------------------------------------------------------

/** Bytes 0-5 are an opaque id; byte 6 is a separator; the rest is the ASCII serial. */
export function decodeMugId(dv: DataView): MugMeta {
  const bytes = viewBytes(dv);
  const serial = decoder.decode(bytes.subarray(7)).replace(/\0+$/, '').trim();
  return {
    mugId: bytesToBase64(bytes.subarray(0, 6)),
    serialNumber: serial.length > 0 ? serial : null,
  };
}

// --- 14  DSK  (R) ----------------------------------------------------------

export function decodeDsk(dv: DataView): string {
  return bytesToBase64(viewBytes(dv));
}

// --- 15  UDSK  (R/W) -------------------------------------------------------

/** Twenty zero bytes means the device has never been provisioned, so writes are ignored. */
export function decodeUdsk(dv: DataView): string | null {
  const bytes = viewBytes(dv);
  if (bytes.length === 20 && bytes.every((b) => b === 0)) return null;
  return bytesToBase64(bytes);
}

/**
 * Faithfully reproduces the reference implementation's asymmetry: reads base64-encode the
 * raw bytes for display, but writes base64-encode the supplied string and send that
 * base64 text as ASCII bytes.
 */
export function encodeUdsk(value: string): ArrayBuffer {
  return toArrayBuffer(encoder.encode(bytesToBase64(encoder.encode(value))));
}

// --- 17  CONTROL_REGISTER_DATA  (R, Travel Mug) ---------------------------

/** Only the first byte is meaningful, so endianness is moot. */
export function decodeBatteryVoltage(dv: DataView): number {
  return dv.getUint8(0);
}

// --- 18  PUSH_EVENT  (Notify) ---------------------------------------------

export function decodePushEvent(dv: DataView): PushEventId | null {
  if (dv.byteLength === 0) return null;
  const id = dv.getUint8(0);
  return id >= PushEventId.BATTERY_CHANGED && id <= PushEventId.BATTERY_VOLTAGE_STATE_CHANGED
    ? (id as PushEventId)
    : null;
}

// --- 20  LED  (R/W) --------------------------------------------------------

export function decodeColour(dv: DataView): Colour {
  return {
    red: dv.getUint8(0),
    green: dv.getUint8(1),
    blue: dv.getUint8(2),
    brightness: dv.byteLength > 3 ? dv.getUint8(3) : 255,
  };
}

export function encodeColour(colour: Colour): ArrayBuffer {
  for (const key of ['red', 'green', 'blue', 'brightness'] as const) {
    const value = colour[key];
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw validationError(`led.${key}`, 'Colour channels must be integers from 0 to 255.');
    }
  }
  const buffer = new ArrayBuffer(4);
  const dv = new DataView(buffer);
  dv.setUint8(0, colour.red);
  dv.setUint8(1, colour.green);
  dv.setUint8(2, colour.blue);
  dv.setUint8(3, colour.brightness);
  return buffer;
}

export function colourToHex(colour: Colour): string {
  const hex = (v: number): string => v.toString(16).padStart(2, '0');
  return `#${hex(colour.red)}${hex(colour.green)}${hex(colour.blue)}`;
}

export function hexToColour(hex: string, brightness = 255): Colour {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) throw validationError('led', 'Colour must be a six-digit hex value such as #ff8800.');
  const n = Number.parseInt(match[1]!, 16);
  return { red: (n >> 16) & 0xff, green: (n >> 8) & 0xff, blue: n & 0xff, brightness };
}
