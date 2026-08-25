import { describe, expect, it } from 'vitest';

import { DeviceColour, DeviceModel, DeviceType } from '../constants.js';
import { colourFromInt, detectModel, modelFromIdAndGeneration, modelFromSingleInt } from '../detectModel.js';
import { DEFAULT_ATTRIBUTES, MODELS, resolveCapabilities } from '../models.js';
import { Char, SERVICE, type CharId } from '../uuids.js';

const chars = (...ids: CharId[]): ReadonlySet<CharId> => new Set(ids);

const MUG_CHARS = chars(
  Char.MUG_NAME,
  Char.CURRENT_TEMPERATURE,
  Char.TARGET_TEMPERATURE,
  Char.TEMPERATURE_UNIT,
  Char.LIQUID_LEVEL,
  Char.LIQUID_STATE,
  Char.BATTERY,
  Char.LED,
  Char.FIRMWARE,
  Char.MUG_ID,
  Char.DSK,
  Char.UDSK,
  Char.DATE_TIME_AND_ZONE,
);

/** Builds a manufacturer-data view at a non-zero offset, as Chrome would deliver it. */
function mfr(...bytes: number[]): DataView {
  const padded = new Uint8Array(bytes.length + 3);
  padded.set(bytes, 3);
  return new DataView(padded.buffer, 3, bytes.length);
}

describe('advertisement lookup tables', () => {
  it('maps the long-form model id and generation', () => {
    expect(modelFromIdAndGeneration(1, 1)).toBe(DeviceModel.MUG_1_10_OZ);
    expect(modelFromIdAndGeneration(1, 2)).toBe(DeviceModel.MUG_2_10_OZ);
    expect(modelFromIdAndGeneration(2, 1)).toBe(DeviceModel.MUG_1_14_OZ);
    expect(modelFromIdAndGeneration(120, 3)).toBe(DeviceModel.MUG_2_14_OZ);
    expect(modelFromIdAndGeneration(3, 1)).toBe(DeviceModel.TRAVEL_MUG_12_OZ);
    expect(modelFromIdAndGeneration(8, 1)).toBe(DeviceModel.CUP_6_OZ);
    expect(modelFromIdAndGeneration(9, 1)).toBe(DeviceModel.TUMBLER_16_OZ);
    expect(modelFromIdAndGeneration(42, 1)).toBeNull();
  });

  it('maps the short-form signed model id', () => {
    expect(modelFromSingleInt(-127, false)).toBe(DeviceModel.MUG_2_10_OZ);
    expect(modelFromSingleInt(65, false)).toBe(DeviceModel.MUG_1_14_OZ);
    expect(modelFromSingleInt(-60, false)).toBe(DeviceModel.CUP_6_OZ);
    // The travel-mug service overrides the integer entirely.
    expect(modelFromSingleInt(65, true)).toBe(DeviceModel.TRAVEL_MUG_12_OZ);
  });

  it('resolves colours, including the overlapping aliases', () => {
    expect(colourFromInt(-127)).toBe(DeviceColour.BLACK);
    expect(colourFromInt(130)).toBe(DeviceColour.WHITE);
    // -63 appears in both the black and red lists; black is checked first upstream.
    expect(colourFromInt(-63)).toBe(DeviceColour.BLACK);
    expect(colourFromInt(-52)).toBe(DeviceColour.SAGE_GREEN);
    expect(colourFromInt(999)).toBeNull();
  });
});

describe('detectModel', () => {
  it('lets an explicit override win over everything else', () => {
    const result = detectModel({
      override: DeviceModel.MUG_1_14_OZ,
      bleName: 'Ember Travel Mug',
      presentChars: chars(Char.VOLUME),
    });
    expect(result.model).toBe(DeviceModel.MUG_1_14_OZ);
    expect(result.source).toBe('user-override');
    expect(result.confidence).toBe('exact');
  });

  it('reads the exact model and colour from long-form manufacturer data', () => {
    // byte 0 ignored, then model 1, generation 2, colour -52 (0xcc) => Mug 2 10oz, sage green.
    const result = detectModel({ manufacturerData: mfr(0x01, 0x01, 0x02, 0xcc) });
    expect(result.model).toBe(DeviceModel.MUG_2_10_OZ);
    expect(result.source).toBe('advertisement');
  });

  it('reads the short-form payload as a signed integer', () => {
    // 0x81 is -127.
    const result = detectModel({ manufacturerData: mfr(0x81) });
    expect(result.model).toBe(DeviceModel.MUG_2_10_OZ);
    expect(result.colour).toBe(DeviceColour.BLACK);
  });

  it('identifies a Travel Mug from its service alone', () => {
    const result = detectModel({ services: new Set([SERVICE.TRAVEL_MUG]) });
    expect(result.model).toBe(DeviceModel.TRAVEL_MUG_12_OZ);
    expect(result.source).toBe('gatt-probe');
  });

  it('identifies a Travel Mug from a volume characteristic or a missing LED', () => {
    expect(detectModel({ presentChars: chars(Char.VOLUME, Char.LED) }).model).toBe(
      DeviceModel.TRAVEL_MUG_12_OZ,
    );
    expect(detectModel({ presentChars: chars(Char.MUG_NAME, Char.BATTERY) }).model).toBe(
      DeviceModel.TRAVEL_MUG_12_OZ,
    );
  });

  it('falls back to the advertised local name', () => {
    expect(detectModel({ presentChars: MUG_CHARS, bleName: 'Ember Cup' }).model).toBe(
      DeviceModel.CUP_6_OZ,
    );
    expect(detectModel({ presentChars: MUG_CHARS, bleName: 'Ember Tumbler' }).model).toBe(
      DeviceModel.TUMBLER_16_OZ,
    );
  });

  it('reports a mug family when the size and generation are unknowable', () => {
    const result = detectModel({ presentChars: MUG_CHARS, bleName: 'Ember Ceramic Mug' });
    expect(result.model).toBeNull();
    expect(result.deviceType).toBe(DeviceType.MUG);
    expect(result.confidence).toBe('family');
    expect(result.ambiguous).toHaveLength(4);
  });

  it('degrades to a guess with no signal at all', () => {
    const result = detectModel({});
    expect(result.confidence).toBe('guess');
    expect(result.deviceType).toBe(DeviceType.MUG);
  });
});

describe('resolveCapabilities', () => {
  it('intersects the model table with what the device actually exposes', () => {
    const caps = resolveCapabilities(DeviceModel.MUG_2_10_OZ, MUG_CHARS);
    expect(caps.has('name')).toBe(true);
    expect(caps.has('ledColour')).toBe(true);
    expect(caps.has('targetTemp')).toBe(true);
    // Declared for the model but not present on this unit.
    expect(caps.has('volumeLevel')).toBe(false);
    expect(caps.has('batteryVoltage')).toBe(false);
  });

  it('drops an attribute whose characteristic is missing', () => {
    const withoutLed = new Set(MUG_CHARS);
    withoutLed.delete(Char.LED);
    expect(resolveCapabilities(DeviceModel.MUG_2_10_OZ, withoutLed).has('ledColour')).toBe(false);
  });

  it('gives an unknown model the full mug set, trimmed by the probe', () => {
    const caps = resolveCapabilities(null, MUG_CHARS);
    expect(caps.has('name')).toBe(true);
    expect(DEFAULT_ATTRIBUTES.has('name')).toBe(true);
  });

  it('models the per-device attribute matrix', () => {
    expect(MODELS[DeviceModel.CUP_6_OZ].attributes.has('name')).toBe(false);
    expect(MODELS[DeviceModel.TUMBLER_16_OZ].attributes.has('name')).toBe(false);
    expect(MODELS[DeviceModel.TRAVEL_MUG_12_OZ].attributes.has('ledColour')).toBe(false);
    expect(MODELS[DeviceModel.TRAVEL_MUG_12_OZ].attributes.has('volumeLevel')).toBe(true);
    expect(MODELS[DeviceModel.TRAVEL_MUG_12_OZ].attributes.has('batteryVoltage')).toBe(true);
    expect(MODELS[DeviceModel.MUG_2_10_OZ].attributes.has('batteryVoltage')).toBe(false);
    expect(MODELS[DeviceModel.TRAVEL_MUG_12_OZ].liquidLevelMax).toBe(100);
    expect(MODELS[DeviceModel.MUG_2_10_OZ].liquidLevelMax).toBe(30);
  });
});
