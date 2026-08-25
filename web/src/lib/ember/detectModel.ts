/**
 * Layered model detection.
 *
 * Manufacturer data - the only source that yields an exact model *and* the shell colour -
 * requires `watchAdvertisements()`, which is behind an experimental flag. So detection
 * degrades through progressively weaker signals and ends at a user-selectable override.
 */

import { DeviceColour, DeviceModel, DeviceType } from './constants.js';
import { readIntBE } from './codecs.js';
import { MODELS } from './models.js';
import type { ModelDetection } from './types.js';
import { Char, TRAVEL_MUG_SERVICES, type CharId } from './uuids.js';

export interface DetectModelInput {
  /** Persisted user choice. Wins unconditionally. */
  override?: DeviceModel | null;
  /** Ember-SIG manufacturer payload, when the experimental flag made it available. */
  manufacturerData?: DataView | null;
  /** Service UUIDs seen in the advertisement, if any. */
  advertisedServices?: readonly string[];
  /** Services and characteristics actually found on the connected device. */
  services?: ReadonlySet<string>;
  presentChars?: ReadonlySet<CharId>;
  /** The advertised local name, e.g. "Ember Ceramic Mug". Not the user-set device name. */
  bleName?: string | null;
  serialNumber?: string | null;
}

const MUG_FAMILY: DeviceModel[] = [
  DeviceModel.MUG_1_10_OZ,
  DeviceModel.MUG_1_14_OZ,
  DeviceModel.MUG_2_10_OZ,
  DeviceModel.MUG_2_14_OZ,
];

/**
 * Colour lookup from the advertisement. The table carries both signed and unsigned
 * aliases because the short and long payload formats interpret the byte differently.
 * Order matters: -63 is Black here, as in the reference implementation.
 */
export function colourFromInt(id: number): DeviceColour | null {
  if ([-127, -63, 1, 14, 65].includes(id)) return DeviceColour.BLACK;
  if ([-126, -62, 2, 130].includes(id)) return DeviceColour.WHITE;
  if ([-120, -117, -56, -53, 8, 11].includes(id)) return DeviceColour.RED;
  if ([-131, -125, -61, 3, 51, 83].includes(id)) return DeviceColour.COPPER;
  if ([-124, -60].includes(id)) return DeviceColour.ROSE_GOLD;
  if ([-123, -59].includes(id)) return DeviceColour.STAINLESS_STEEL;
  const rest: Record<number, DeviceColour> = {
    [-51]: DeviceColour.SANDSTONE,
    [-52]: DeviceColour.SAGE_GREEN,
    [-55]: DeviceColour.GREY,
    [-57]: DeviceColour.BLUE,
    [-122]: DeviceColour.GOLD,
  };
  return rest[id] ?? null;
}

/** Short (<4 byte) advertisement payload: one signed integer plus the advertised services. */
export function modelFromSingleInt(id: number, travelServiceSeen: boolean): DeviceModel | null {
  if (travelServiceSeen) return DeviceModel.TRAVEL_MUG_12_OZ;
  if ([1, 2, 3].includes(id)) return DeviceModel.MUG_1_10_OZ;
  if (id === 65) return DeviceModel.MUG_1_14_OZ;
  if ([-51, -59, -63, -61, -62, 120].includes(id)) return DeviceModel.MUG_2_14_OZ;
  if (id === -60) return DeviceModel.CUP_6_OZ;
  if (
    [-127, -126, -125, -124, -123, -122, -120, -117, -57, -56, -55, -53, -52, 83, 131].includes(id)
  ) {
    return DeviceModel.MUG_2_10_OZ;
  }
  return null;
}

/** Long (>=4 byte) advertisement payload: byte 0 is ignored, then model, generation, colour. */
export function modelFromIdAndGeneration(id: number, generation: number): DeviceModel | null {
  if (id === 1) return generation < 2 ? DeviceModel.MUG_1_10_OZ : DeviceModel.MUG_2_10_OZ;
  if (id === 2 || id === 120) return generation < 2 ? DeviceModel.MUG_1_14_OZ : DeviceModel.MUG_2_14_OZ;
  if (id === 3) return DeviceModel.TRAVEL_MUG_12_OZ;
  if (id === 8) return DeviceModel.CUP_6_OZ;
  if (id === 9) return DeviceModel.TUMBLER_16_OZ;
  return null;
}

/**
 * Serial-number prefix to model.
 *
 * Deliberately empty: Ember serials do encode the model, but the mapping is not known and
 * cannot be derived without hardware. The diagnostics panel exists so real serials can be
 * reported and this table grown.
 */
export const SERIAL_PREFIX_MODEL: ReadonlyArray<readonly [RegExp, DeviceModel]> = [];

function detectionFor(
  model: DeviceModel,
  source: ModelDetection['source'],
  colour: DeviceColour | null,
  confidence: ModelDetection['confidence'] = 'exact',
): ModelDetection {
  return {
    model,
    deviceType: MODELS[model].deviceType,
    colour,
    source,
    confidence,
    ambiguous: [],
  };
}

export function detectModel(input: DetectModelInput): ModelDetection {
  const {
    override,
    manufacturerData,
    advertisedServices = [],
    services = new Set<string>(),
    presentChars = new Set<CharId>(),
    bleName,
    serialNumber,
  } = input;

  // 0 - explicit user choice.
  if (override) return detectionFor(override, 'user-override', null);

  const travelServiceSeen =
    TRAVEL_MUG_SERVICES.some((uuid) => services.has(uuid)) ||
    TRAVEL_MUG_SERVICES.some((uuid) => advertisedServices.includes(uuid));

  // 1 - manufacturer data. The only path that also yields the shell colour.
  if (manufacturerData && manufacturerData.byteLength > 0) {
    const bytes = new Uint8Array(
      manufacturerData.buffer,
      manufacturerData.byteOffset,
      manufacturerData.byteLength,
    );
    if (bytes.length < 4) {
      const value = readIntBE(bytes, true);
      const model = modelFromSingleInt(value, travelServiceSeen);
      const colour = colourFromInt(value);
      if (model) return detectionFor(model, 'advertisement', colour);
    } else {
      const model = modelFromIdAndGeneration(bytes[1]!, bytes[2]!);
      const colour = colourFromInt(bytes[3]!);
      if (model) return detectionFor(model, 'advertisement', colour);
    }
  }

  // 2 - a travel-mug service is conclusive on its own.
  if (travelServiceSeen) return detectionFor(DeviceModel.TRAVEL_MUG_12_OZ, 'gatt-probe', null);

  // 3 - characteristic probe. A volume characteristic, or a missing LED, means Travel Mug.
  // Cup, Tumbler and Mug expose identical characteristic sets, so this can go no further.
  if (presentChars.size > 0) {
    if (presentChars.has(Char.VOLUME) || !presentChars.has(Char.LED)) {
      return detectionFor(DeviceModel.TRAVEL_MUG_12_OZ, 'gatt-probe', null);
    }
  }

  // 4 - advertised local name, which is model-derived rather than user-set.
  const name = bleName ?? '';
  if (/travel/i.test(name)) return detectionFor(DeviceModel.TRAVEL_MUG_12_OZ, 'ble-name', null);
  if (/tumbler/i.test(name)) return detectionFor(DeviceModel.TUMBLER_16_OZ, 'ble-name', null);
  if (/\bcup\b/i.test(name)) return detectionFor(DeviceModel.CUP_6_OZ, 'ble-name', null);

  // 5 - serial number prefix.
  if (serialNumber) {
    for (const [pattern, model] of SERIAL_PREFIX_MODEL) {
      if (pattern.test(serialNumber)) return detectionFor(model, 'serial', null);
    }
  }

  // 6 - it is some kind of mug. Which one is a question for the user.
  const nameSuggestsMug = /mug|ceramic/i.test(name);
  return {
    model: null,
    deviceType: DeviceType.MUG,
    colour: null,
    source: nameSuggestsMug ? 'ble-name' : 'default',
    confidence: nameSuggestsMug ? 'family' : 'guess',
    ambiguous: [...MUG_FAMILY],
  };
}
