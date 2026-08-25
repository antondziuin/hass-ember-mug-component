import { describe, expect, it } from 'vitest';

import {
  celsiusToFahrenheit,
  colourToHex,
  decodeBattery,
  decodeBatteryVoltage,
  decodeColour,
  decodeDateTimeZone,
  decodeFirmware,
  decodeLiquidLevel,
  decodeLiquidState,
  decodeMugId,
  decodeName,
  decodePushEvent,
  decodeTemperature,
  decodeTemperatureUnit,
  decodeUdsk,
  decodeVolumeLevel,
  encodeColour,
  encodeName,
  encodeTemperature,
  encodeTemperatureUnit,
  encodeUdsk,
  encodeVolumeLevel,
  fahrenheitToCelsius,
  hexToColour,
  liquidLevelPercent,
  readIntBE,
  validateTargetTemp,
} from '../codecs.js';
import { LiquidState, PushEventId, TemperatureUnit, VolumeLevel } from '../constants.js';
import { EmberError } from '../errors.js';

/**
 * Every fixture is placed at a non-zero byteOffset inside a larger buffer, because that
 * is what Chrome actually hands back and it is the shape that catches code reading
 * `dv.buffer` instead of the view's own window.
 */
function view(...bytes: number[]): DataView {
  const padded = new Uint8Array(bytes.length + 7);
  padded.set(bytes, 7);
  return new DataView(padded.buffer, 7, bytes.length);
}

const bytesOf = (buffer: ArrayBuffer): number[] => [...new Uint8Array(buffer)];

describe('temperature', () => {
  it('decodes uint16 little-endian hundredths of a degree', () => {
    // b"\xcd\x15" from the reference test suite.
    expect(decodeTemperature(view(0xcd, 0x15))).toBeCloseTo(55.81, 5);
    expect(decodeTemperature(view(0x18, 0x15))).toBeCloseTo(54, 5);
  });

  it('encodes the reference implementation golden vectors', () => {
    expect(bytesOf(encodeTemperature(54))).toEqual([0x18, 0x15]);
    expect(bytesOf(encodeTemperature(55.81))).toEqual([0xcd, 0x15]);
    // 120 F converted to Celsius, as the reference does before writing.
    expect(bytesOf(encodeTemperature(fahrenheitToCelsius(120)))).toEqual([0x19, 0x13]);
  });

  it('does not lose a count to float division', () => {
    // `57.5 / 0.01` is 5749.999999999999 in IEEE 754, so a naive port writes 5749.
    expect(bytesOf(encodeTemperature(57.5))).toEqual([0x76, 0x16]);
    expect(new DataView(encodeTemperature(57.5)).getUint16(0, true)).toBe(5750);
  });

  it('round-trips across the writable band', () => {
    for (let raw = 4900; raw <= 6300; raw += 1) {
      const celsius = raw / 100;
      expect(decodeTemperature(new DataView(encodeTemperature(celsius)))).toBeCloseTo(celsius, 5);
    }
  });

  it('rejects a target outside the band but allows zero', () => {
    expect(() => validateTargetTemp(0)).not.toThrow();
    expect(() => validateTargetTemp(57)).not.toThrow();
    expect(() => validateTargetTemp(48.9)).toThrow(EmberError);
    expect(() => validateTargetTemp(63.1)).toThrow(EmberError);
  });

  it('converts between units', () => {
    expect(celsiusToFahrenheit(63)).toBeCloseTo(145.4, 5);
    expect(fahrenheitToCelsius(145)).toBeCloseTo(62.7778, 3);
  });
});

describe('battery', () => {
  it('reads percent and charging flag', () => {
    // b"5\x01"
    expect(decodeBattery(view(0x35, 0x01))).toEqual({ percent: 53, onChargingBase: true });
    expect(decodeBattery(view(0x35, 0x00))).toEqual({ percent: 53, onChargingBase: false });
  });

  it('tolerates a one-byte value', () => {
    expect(decodeBattery(view(0x64))).toEqual({ percent: 100, onChargingBase: false });
  });

  it('reads voltage from the first byte only', () => {
    expect(decodeBatteryVoltage(view(0x01, 0xff, 0xff))).toBe(1);
  });
});

describe('liquid level and state', () => {
  it('decodes the raw level', () => {
    expect(decodeLiquidLevel(view(30))).toBe(30);
    expect(decodeLiquidLevel(view(0))).toBe(0);
  });

  it('scales by model full-scale', () => {
    expect(liquidLevelPercent(30, 30)).toBeCloseTo(100, 5);
    expect(liquidLevelPercent(15, 30)).toBeCloseTo(50, 5);
    expect(liquidLevelPercent(30, 100)).toBeCloseTo(30, 5);
    expect(liquidLevelPercent(200, 100)).toBe(100);
  });

  it('decodes known states and rejects unknown ones', () => {
    expect(decodeLiquidState(view(6))).toBe(LiquidState.PERFECT);
    expect(decodeLiquidState(view(0))).toBe(LiquidState.STANDBY);
    expect(decodeLiquidState(view(9))).toBeNull();
  });
});

describe('firmware, meta and keys', () => {
  it('decodes three little-endian uint16s', () => {
    // b"c\x01\x80\x00\x12\x00"
    expect(decodeFirmware(view(0x63, 0x01, 0x80, 0x00, 0x12, 0x00))).toEqual({
      version: 355,
      hardware: 128,
      bootloader: 18,
    });
  });

  it('skips byte 6 when splitting the mug id from the serial', () => {
    // b"Yw====-ABCDEFGHIJ"
    const raw = [...'Yw====-ABCDEFGHIJ'].map((c) => c.charCodeAt(0));
    expect(decodeMugId(view(...raw))).toEqual({
      mugId: 'WXc9PT09',
      serialNumber: 'ABCDEFGHIJ',
    });
  });

  it('treats twenty zero bytes of UDSK as unprovisioned', () => {
    expect(decodeUdsk(view(...new Array<number>(20).fill(0)))).toBeNull();
    expect(decodeUdsk(view(...new Array<number>(20).fill(1)))).not.toBeNull();
  });

  it('base64-encodes the string when writing UDSK', () => {
    // The reference implementation is deliberately asymmetric here.
    const written = new TextDecoder().decode(new Uint8Array(encodeUdsk('abc')));
    expect(written).toBe('YWJj');
  });
});

describe('date and time', () => {
  it('reads big-endian unix seconds', () => {
    // b"c\x0f\xf6\x00" == 0x630FF600
    const { date } = decodeDateTimeZone(view(0x63, 0x0f, 0xf6, 0x00));
    expect(date?.getTime()).toBe(1_661_990_400_000);
  });

  it('treats zero as unset', () => {
    expect(decodeDateTimeZone(view(0, 0, 0, 0))).toEqual({ date: null, offsetHours: null });
  });

  it('reads the trailing byte as a signed hour offset', () => {
    expect(decodeDateTimeZone(view(0x63, 0x0f, 0xf6, 0x00, 0xfb)).offsetHours).toBe(-5);
  });
});

describe('name', () => {
  it('round-trips a legal name', () => {
    expect(decodeName(new DataView(encodeName('Anton (work)')))).toBe('Anton (work)');
  });

  it('strips trailing NULs left by a previous longer name', () => {
    expect(decodeName(view(0x45, 0x6d, 0x62, 0x65, 0x72, 0x00, 0x00))).toBe('Ember');
  });

  it('rejects illegal characters, empty and over-long names', () => {
    expect(() => encodeName('')).toThrow(EmberError);
    expect(() => encodeName('a'.repeat(17))).toThrow(EmberError);
    expect(() => encodeName('caffè')).toThrow(EmberError);
  });
});

describe('unit and volume', () => {
  it('maps 0 to Celsius and anything else to Fahrenheit', () => {
    expect(decodeTemperatureUnit(view(0))).toBe(TemperatureUnit.CELSIUS);
    expect(decodeTemperatureUnit(view(1))).toBe(TemperatureUnit.FAHRENHEIT);
    expect(bytesOf(encodeTemperatureUnit(TemperatureUnit.FAHRENHEIT))).toEqual([1]);
    expect(bytesOf(encodeTemperatureUnit(TemperatureUnit.CELSIUS))).toEqual([0]);
  });

  it('round-trips volume levels and rejects anything else', () => {
    expect(decodeVolumeLevel(view(2))).toBe(VolumeLevel.HIGH);
    expect(decodeVolumeLevel(view(5))).toBeNull();
    expect(bytesOf(encodeVolumeLevel(VolumeLevel.MEDIUM))).toEqual([1]);
    expect(() => encodeVolumeLevel(7 as VolumeLevel)).toThrow(EmberError);
  });
});

describe('LED colour', () => {
  it('decodes RGBA and formats hex without the alpha', () => {
    // b"\xf4\x00\xa1\xff"
    const colour = decodeColour(view(0xf4, 0x00, 0xa1, 0xff));
    expect(colour).toEqual({ red: 244, green: 0, blue: 161, brightness: 255 });
    expect(colourToHex(colour)).toBe('#f400a1');
  });

  it('defaults brightness when the value is only three bytes', () => {
    expect(decodeColour(view(1, 2, 3)).brightness).toBe(255);
  });

  it('encodes four bytes and validates the range', () => {
    expect(bytesOf(encodeColour({ red: 244, green: 0, blue: 161, brightness: 255 }))).toEqual([
      0xf4, 0x00, 0xa1, 0xff,
    ]);
    expect(() => encodeColour({ red: 300, green: 0, blue: 0, brightness: 255 })).toThrow(EmberError);
  });

  it('parses hex input', () => {
    expect(hexToColour('#f400a1')).toEqual({ red: 244, green: 0, blue: 161, brightness: 255 });
    expect(() => hexToColour('nope')).toThrow(EmberError);
  });
});

describe('push events', () => {
  it('reads the event id from the first byte', () => {
    expect(decodePushEvent(view(PushEventId.LIQUID_STATE_CHANGED))).toBe(
      PushEventId.LIQUID_STATE_CHANGED,
    );
  });

  it('rejects ids outside the known range', () => {
    expect(decodePushEvent(view(0))).toBeNull();
    expect(decodePushEvent(view(42))).toBeNull();
  });
});

describe('advertisement integers', () => {
  it('reads a one-byte payload as a signed big-endian integer', () => {
    // 0x81 is -127, which is how the short-form model id is interpreted.
    expect(readIntBE(new Uint8Array([0x81]), true)).toBe(-127);
    expect(readIntBE(new Uint8Array([0x81]), false)).toBe(129);
  });

  it('reads multi-byte payloads big-endian', () => {
    expect(readIntBE(new Uint8Array([0x01, 0x00]), true)).toBe(256);
  });
});
