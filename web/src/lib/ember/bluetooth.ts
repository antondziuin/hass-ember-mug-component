/**
 * Structural subsets of the Web Bluetooth interfaces.
 *
 * The device layer is written against these rather than the DOM types so a fake can be
 * substituted wholesale in tests and in the offline demo mode. Real `BluetoothDevice`
 * objects satisfy them structurally.
 */

export interface GattCharacteristicLike {
  readonly uuid: string;
  readonly value?: DataView | undefined;
  readValue(): Promise<DataView>;
  writeValue(value: BufferSource): Promise<void>;
  writeValueWithResponse?(value: BufferSource): Promise<void>;
  startNotifications(): Promise<unknown>;
  stopNotifications(): Promise<unknown>;
  addEventListener(type: 'characteristicvaluechanged', listener: (event: Event) => void): void;
  removeEventListener(type: 'characteristicvaluechanged', listener: (event: Event) => void): void;
}

export interface GattServiceLike {
  readonly uuid: string;
  getCharacteristics(): Promise<GattCharacteristicLike[]>;
}

export interface GattServerLike {
  readonly connected: boolean;
  connect(): Promise<GattServerLike>;
  disconnect(): void;
  getPrimaryServices(): Promise<GattServiceLike[]>;
}

export interface BluetoothDeviceLike {
  readonly id: string;
  readonly name?: string | undefined;
  readonly gatt?: GattServerLike | undefined;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/** Chrome 85+ exposes an explicit acknowledged write; older engines only have writeValue. */
export function writeCharacteristic(
  characteristic: GattCharacteristicLike,
  data: BufferSource,
): Promise<void> {
  if (typeof characteristic.writeValueWithResponse === 'function') {
    return characteristic.writeValueWithResponse(data);
  }
  return characteristic.writeValue(data);
}
