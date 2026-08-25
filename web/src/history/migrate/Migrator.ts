/**
 * Moves history from one backend to another.
 *
 * Because export and import are both on `HistoryStore`, this has no per-backend code at
 * all: local to Supabase, server to local and Supabase to server are the same path.
 *
 * Idempotency is structural rather than bolted on - samples upsert on `(deviceId, ts)`
 * and events carry both a client-minted id and a unique natural key - so replaying any
 * batch is a no-op and a resumed run cannot double-count.
 */

import type {
  ExportKind,
  HistoryStore,
  ImportProgress,
} from '../HistoryStore.js';
import type { DeviceId, Millis } from '../types.js';

export interface MigrationWarning {
  code: 'quota_tight' | 'target_not_empty' | 'source_empty' | 'schema';
  message: string;
}

export interface MigrationPlan {
  sourceId: string;
  targetId: string;
  devices: Array<{
    deviceId: DeviceId;
    name: string | null;
    samples: number;
    events: number;
    minTs: Millis;
    maxTs: Millis;
    existingInTarget: { samples: number; minTs: Millis; maxTs: Millis } | null;
  }>;
  totalRows: number;
  resumeFrom: MigrationCheckpoint | null;
  warnings: MigrationWarning[];
}

export interface MigrationCheckpoint {
  sourceId: string;
  targetId: string;
  phase: ExportKind;
  deviceId: DeviceId | null;
  lastTs: Millis | null;
  rowsDone: number;
  updatedAt: Millis;
}

export type MigrationEvent =
  | { type: 'plan'; plan: MigrationPlan }
  | {
      type: 'progress';
      phase: ExportKind;
      deviceId?: DeviceId;
      rowsDone: number;
      rowsTotal: number;
      deduped: number;
      rowsPerSec: number;
    }
  | { type: 'retry'; attempt: number; delayMs: number; error: string }
  | {
      type: 'verified';
      perDevice: Array<{
        deviceId: DeviceId;
        sourceCount: number;
        targetCount: number;
        ok: boolean;
      }>;
    }
  | { type: 'done'; rowsCopied: number; rowsDeduped: number; durationMs: number }
  | { type: 'failed'; phase: ExportKind; lastTs: Millis | null; error: string; resumable: boolean };

export interface MigratorOptions {
  /** Where checkpoints live. localStorage by default: small, synchronous, and it survives
   *  the IndexedDB that may itself be the thing being repaired. */
  checkpointStore?: { get(key: string): string | null; set(key: string, value: string): void; remove(key: string): void };
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_DELAYS = [250, 1_000, 4_000];

const defaultCheckpointStore = {
  get: (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string): void => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // A full or blocked storage just means the run is not resumable.
    }
  },
  remove: (key: string): void => {
    try {
      localStorage.removeItem(key);
    } catch {
      // As above.
    }
  },
};

export class Migrator {
  readonly #source: HistoryStore;
  readonly #target: HistoryStore;
  readonly #checkpoints: NonNullable<MigratorOptions['checkpointStore']>;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(source: HistoryStore, target: HistoryStore, options: MigratorOptions = {}) {
    this.#source = source;
    this.#target = target;
    this.#checkpoints = options.checkpointStore ?? defaultCheckpointStore;
    this.#now = options.now ?? Date.now;
    this.#sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  get checkpointKey(): string {
    return `mug.migration.${this.#source.id}->${this.#target.id}`;
  }

  readCheckpoint(): MigrationCheckpoint | null {
    const raw = this.#checkpoints.get(this.checkpointKey);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as MigrationCheckpoint;
    } catch {
      return null;
    }
  }

  clearCheckpoint(): void {
    this.#checkpoints.remove(this.checkpointKey);
  }

  async plan(): Promise<MigrationPlan> {
    const warnings: MigrationWarning[] = [];
    const sourceDevices = await this.#source.listDevices();
    const targetDevices = await this.#target.listDevices().catch(() => []);
    const targetIds = new Set(targetDevices.map((d) => d.deviceId));

    const devices: MigrationPlan['devices'] = [];
    let totalRows = 0;

    for (const device of sourceDevices) {
      const bounds = await this.#source.bounds(device.deviceId);
      if (!bounds) continue;
      const existing = targetIds.has(device.deviceId)
        ? await this.#target.bounds(device.deviceId).catch(() => null)
        : null;

      devices.push({
        deviceId: device.deviceId,
        name: device.name,
        samples: bounds.sampleCount,
        events: bounds.eventCount,
        minTs: bounds.minTs,
        maxTs: bounds.maxTs,
        existingInTarget: existing
          ? { samples: existing.sampleCount, minTs: existing.minTs, maxTs: existing.maxTs }
          : null,
      });
      totalRows += bounds.sampleCount + bounds.eventCount;
    }

    if (devices.length === 0) {
      warnings.push({ code: 'source_empty', message: 'There is nothing to copy.' });
    }
    if (devices.some((d) => d.existingInTarget && d.existingInTarget.samples > 0)) {
      warnings.push({
        code: 'target_not_empty',
        message: 'The target already holds some of these readings. Duplicates are skipped.',
      });
    }

    // Copying into the browser can run into the storage quota; warn before starting
    // rather than failing part-way.
    if (this.#target.kind === 'indexeddb' && typeof navigator !== 'undefined') {
      const estimate = await navigator.storage?.estimate?.().catch(() => null);
      if (estimate?.quota && estimate.usage !== undefined) {
        const projected = estimate.usage + totalRows * 120;
        if (projected > estimate.quota * 0.7) {
          warnings.push({
            code: 'quota_tight',
            message: 'This may not fit in the browser storage quota. Consider exporting instead.',
          });
        }
      }
    }

    return {
      sourceId: this.#source.id,
      targetId: this.#target.id,
      devices,
      totalRows,
      resumeFrom: this.readCheckpoint(),
      warnings,
    };
  }

  async *run(options: { resume?: boolean; batchRows?: number } = {}): AsyncIterable<MigrationEvent> {
    const started = this.#now();
    const plan = await this.plan();
    yield { type: 'plan', plan };

    const checkpoint = options.resume === false ? null : plan.resumeFrom;
    const from = checkpoint?.lastTs != null ? checkpoint.lastTs + 1 : undefined;

    let rowsCopied = checkpoint?.rowsDone ?? 0;
    let rowsDeduped = 0;
    let lastPhase: ExportKind = 'devices';
    let lastTs: Millis | null = checkpoint?.lastTs ?? null;

    try {
      const query = {
        ...(from !== undefined ? { from } : {}),
        ...(options.batchRows ? { batchRows: options.batchRows } : {}),
      };
      const source = this.#source.exportStream(query);

      for await (const progress of this.#importWithRetry(source)) {
        lastPhase = progress.kind;
        rowsCopied += progress.rowsAccepted;
        rowsDeduped += progress.rowsDeduped;
        if (progress.lastTs !== undefined) lastTs = progress.lastTs;

        // Checkpointed after every committed batch, so an interrupted run resumes rather
        // than restarting.
        this.#checkpoints.set(
          this.checkpointKey,
          JSON.stringify({
            sourceId: this.#source.id,
            targetId: this.#target.id,
            phase: progress.kind,
            deviceId: progress.deviceId ?? null,
            lastTs,
            rowsDone: rowsCopied,
            updatedAt: this.#now(),
          } satisfies MigrationCheckpoint),
        );

        const elapsed = Math.max(this.#now() - started, 1);
        yield {
          type: 'progress',
          phase: progress.kind,
          ...(progress.deviceId ? { deviceId: progress.deviceId } : {}),
          rowsDone: rowsCopied,
          rowsTotal: Math.max(plan.totalRows, rowsCopied),
          deduped: rowsDeduped,
          rowsPerSec: (rowsCopied / elapsed) * 1000,
        };
      }
    } catch (error) {
      yield {
        type: 'failed',
        phase: lastPhase,
        lastTs,
        error: error instanceof Error ? error.message : String(error),
        resumable: true,
      };
      return;
    }

    const verified = await this.verify();
    yield verified;

    if (verified.perDevice.every((d) => d.ok)) {
      this.clearCheckpoint();
    }
    yield {
      type: 'done',
      rowsCopied,
      rowsDeduped,
      durationMs: this.#now() - started,
    };
  }

  /**
   * Retries a batch on a transient failure, but stops immediately on a 4xx-style error:
   * a schema mismatch must not be retried three thousand times.
   */
  async *#importWithRetry(
    source: AsyncIterable<import('../HistoryStore.js').ExportChunk>,
  ): AsyncIterable<ImportProgress> {
    let attempt = 0;
    for (;;) {
      try {
        for await (const progress of this.#target.importStream(source)) {
          attempt = 0;
          yield progress;
        }
        return;
      } catch (error) {
        const status = (error as { status?: number }).status;
        const retryable = status === undefined || status >= 500 || status === 429;
        if (!retryable || attempt >= RETRY_DELAYS.length) throw error;
        await this.#sleep(RETRY_DELAYS[attempt]!);
        attempt += 1;
      }
    }
  }

  /** Compares per-device counts before the target is made active. */
  async verify(): Promise<Extract<MigrationEvent, { type: 'verified' }>> {
    const devices = await this.#source.listDevices();
    const perDevice: Array<{
      deviceId: DeviceId;
      sourceCount: number;
      targetCount: number;
      ok: boolean;
    }> = [];

    for (const device of devices) {
      const sourceBounds = await this.#source.bounds(device.deviceId);
      const targetBounds = await this.#target.bounds(device.deviceId).catch(() => null);
      const sourceCount = sourceBounds?.sampleCount ?? 0;
      const targetCount = targetBounds?.sampleCount ?? 0;
      perDevice.push({
        deviceId: device.deviceId,
        sourceCount,
        targetCount,
        // The target may legitimately hold more, from another browser.
        ok: targetCount >= sourceCount,
      });
    }

    return { type: 'verified', perDevice };
  }
}

/** Serialises a store to NDJSON, for a manual backup. */
export async function exportToNdjson(store: HistoryStore): Promise<Blob> {
  const lines: string[] = [];
  for await (const chunk of store.exportStream({})) {
    lines.push(JSON.stringify(chunk));
  }
  return new Blob([lines.join('\n')], { type: 'application/x-ndjson' });
}

/** Reads an NDJSON backup back in. */
export async function* readNdjson(
  file: Blob,
): AsyncIterable<import('../HistoryStore.js').ExportChunk> {
  const text = await file.text();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) yield JSON.parse(trimmed) as import('../HistoryStore.js').ExportChunk;
  }
}
