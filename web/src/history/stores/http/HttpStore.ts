/**
 * Talks to the bundled Node + SQLite service.
 *
 * Sample batches go over the wire as positional tuples rather than objects: about 40%
 * smaller, and the arity itself validates the shape.
 */

import { alignWindow } from '../../bucketing.js';
import { DEFAULT_QUERY_LIMIT, MAX_BATCH_ROWS } from '../../constants.js';
import type {
  AggregateQuery,
  DeleteQuery,
  EventQuery,
  ExportChunk,
  ExportQuery,
  HistoryStore,
  ImportOptions,
  ImportProgress,
  ProbeErrorCode,
  RangeQuery,
  SeriesQuery,
  StoreCapabilities,
  StoreKind,
  StoreProbe,
} from '../../HistoryStore.js';
import type {
  Aggregates,
  AppendResult,
  Bounds,
  DeviceEvent,
  DeviceId,
  DeviceRecord,
  Millis,
  Sample,
  SeriesFrame,
  SessionEndReason,
  SessionId,
  SessionRecord,
} from '../../types.js';

const CAPABILITIES: StoreCapabilities = {
  buckets: ['raw', '1m', '5m', '1h', '1d'],
  serverSideBucketing: true,
  serverSideStats: true,
  maxBatchRows: MAX_BATCH_ROWS.server,
  streamingExport: true,
  deleteRange: true,
  multiDevice: true,
  transactional: true,
};

/** `[ts, tempC, targetC, batteryDpc, liquidDpc, liquidState, batteryMv, flags, sessionId]` */
export type SampleTuple = [
  number,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number,
  string | null,
];

export const toSampleTuple = (s: Sample): SampleTuple => [
  s.ts,
  s.tempC,
  s.targetC,
  s.batteryDpc,
  s.liquidDpc,
  s.liquidState,
  s.batteryMv,
  s.flags,
  s.sessionId,
];

export const fromSampleTuple = (deviceId: DeviceId, t: SampleTuple): Sample => ({
  deviceId,
  ts: t[0],
  tempC: t[1],
  targetC: t[2],
  batteryDpc: t[3],
  liquidDpc: t[4],
  liquidState: t[5] as Sample['liquidState'],
  batteryMv: t[6],
  flags: t[7],
  sessionId: t[8],
});

export interface HttpStoreOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export class HttpStoreError extends Error {
  constructor(
    readonly code: ProbeErrorCode,
    message: string,
    readonly hint?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'HttpStoreError';
  }
}

/**
 * `fetch` throws an indistinguishable TypeError for a refused connection, a CORS
 * rejection and a blocked local-network request, so the origins have to be compared to
 * say anything useful.
 */
export function classifyFetchFailure(baseUrl: string, error: unknown): HttpStoreError {
  const message = error instanceof Error ? error.message : String(error);
  let target: URL | null = null;
  try {
    target = new URL(baseUrl);
  } catch {
    return new HttpStoreError('unknown', `"${baseUrl}" is not a valid URL.`);
  }

  const pageIsHttps = typeof location !== 'undefined' && location.protocol === 'https:';
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);

  if (pageIsHttps && target.protocol === 'http:' && loopback) {
    return new HttpStoreError(
      'mixed_content',
      'The browser blocked this page from reaching your local server.',
      'Open the app from the server itself - http://localhost:41821 - so the page and the API share an origin.',
    );
  }
  if (pageIsHttps && target.protocol === 'http:') {
    return new HttpStoreError(
      'mixed_content',
      'A secure page cannot call a plain http:// server.',
      'Serve the history server over https://, or run it on localhost and open the app from there.',
    );
  }
  return new HttpStoreError(
    'unreachable',
    `Could not reach ${target.origin}. ${message}`,
    'Is the server running? Try: npm run db:start',
  );
}

export class HttpStore implements HistoryStore {
  readonly kind: StoreKind = 'server';
  readonly id: string;

  readonly #baseUrl: string;
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: HttpStoreOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.id = `server:${this.#baseUrl}`;
  }

  async open(): Promise<void> {
    // Stateless; `probe()` is what verifies reachability.
  }

  async close(): Promise<void> {
    // Nothing to release.
  }

  #headers(json = true): HeadersInit {
    const headers: Record<string, string> = {};
    if (json) headers['content-type'] = 'application/json';
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;
    return headers;
  }

  async #request<T>(
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/api/v1${path}`, {
        ...init,
        headers: { ...this.#headers(init.body !== undefined), ...init.headers },
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw classifyFetchFailure(this.#baseUrl, error);
    }

    if (response.status === 401 || response.status === 403) {
      throw new HttpStoreError(
        'unauthorized',
        'The history server rejected the access token.',
        'Check the token in Settings against the one the server printed on startup.',
        response.status,
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new HttpStoreError(
        response.status >= 500 ? 'unreachable' : 'schema_mismatch',
        `Server returned ${response.status}. ${body.slice(0, 200)}`,
        undefined,
        response.status,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async probe(signal?: AbortSignal): Promise<StoreProbe> {
    const started = Date.now();
    try {
      const health = await this.#request<Partial<StoreProbe>>('/health', {}, signal);
      return {
        ok: true,
        kind: this.kind,
        id: this.id,
        latencyMs: Date.now() - started,
        schemaVersion: health.schemaVersion ?? 1,
        writable: health.writable ?? true,
        capabilities: CAPABILITIES,
        ...(health.usage ? { usage: health.usage } : {}),
      };
    } catch (error) {
      const failure =
        error instanceof HttpStoreError
          ? error
          : classifyFetchFailure(this.#baseUrl, error);
      return {
        ok: false,
        kind: this.kind,
        id: this.id,
        latencyMs: Date.now() - started,
        schemaVersion: 0,
        writable: false,
        capabilities: CAPABILITIES,
        error: {
          code: failure.code,
          message: failure.message,
          ...(failure.hint ? { hint: failure.hint } : {}),
        },
      };
    }
  }

  // --- devices ------------------------------------------------------------

  async upsertDevice(device: DeviceRecord): Promise<void> {
    await this.#request(`/devices/${encodeURIComponent(device.deviceId)}`, {
      method: 'PUT',
      body: JSON.stringify(device),
    });
  }

  listDevices(): Promise<DeviceRecord[]> {
    return this.#request<DeviceRecord[]>('/devices');
  }

  async getDevice(deviceId: DeviceId): Promise<DeviceRecord | null> {
    const devices = await this.listDevices();
    return devices.find((d) => d.deviceId === deviceId) ?? null;
  }

  mergeDevices(
    fromId: DeviceId,
    intoId: DeviceId,
  ): Promise<{ movedSamples: number; movedEvents: number }> {
    return this.#request(`/devices/${encodeURIComponent(fromId)}/merge`, {
      method: 'POST',
      body: JSON.stringify({ intoId }),
    });
  }

  async deleteDevice(deviceId: DeviceId): Promise<void> {
    await this.#request(`/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
  }

  // --- sessions -----------------------------------------------------------

  async startSession(session: SessionRecord): Promise<void> {
    await this.#request(
      `/devices/${encodeURIComponent(session.deviceId)}/sessions/${session.sessionId}`,
      { method: 'PUT', body: JSON.stringify(session) },
    );
  }

  async endSession(
    sessionId: SessionId,
    endedMs: Millis,
    reason: SessionEndReason,
    sampleCount: number,
  ): Promise<void> {
    await this.#request(`/sessions/${sessionId}/end`, {
      method: 'POST',
      body: JSON.stringify({ endedMs, reason, sampleCount }),
    });
  }

  listSessions(query: RangeQuery): Promise<SessionRecord[]> {
    const params = new URLSearchParams({ from: String(query.from), to: String(query.to) });
    return this.#request(
      `/devices/${encodeURIComponent(query.deviceId)}/sessions?${params.toString()}`,
    );
  }

  // --- writes -------------------------------------------------------------

  async appendSamples(rows: readonly Sample[]): Promise<AppendResult> {
    if (rows.length === 0) return { accepted: 0, deduped: 0, rejected: 0 };
    const byDevice = new Map<DeviceId, Sample[]>();
    for (const row of rows) {
      const list = byDevice.get(row.deviceId);
      if (list) list.push(row);
      else byDevice.set(row.deviceId, [row]);
    }

    const total: AppendResult = { accepted: 0, deduped: 0, rejected: 0 };
    for (const [deviceId, deviceRows] of byDevice) {
      for (let i = 0; i < deviceRows.length; i += CAPABILITIES.maxBatchRows) {
        const slice = deviceRows.slice(i, i + CAPABILITIES.maxBatchRows);
        const result = await this.#request<AppendResult>(
          `/devices/${encodeURIComponent(deviceId)}/samples`,
          {
            method: 'POST',
            body: JSON.stringify({ v: 1, deviceId, rows: slice.map(toSampleTuple) }),
          },
        );
        total.accepted += result.accepted;
        total.deduped += result.deduped;
        total.rejected += result.rejected;
      }
    }
    return total;
  }

  async appendEvents(rows: readonly DeviceEvent[]): Promise<AppendResult> {
    if (rows.length === 0) return { accepted: 0, deduped: 0, rejected: 0 };
    const deviceId = rows[0]!.deviceId;
    return this.#request(`/devices/${encodeURIComponent(deviceId)}/events`, {
      method: 'POST',
      body: JSON.stringify({ rows }),
    });
  }

  // --- reads --------------------------------------------------------------

  bounds(deviceId: DeviceId): Promise<Bounds | null> {
    return this.#request(`/devices/${encodeURIComponent(deviceId)}/bounds`);
  }

  queryRange(query: SeriesQuery, signal?: AbortSignal): Promise<SeriesFrame> {
    // Aligned client-side so every backend is asked for the same whole buckets.
    const window = alignWindow(query.from, query.to, query.bucket);
    const params = new URLSearchParams({
      from: String(window.from),
      to: String(window.to),
      bucket: query.bucket,
      limit: String(query.limit ?? DEFAULT_QUERY_LIMIT),
    });
    if (query.fields) params.set('fields', query.fields.join(','));
    return this.#request(
      `/devices/${encodeURIComponent(query.deviceId)}/samples?${params.toString()}`,
      {},
      signal,
    );
  }

  queryEvents(query: EventQuery, signal?: AbortSignal): Promise<DeviceEvent[]> {
    const params = new URLSearchParams({ from: String(query.from), to: String(query.to) });
    if (query.types) params.set('types', query.types.join(','));
    if (query.limit) params.set('limit', String(query.limit));
    return this.#request(
      `/devices/${encodeURIComponent(query.deviceId)}/events?${params.toString()}`,
      {},
      signal,
    );
  }

  aggregate(query: AggregateQuery, signal?: AbortSignal): Promise<Aggregates> {
    const params = new URLSearchParams({
      from: String(query.from),
      to: String(query.to),
      groupBy: query.groupBy ?? 'none',
    });
    return this.#request(
      `/devices/${encodeURIComponent(query.deviceId)}/stats?${params.toString()}`,
      {},
      signal,
    );
  }

  // --- export / import ----------------------------------------------------

  async *exportStream(query: ExportQuery, signal?: AbortSignal): AsyncIterable<ExportChunk> {
    const params = new URLSearchParams();
    if (query.deviceIds) params.set('deviceIds', query.deviceIds.join(','));
    if (query.from !== undefined) params.set('from', String(query.from));
    if (query.to !== undefined) params.set('to', String(query.to));
    if (query.include) params.set('include', query.include.join(','));

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/api/v1/export?${params.toString()}`, {
        headers: this.#headers(false),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw classifyFetchFailure(this.#baseUrl, error);
    }
    if (!response.body) throw new HttpStoreError('unknown', 'The export response had no body.');

    for await (const line of ndjsonLines(response.body)) {
      yield JSON.parse(line) as ExportChunk;
    }
  }

  async *importStream(
    source: AsyncIterable<ExportChunk>,
    options: ImportOptions = {},
  ): AsyncIterable<ImportProgress> {
    // Chunks are posted individually rather than as one long request body: request
    // streaming is not universally available, and per-chunk responses give real progress.
    for await (const chunk of source) {
      if (chunk.kind === 'header') continue;
      const progress = await this.#request<ImportProgress>('/import', {
        method: 'POST',
        body: JSON.stringify({ chunk, options }),
      });
      yield progress;
    }
  }

  deleteRange(query: DeleteQuery): Promise<{ samples: number; events: number; sessions: number }> {
    const params = new URLSearchParams({ from: String(query.from), to: String(query.to) });
    if (query.include) params.set('include', query.include.join(','));
    return this.#request(
      `/devices/${encodeURIComponent(query.deviceId)}/samples?${params.toString()}`,
      { method: 'DELETE' },
    );
  }

  async compact(): Promise<void> {
    await this.#request('/maintenance/vacuum', { method: 'POST' });
  }
}

/** Splits a byte stream into newline-delimited JSON records. */
export async function* ndjsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) yield line;
      index = buffer.indexOf('\n');
    }
  }
  const rest = buffer.trim();
  if (rest) yield rest;
}
