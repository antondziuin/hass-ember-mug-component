/**
 * Builds a characteristic lookup for a connected device.
 *
 * Enumerating once beats probing: `service.getCharacteristic(uuid)` throws `NotFoundError`
 * on a miss and Chrome logs every one of those to the console, so speculatively asking for
 * twenty characteristics produces a wall of noise. Enumerating also sidesteps the open
 * question of which service holds characteristics 1-20 on a Travel Mug.
 *
 * Characteristic objects are invalidated by every disconnect, so this is rebuilt on each
 * connection.
 */

import type { GattCharacteristicLike, GattServerLike, GattServiceLike } from './bluetooth.js';
import { DISCOVER_TIMEOUT_MS } from './constants.js';
import type { GattQueue } from './gattQueue.js';
import { UUID_TO_CHAR, type CharId } from './uuids.js';

export interface CharIndex {
  byId: ReadonlyMap<CharId, GattCharacteristicLike>;
  present: ReadonlySet<CharId>;
  services: ReadonlySet<string>;
  /** Characteristics this app does not recognise. Surfaced in diagnostics. */
  unknownCharUuids: readonly string[];
}

function isNotFound(error: unknown): boolean {
  return (error as DOMException | undefined)?.name === 'NotFoundError';
}

export async function buildCharIndex(
  server: GattServerLike,
  queue: GattQueue,
): Promise<CharIndex> {
  const byId = new Map<CharId, GattCharacteristicLike>();
  const services = new Set<string>();
  const unknownCharUuids: string[] = [];

  // getPrimaryServices() rejects with NotFoundError when nothing matches, rather than
  // returning an empty list, so it needs a guard of its own.
  const found = await queue.run(
    'getPrimaryServices',
    async () => {
      try {
        return await server.getPrimaryServices();
      } catch (error) {
        if (isNotFound(error)) return [] as GattServiceLike[];
        throw error;
      }
    },
    { timeoutMs: DISCOVER_TIMEOUT_MS, retries: 1 },
  );

  for (const service of found) {
    services.add(service.uuid);
    const chars = await queue.run(`getCharacteristics(${service.uuid})`, async () => {
      try {
        return await service.getCharacteristics();
      } catch (error) {
        if (isNotFound(error)) return [] as GattCharacteristicLike[];
        throw error;
      }
    });

    for (const characteristic of chars) {
      const id = UUID_TO_CHAR.get(characteristic.uuid);
      if (id === undefined) {
        unknownCharUuids.push(characteristic.uuid);
      } else if (!byId.has(id)) {
        byId.set(id, characteristic);
      }
    }
  }

  return { byId, present: new Set(byId.keys()), services, unknownCharUuids };
}
