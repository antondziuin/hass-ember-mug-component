/**
 * Device chooser, availability checks, and the flag-gated APIs we use when present.
 */

import { EmberError, classifyChooserError, type EmberFailure } from './errors.js';
import { ALL_EMBER_SERVICES, EMBER_COMPANY_ID, SERVICE } from './uuids.js';

/**
 * Filters are OR-ed, so all four identity signals are declared.
 *
 * A service-UUID filter alone is not enough: the Home Assistant integration's own
 * discovery matchers need local-name patterns *in addition to* service UUIDs, which is
 * direct evidence that real units sometimes advertise without the 128-bit UUID.
 */
export function emberFilters(): BluetoothLEScanFilter[] {
  return [
    { manufacturerData: [{ companyIdentifier: EMBER_COMPANY_ID }] },
    { services: [SERVICE.STANDARD] },
    { services: [SERVICE.TRAVEL_MUG] },
    { services: [SERVICE.TRAVEL_MUG_OTHER] },
    { namePrefix: 'Ember' },
  ];
}

export interface RequestOptions {
  /** Last resort: show every Bluetooth device, for a mug that refuses to appear. */
  acceptAll?: boolean;
}

export function supportsWebBluetooth(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.bluetooth?.requestDevice === 'function';
}

export function isSecureContextForBluetooth(): boolean {
  return typeof window === 'undefined' || window.isSecureContext;
}

/** `getDevices()` is behind chrome://flags/#enable-web-bluetooth-new-permissions-backend. */
export function canSilentlyReconnect(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof (navigator.bluetooth as { getDevices?: unknown } | undefined)?.getDevices === 'function'
  );
}

/** `watchAdvertisements()` is behind chrome://flags/#enable-experimental-web-platform-features. */
export function canWatchAdvertisements(): boolean {
  // `BluetoothDevice` is a type-only global in the DOM typings, so reach for the real
  // constructor through globalThis.
  const ctor = (globalThis as { BluetoothDevice?: { prototype?: Record<string, unknown> } })
    .BluetoothDevice;
  return typeof ctor?.prototype?.['watchAdvertisements'] === 'function';
}

export function unsupportedReason(): EmberFailure | null {
  if (!isSecureContextForBluetooth()) {
    return { kind: 'unsupported', reason: 'insecure-context' };
  }
  if (!supportsWebBluetooth()) {
    return { kind: 'unsupported', reason: 'no-web-bluetooth' };
  }
  return null;
}

/** Reports whether a Bluetooth radio is present and switched on, when the browser tells us. */
export async function hasBluetoothAdapter(): Promise<boolean> {
  if (!supportsWebBluetooth()) return false;
  if (typeof navigator.bluetooth.getAvailability !== 'function') return true;
  try {
    return await navigator.bluetooth.getAvailability();
  } catch {
    return true;
  }
}

/**
 * Opens the device chooser. Must be called from a user gesture.
 *
 * If Chrome rejects the manufacturer-data filter with a TypeError - the shape is newer
 * than the services/namePrefix filters and parity on Chrome Android is unverified - the
 * call is retried without it rather than failing outright.
 */
export async function requestEmberDevice(options: RequestOptions = {}): Promise<BluetoothDevice> {
  const unsupported = unsupportedReason();
  if (unsupported) throw new EmberError(unsupported);

  const optionalServices = [...ALL_EMBER_SERVICES];
  const started = Date.now();

  const attempt = async (filters: BluetoothLEScanFilter[] | null): Promise<BluetoothDevice> => {
    const requestOptions: RequestDeviceOptions = filters
      ? { filters, optionalServices }
      : { acceptAllDevices: true, optionalServices };
    return navigator.bluetooth.requestDevice(requestOptions);
  };

  try {
    return await attempt(options.acceptAll ? null : emberFilters());
  } catch (error) {
    if ((error as DOMException | undefined)?.name === 'TypeError' && !options.acceptAll) {
      const withoutManufacturerData = emberFilters().filter((f) => !('manufacturerData' in f));
      try {
        return await attempt(withoutManufacturerData);
      } catch (retryError) {
        throw new EmberError(classifyChooserError(retryError, Date.now() - started));
      }
    }
    throw new EmberError(classifyChooserError(error, Date.now() - started));
  }
}

/**
 * Devices this origin already has permission for. Empty unless the persistent-permissions
 * flag is enabled, in which case it is what makes reconnect-after-reload silent.
 */
export async function getPermittedDevices(): Promise<BluetoothDevice[]> {
  if (!canSilentlyReconnect()) return [];
  try {
    const getDevices = (
      navigator.bluetooth as unknown as { getDevices: () => Promise<BluetoothDevice[]> }
    ).getDevices;
    return await getDevices.call(navigator.bluetooth);
  } catch {
    return [];
  }
}

/**
 * Opportunistically grabs one advertisement so the exact model and shell colour can be
 * read from manufacturer data. Resolves null when the API is unavailable or nothing
 * arrives in time; never throws, and never blocks connecting.
 */
export async function tryReadManufacturerData(
  device: BluetoothDevice,
  timeoutMs = 4000,
): Promise<DataView | null> {
  if (!canWatchAdvertisements()) return null;

  const watchable = device as BluetoothDevice & {
    watchAdvertisements: (init?: { signal?: AbortSignal }) => Promise<void>;
  };

  const controller = new AbortController();
  return new Promise<DataView | null>((resolve) => {
    let done = false;
    const finish = (value: DataView | null): void => {
      if (done) return;
      done = true;
      device.removeEventListener('advertisementreceived', onAdvertisement as EventListener);
      controller.abort();
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    const onAdvertisement = (event: Event): void => {
      const data = (event as unknown as { manufacturerData?: Map<number, DataView> })
        .manufacturerData;
      finish(data?.get(EMBER_COMPANY_ID) ?? data?.get(0xffff) ?? null);
    };

    device.addEventListener('advertisementreceived', onAdvertisement as EventListener);
    watchable.watchAdvertisements({ signal: controller.signal }).catch(() => finish(null));
  });
}
