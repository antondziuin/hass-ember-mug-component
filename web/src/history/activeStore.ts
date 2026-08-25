/**
 * Which history backend is in use, and how to build it.
 *
 * The remote backends are wrapped in an outbox so a write never depends on the network
 * being up: rows land in IndexedDB first and drain when the target is reachable.
 */

import type { KeyValueStore } from '../lib/ember/types.js';

import type { HistoryStore } from './HistoryStore.js';
import { IndexedDbStore } from './stores/indexeddb/IndexedDbStore.js';

export type StoreConfig =
  | { kind: 'indexeddb' }
  | { kind: 'server'; baseUrl: string; token?: string }
  | { kind: 'supabase'; url: string; anonKey: string };

const CONFIG_KEY = 'ember.historyStore';

export const DEFAULT_STORE_CONFIG: StoreConfig = { kind: 'indexeddb' };

export function loadStoreConfig(kv: KeyValueStore): StoreConfig {
  const raw = kv.get(CONFIG_KEY);
  if (!raw) return DEFAULT_STORE_CONFIG;
  try {
    const parsed = JSON.parse(raw) as StoreConfig;
    if (parsed.kind === 'server' && typeof parsed.baseUrl === 'string') return parsed;
    if (parsed.kind === 'supabase' && typeof parsed.url === 'string') return parsed;
    return DEFAULT_STORE_CONFIG;
  } catch {
    return DEFAULT_STORE_CONFIG;
  }
}

export function saveStoreConfig(kv: KeyValueStore, config: StoreConfig): void {
  kv.set(CONFIG_KEY, JSON.stringify(config));
}

export function describeStoreConfig(config: StoreConfig): string {
  switch (config.kind) {
    case 'indexeddb':
      return 'This browser only';
    case 'server':
      return config.baseUrl;
    case 'supabase':
      return new URL(config.url).host;
  }
}

/** The local store is always created: remote backends use it as their outbox. */
export async function createLocalStore(): Promise<IndexedDbStore> {
  const store = new IndexedDbStore();
  await store.open();
  return store;
}

export async function createStore(config: StoreConfig): Promise<HistoryStore> {
  const local = await createLocalStore();
  if (config.kind === 'indexeddb') return local;

  // Loaded on demand so a browser-only setup never pays for the remote code.
  const { OutboxStore } = await import('./stores/OutboxStore.js');

  if (config.kind === 'server') {
    const { HttpStore } = await import('./stores/http/HttpStore.js');
    const remote = new HttpStore({
      baseUrl: config.baseUrl,
      ...(config.token ? { token: config.token } : {}),
    });
    return new OutboxStore(remote, local);
  }

  const { SupabaseStore } = await import('./stores/supabase/SupabaseStore.js');
  const remote = new SupabaseStore({ url: config.url, anonKey: config.anonKey });
  return new OutboxStore(remote, local);
}
