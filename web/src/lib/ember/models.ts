/**
 * Model catalogue and the capability matrix that decides which controls render.
 *
 * Mirrors `ModelInfo.device_attributes` from `python-ember-mug`, with one deliberate
 * correction: the reference implementation's `elif` makes its second "unknown model"
 * branch unreachable, so an unrecognised device silently loses its name attribute.
 * Here an unknown model keeps the full mug attribute set and the actual GATT probe
 * decides what is really there.
 */

import { DeviceModel, DeviceType } from './constants.js';
import type { Attribute } from './types.js';
import { Char, type CharId } from './uuids.js';

export interface ModelSpec {
  model: DeviceModel;
  deviceType: DeviceType;
  displayName: string;
  capacityMl: number;
  /** Full-scale reading of the liquid-level characteristic. */
  liquidLevelMax: 30 | 100;
  attributes: ReadonlySet<Attribute>;
}

/** Attributes present on every device, before per-model adjustments. */
const BASE_ATTRIBUTES: readonly Attribute[] = [
  'name',
  'ledColour',
  'currentTemp',
  'targetTemp',
  'temperatureUnit',
  'battery',
  'liquidLevel',
  'liquidState',
  'meta',
  'firmware',
  'dsk',
  'udsk',
  'dateTimeZone',
];

function attributesFor(deviceType: DeviceType, model: DeviceModel | null): ReadonlySet<Attribute> {
  const attrs = new Set<Attribute>(BASE_ATTRIBUTES);

  if (deviceType === DeviceType.CUP || deviceType === DeviceType.TUMBLER) {
    // The Cup and Tumbler have no display and cannot be named.
    attrs.delete('name');
  } else if (deviceType === DeviceType.TRAVEL_MUG) {
    // The Travel Mug has no front LED but does have a button-beep volume.
    attrs.delete('ledColour');
    attrs.add('volumeLevel');
  }

  // Only the Travel Mug exposes a usable battery voltage register.
  if (model === DeviceModel.TRAVEL_MUG_12_OZ) attrs.add('batteryVoltage');

  return attrs;
}

function spec(
  model: DeviceModel,
  deviceType: DeviceType,
  displayName: string,
  capacityMl: number,
  liquidLevelMax: 30 | 100 = 30,
): ModelSpec {
  return {
    model,
    deviceType,
    displayName,
    capacityMl,
    liquidLevelMax,
    attributes: attributesFor(deviceType, model),
  };
}

export const MODELS: Readonly<Record<DeviceModel, ModelSpec>> = {
  [DeviceModel.CUP_6_OZ]: spec(DeviceModel.CUP_6_OZ, DeviceType.CUP, 'Ember Cup', 178),
  [DeviceModel.MUG_1_10_OZ]: spec(DeviceModel.MUG_1_10_OZ, DeviceType.MUG, 'Ember Mug (10oz)', 295),
  [DeviceModel.MUG_1_14_OZ]: spec(DeviceModel.MUG_1_14_OZ, DeviceType.MUG, 'Ember Mug (14oz)', 414),
  [DeviceModel.MUG_2_10_OZ]: spec(
    DeviceModel.MUG_2_10_OZ,
    DeviceType.MUG,
    'Ember Mug 2 (10oz)',
    295,
  ),
  [DeviceModel.MUG_2_14_OZ]: spec(
    DeviceModel.MUG_2_14_OZ,
    DeviceType.MUG,
    'Ember Mug 2 (14oz)',
    414,
  ),
  [DeviceModel.TRAVEL_MUG_12_OZ]: spec(
    DeviceModel.TRAVEL_MUG_12_OZ,
    DeviceType.TRAVEL_MUG,
    'Ember Travel Mug',
    355,
    100,
  ),
  [DeviceModel.TUMBLER_16_OZ]: spec(
    DeviceModel.TUMBLER_16_OZ,
    DeviceType.TUMBLER,
    'Ember Tumbler',
    473,
  ),
};

export const ALL_MODELS: readonly ModelSpec[] = Object.values(MODELS);

/** Fallback when the model is unknown: assume a mug and let the GATT probe trim it. */
export const DEFAULT_ATTRIBUTES: ReadonlySet<Attribute> = attributesFor(DeviceType.MUG, null);

export function liquidLevelMaxFor(deviceType: DeviceType): 30 | 100 {
  return deviceType === DeviceType.TRAVEL_MUG ? 100 : 30;
}

/** Which characteristics an attribute needs before it can be considered present. */
export const ATTRIBUTE_CHARS: Readonly<Record<Attribute, readonly CharId[]>> = {
  name: [Char.MUG_NAME],
  ledColour: [Char.LED],
  currentTemp: [Char.CURRENT_TEMPERATURE],
  targetTemp: [Char.TARGET_TEMPERATURE],
  temperatureUnit: [Char.TEMPERATURE_UNIT],
  battery: [Char.BATTERY],
  liquidLevel: [Char.LIQUID_LEVEL],
  liquidState: [Char.LIQUID_STATE],
  volumeLevel: [Char.VOLUME],
  batteryVoltage: [Char.CONTROL_REGISTER_DATA],
  dateTimeZone: [Char.DATE_TIME_AND_ZONE],
  firmware: [Char.FIRMWARE],
  meta: [Char.MUG_ID],
  dsk: [Char.DSK],
  udsk: [Char.UDSK],
};

const CHAR_TO_ATTRIBUTE = new Map<CharId, Attribute>(
  (Object.entries(ATTRIBUTE_CHARS) as Array<[Attribute, readonly CharId[]]>).flatMap(
    ([attr, chars]) => chars.map((c) => [c, attr] as const),
  ),
);

export function attributeForChar(id: CharId): Attribute | undefined {
  return CHAR_TO_ATTRIBUTE.get(id);
}

/**
 * Resolves what this specific device can actually do.
 *
 * The model table says what the product *should* have; the characteristic index says
 * what this unit really exposes. The intersection wins, so an unrecognised model still
 * produces a working app instead of an empty one.
 */
export function resolveCapabilities(
  model: DeviceModel | null,
  presentChars: ReadonlySet<CharId>,
): ReadonlySet<Attribute> {
  const declared = model ? MODELS[model].attributes : DEFAULT_ATTRIBUTES;
  const supported = new Set<Attribute>();
  for (const attr of declared) {
    if (ATTRIBUTE_CHARS[attr].every((c) => presentChars.has(c))) supported.add(attr);
  }
  return supported;
}
