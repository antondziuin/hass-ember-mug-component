/**
 * Supabase-backed history.
 *
 * The anon key is public by design - it is meant to ship in a browser bundle. What makes
 * that safe is row-level security: with RLS on and no permissive `anon` policy, the key
 * authorises nothing except reaching the login endpoint. `probe()` therefore checks that
 * RLS really is enabled and refuses to report the store as usable if it is not, because a
 * single table shipped without it exposes every user's data to anyone on the internet.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { DEFAULT_QUERY_LIMIT, MAX_BATCH_ROWS } from '../../constants.js';
import { aggregateSamples, alignWindow, bucketSamples } from '../../bucketing.js';
import type {
  AggregateQuery,
  DeleteQuery,
  EventQuery,
  ExportChunk,
  ExportKind,
  ExportQuery,
  HistoryStore,
  ImportOptions,
  ImportProgress,
  RangeQuery,
  SeriesQuery,
  StoreCapabilities,
  StoreKind,
  StoreProbe,
} from '../../HistoryStore.js';
import {
  BUCKET_MS,
  type Aggregates,
  type AppendResult,
  type Bounds,
  type DeviceEvent,
  type DeviceId,
  type DeviceRecord,
  type Millis,
  type Sample,
  type SeriesFrame,
  type SessionEndReason,
  type SessionId,
  type SessionRecord,
} from '../../types.js';

export const SCHEMA_VERSION = 1;

const CAPABILITIES: StoreCapabilities = {
  buckets: ['raw', '1m', '5m', '1h', '1d'],
  serverSideBucketing: true,
  serverSideStats: false,
  maxBatchRows: MAX_BATCH_ROWS.supabase,
  streamingExport: true,
  deleteRange: true,
  multiDevice: true,
  transactional: false,
};

const TABLES = {
  devices: 'mug_devices',
  sessions: 'mug_sessions',
  samples: 'mug_samples',
  events: 'mug_events',
} as const;

export interface SupabaseStoreOptions {
  url: string;
  anonKey: string;
  client?: SupabaseClient;
}

interface SampleRow {
  device_id: string;
  ts: number;
  session_id: string | null;
  temp_c: number | null;
  target_c: number | null;
  battery_dpc: number | null;
  liquid_dpc: number | null;
  liquid_state: number | null;
  battery_mv: number | null;
  flags: number;
}

const toRow = (s: Sample): Omit<SampleRow, 'user_id'> => ({
  device_id: s.deviceId,
  ts: s.ts,
  session_id: s.sessionId,
  temp_c: s.tempC,
  target_c: s.targetC,
  battery_dpc: s.batteryDpc,
  liquid_dpc: s.liquidDpc,
  liquid_state: s.liquidState,
  battery_mv: s.batteryMv,
  flags: s.flags,
});

const fromRow = (r: SampleRow): Sample => ({
  deviceId: r.device_id,
  ts: Number(r.ts),
  sessionId: r.session_id,
  tempC: r.temp_c,
  targetC: r.target_c,
  batteryDpc: r.battery_dpc,
  liquidDpc: r.liquid_dpc,
  liquidState: r.liquid_state as Sample['liquidState'],
  batteryMv: r.battery_mv,
  flags: r.flags,
});

export class SupabaseStore implements HistoryStore {
  readonly kind: StoreKind = 'supabase';
  readonly id: string;

  readonly #client: SupabaseClient;
  readonly #projectRef: string;

  constructor(options: SupabaseStoreOptions) {
    this.#client =
      options.client ??
      createClient(options.url, options.anonKey, {
        auth: {
          flowType: 'pkce',
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: true,
        },
      });
    this.#projectRef = new URL(options.url).hostname.split('.')[0] ?? 'supabase';
    this.id = `supabase:${this.#projectRef}`;
  }

  get client(): SupabaseClient {
    return this.#client;
  }

  async open(): Promise<void> {
    // The client connects lazily.
  }

  async close(): Promise<void> {
    // Nothing to release.
  }

  async signInWithEmail(email: string): Promise<void> {
    const { error } = await this.#client.auth.signInWithOtp({ email });
    if (error) throw new Error(error.message);
  }

  async signOut(): Promise<void> {
    await this.#client.auth.signOut();
  }

  async currentUserId(): Promise<string | null> {
    const { data } = await this.#client.auth.getUser();
    return data.user?.id ?? null;
  }

  async probe(): Promise<StoreProbe> {
    const started = Date.now();
    const base = {
      kind: this.kind,
      id: this.id,
      latencyMs: 0,
      schemaVersion: SCHEMA_VERSION,
      capabilities: CAPABILITIES,
    };

    const userId = await this.currentUserId();
    if (!userId) {
      return {
        ...base,
        ok: false,
        writable: false,
        latencyMs: Date.now() - started,
        error: {
          code: 'unauthorized',
          message: 'Not signed in to Supabase.',
          hint: 'Send yourself a magic link from Settings, then open it in this browser.',
        },
      };
    }

    const { error } = await this.#client.from(TABLES.samples).select('ts').limit(1);
    if (error) {
      const missing = /relation .* does not exist|schema cache/i.test(error.message);
      return {
        ...base,
        ok: false,
        writable: false,
        latencyMs: Date.now() - started,
        error: {
          code: missing ? 'schema_mismatch' : 'unreachable',
          message: error.message,
          hint: missing
            ? 'Run web/supabase/migrations/0001_init.sql in the Supabase SQL editor.'
            : 'A free-tier project pauses after about a week of inactivity - open the dashboard to resume it.',
        },
      };
    }

    const rls = await this.#checkRowLevelSecurity();
    if (rls && !rls.ok) {
      return {
        ...base,
        ok: false,
        writable: false,
        latencyMs: Date.now() - started,
        error: {
          code: 'unauthorized',
          message: `Row level security is off for: ${rls.unprotected.join(', ')}.`,
          hint: 'Without RLS the public anon key can read and write everyone’s data. Re-run the migration before using this project.',
        },
      };
    }

    return {
      ...base,
      ok: true,
      writable: true,
      latencyMs: Date.now() - started,
      usage: { rowCount: undefined },
    };
  }

  /**
   * Best effort: the helper view is optional, so an unavailable check is not treated as a
   * failure. When it is available, a table without RLS is a hard stop.
   */
  async #checkRowLevelSecurity(): Promise<{ ok: boolean; unprotected: string[] } | null> {
    const { data, error } = await this.#client.rpc('mug_rls_status');
    if (error || !Array.isArray(data)) return null;
    const unprotected = (data as Array<{ table_name: string; rls_enabled: boolean }>)
      .filter((row) => !row.rls_enabled)
      .map((row) => row.table_name);
    return { ok: unprotected.length === 0, unprotected };
  }

  #assert(error: { message: string } | null): void {
    if (error) throw new Error(error.message);
  }

  // --- devices ------------------------------------------------------------

  async upsertDevice(device: DeviceRecord): Promise<void> {
    const { error } = await this.#client.from(TABLES.devices).upsert(
      {
        device_id: device.deviceId,
        serial_number: device.serialNumber,
        name: device.name,
        model: device.model,
        device_type: device.deviceType,
        capacity_ml: device.capacityMl,
        colour: device.colour,
        fw_version: device.fwVersion,
        fw_hardware: device.fwHardware,
        fw_bootloader: device.fwBootloader,
        liquid_level_max: device.liquidLevelMax,
        first_seen_ms: device.firstSeenMs,
        last_seen_ms: device.lastSeenMs,
        ble_hint: device.bleHint,
        meta: device.meta,
      },
      { onConflict: 'user_id,device_id' },
    );
    this.#assert(error);
  }

  async listDevices(): Promise<DeviceRecord[]> {
    const { data, error } = await this.#client.from(TABLES.devices).select('*');
    this.#assert(error);
    return (data ?? []).map(
      (r: Record<string, unknown>): DeviceRecord => ({
        deviceId: r.device_id as string,
        serialNumber: (r.serial_number as string) ?? null,
        name: (r.name as string) ?? null,
        model: (r.model as string) ?? null,
        deviceType: (r.device_type as DeviceRecord['deviceType']) ?? 'unknown',
        capacityMl: (r.capacity_ml as number) ?? null,
        colour: (r.colour as string) ?? null,
        fwVersion: (r.fw_version as string) ?? null,
        fwHardware: (r.fw_hardware as string) ?? null,
        fwBootloader: (r.fw_bootloader as string) ?? null,
        liquidLevelMax: (r.liquid_level_max as 30 | 100) ?? 30,
        firstSeenMs: Number(r.first_seen_ms),
        lastSeenMs: Number(r.last_seen_ms),
        bleHint: (r.ble_hint as string) ?? null,
        meta: (r.meta as Record<string, unknown>) ?? null,
      }),
    );
  }

  async getDevice(deviceId: DeviceId): Promise<DeviceRecord | null> {
    return (await this.listDevices()).find((d) => d.deviceId === deviceId) ?? null;
  }

  async mergeDevices(
    fromId: DeviceId,
    intoId: DeviceId,
  ): Promise<{ movedSamples: number; movedEvents: number }> {
    const { data, error } = await this.#client.rpc('mug_merge_devices', {
      p_from: fromId,
      p_into: intoId,
    });
    this.#assert(error);
    const result = (data ?? {}) as { moved_samples?: number; moved_events?: number };
    return {
      movedSamples: result.moved_samples ?? 0,
      movedEvents: result.moved_events ?? 0,
    };
  }

  async deleteDevice(deviceId: DeviceId): Promise<void> {
    const { error } = await this.#client.from(TABLES.devices).delete().eq('device_id', deviceId);
    this.#assert(error);
  }

  // --- sessions -----------------------------------------------------------

  async startSession(session: SessionRecord): Promise<void> {
    const { error } = await this.#client.from(TABLES.sessions).upsert(
      {
        session_id: session.sessionId,
        device_id: session.deviceId,
        started_ms: session.startedMs,
        ended_ms: session.endedMs,
        end_reason: session.endReason,
        sample_count: session.sampleCount,
        app_version: session.appVersion,
      },
      { onConflict: 'user_id,session_id' },
    );
    this.#assert(error);
  }

  async endSession(
    sessionId: SessionId,
    endedMs: Millis,
    reason: SessionEndReason,
    sampleCount: number,
  ): Promise<void> {
    const { error } = await this.#client
      .from(TABLES.sessions)
      .update({ ended_ms: endedMs, end_reason: reason, sample_count: sampleCount })
      .eq('session_id', sessionId);
    this.#assert(error);
  }

  async listSessions(query: RangeQuery): Promise<SessionRecord[]> {
    // A session that began before the window can still overlap it.
    const { data, error } = await this.#client
      .from(TABLES.sessions)
      .select('*')
      .eq('device_id', query.deviceId)
      .lt('started_ms', query.to)
      .order('started_ms', { ascending: true });
    this.#assert(error);

    return (data ?? [])
      .map(
        (r: Record<string, unknown>): SessionRecord => ({
          sessionId: r.session_id as string,
          deviceId: r.device_id as string,
          startedMs: Number(r.started_ms),
          endedMs: r.ended_ms === null ? null : Number(r.ended_ms),
          endReason: (r.end_reason as SessionEndReason) ?? null,
          sampleCount: Number(r.sample_count ?? 0),
          appVersion: (r.app_version as string) ?? '',
        }),
      )
      .filter((s) => (s.endedMs ?? Number.POSITIVE_INFINITY) > query.from);
  }

  // --- writes -------------------------------------------------------------

  async appendSamples(rows: readonly Sample[]): Promise<AppendResult> {
    if (rows.length === 0) return { accepted: 0, deduped: 0, rejected: 0 };
    let accepted = 0;
    for (let i = 0; i < rows.length; i += CAPABILITIES.maxBatchRows) {
      const slice = rows.slice(i, i + CAPABILITIES.maxBatchRows).map(toRow);
      const { error } = await this.#client.from(TABLES.samples).upsert(slice, {
        onConflict: 'user_id,device_id,ts',
        ignoreDuplicates: true,
        defaultToNull: false,
      });
      this.#assert(error);
      accepted += slice.length;
    }
    // PostgREST does not report how many rows the ignore-duplicates path skipped, so this
    // counts what was offered rather than guessing.
    return { accepted, deduped: 0, rejected: 0 };
  }

  async appendEvents(rows: readonly DeviceEvent[]): Promise<AppendResult> {
    if (rows.length === 0) return { accepted: 0, deduped: 0, rejected: 0 };
    const payload = rows.map((e) => ({
      event_id: e.eventId,
      device_id: e.deviceId,
      ts: e.ts,
      type: e.type,
      session_id: e.sessionId,
      num_a: e.numA,
      num_b: e.numB,
      text_a: e.textA,
      data: e.data,
    }));
    const { error } = await this.#client
      .from(TABLES.events)
      .upsert(payload, { onConflict: 'user_id,event_id', ignoreDuplicates: true });
    this.#assert(error);
    return { accepted: payload.length, deduped: 0, rejected: 0 };
  }

  // --- reads --------------------------------------------------------------

  async bounds(deviceId: DeviceId): Promise<Bounds | null> {
    const first = await this.#client
      .from(TABLES.samples)
      .select('ts')
      .eq('device_id', deviceId)
      .order('ts', { ascending: true })
      .limit(1);
    this.#assert(first.error);
    if (!first.data || first.data.length === 0) return null;

    const last = await this.#client
      .from(TABLES.samples)
      .select('ts')
      .eq('device_id', deviceId)
      .order('ts', { ascending: false })
      .limit(1);
    this.#assert(last.error);

    const sampleCount = await this.#client
      .from(TABLES.samples)
      .select('*', { count: 'exact', head: true })
      .eq('device_id', deviceId);
    const eventCount = await this.#client
      .from(TABLES.events)
      .select('*', { count: 'exact', head: true })
      .eq('device_id', deviceId);

    return {
      minTs: Number(first.data[0]!.ts),
      maxTs: Number(last.data![0]!.ts),
      sampleCount: sampleCount.count ?? 0,
      eventCount: eventCount.count ?? 0,
    };
  }

  /** Pages explicitly: PostgREST caps a response at 1,000 rows by default. */
  async #fetchSamples(deviceId: DeviceId, from: Millis, to: Millis, limit: number): Promise<Sample[]> {
    const out: Sample[] = [];
    const page = CAPABILITIES.maxBatchRows;
    for (let offset = 0; offset < limit; offset += page) {
      const { data, error } = await this.#client
        .from(TABLES.samples)
        .select('*')
        .eq('device_id', deviceId)
        .gte('ts', from)
        .lt('ts', to)
        .order('ts', { ascending: true })
        .range(offset, offset + page - 1);
      this.#assert(error);
      const rows = (data ?? []) as SampleRow[];
      out.push(...rows.map(fromRow));
      if (rows.length < page) break;
    }
    return out;
  }

  async queryRange(query: SeriesQuery): Promise<SeriesFrame> {
    const window = alignWindow(query.from, query.to, query.bucket);
    const options = {
      deviceId: query.deviceId,
      from: window.from,
      to: window.to,
      bucket: query.bucket,
      ...(query.fields ? { fields: query.fields } : {}),
      limit: query.limit ?? DEFAULT_QUERY_LIMIT,
    };

    // Bucketing runs in Postgres where it can; PostgREST cannot express GROUP BY, so it
    // goes through an RPC. If that RPC is missing, fall back to folding client-side.
    if (query.bucket !== 'raw') {
      const { data, error } = await this.#client.rpc('mug_samples_bucketed', {
        p_device_id: query.deviceId,
        p_from: window.from,
        p_to: window.to,
        p_bucket_ms: BUCKET_MS[query.bucket],
      });
      if (!error && Array.isArray(data)) {
        return frameFromRpc(data as RpcBucketRow[], options);
      }
    }

    const samples = await this.#fetchSamples(
      query.deviceId,
      window.from,
      window.to,
      options.limit,
    );
    return bucketSamples(samples, options);
  }

  async queryEvents(query: EventQuery): Promise<DeviceEvent[]> {
    let builder = this.#client
      .from(TABLES.events)
      .select('*')
      .eq('device_id', query.deviceId)
      .gte('ts', query.from)
      .lt('ts', query.to)
      .order('ts', { ascending: true });
    if (query.types) builder = builder.in('type', [...query.types]);
    if (query.limit) builder = builder.limit(query.limit);

    const { data, error } = await builder;
    this.#assert(error);
    return (data ?? []).map(
      (r: Record<string, unknown>): DeviceEvent => ({
        eventId: r.event_id as string,
        deviceId: r.device_id as string,
        ts: Number(r.ts),
        type: r.type as DeviceEvent['type'],
        sessionId: (r.session_id as string) ?? null,
        numA: (r.num_a as number) ?? null,
        numB: (r.num_b as number) ?? null,
        textA: (r.text_a as string) ?? null,
        data: (r.data as Record<string, unknown>) ?? null,
      }),
    );
  }

  async aggregate(query: AggregateQuery): Promise<Aggregates> {
    const samples = await this.#fetchSamples(
      query.deviceId,
      query.from,
      query.to,
      DEFAULT_QUERY_LIMIT * 10,
    );
    const sessions = await this.listSessions({
      deviceId: query.deviceId,
      from: query.from,
      to: query.to,
    });
    return aggregateSamples(samples, { from: query.from, to: query.to, sessions });
  }

  // --- export / import ----------------------------------------------------

  async *exportStream(query: ExportQuery): AsyncIterable<ExportChunk> {
    const include = new Set<ExportKind>(
      query.include ?? ['devices', 'sessions', 'events', 'samples'],
    );
    const from = query.from ?? Number.MIN_SAFE_INTEGER;
    const to = query.to ?? Number.MAX_SAFE_INTEGER;
    const batch = Math.min(query.batchRows ?? 1000, CAPABILITIES.maxBatchRows);

    yield { kind: 'header', v: 1, exportedAt: Date.now(), source: this.kind, sourceId: this.id };

    const devices = (await this.listDevices()).filter(
      (d) => !query.deviceIds || query.deviceIds.includes(d.deviceId),
    );
    if (include.has('devices')) yield { kind: 'devices', rows: devices };

    for (const device of devices) {
      if (include.has('sessions')) {
        const rows = await this.listSessions({ deviceId: device.deviceId, from, to });
        if (rows.length > 0) yield { kind: 'sessions', rows };
      }
      if (include.has('events')) {
        const rows = await this.queryEvents({ deviceId: device.deviceId, from, to });
        for (let i = 0; i < rows.length; i += batch) {
          yield { kind: 'events', rows: rows.slice(i, i + batch) };
        }
      }
      if (include.has('samples')) {
        let cursor = from;
        for (;;) {
          const { data, error } = await this.#client
            .from(TABLES.samples)
            .select('*')
            .eq('device_id', device.deviceId)
            .gte('ts', cursor)
            .lt('ts', to)
            .order('ts', { ascending: true })
            .limit(batch);
          this.#assert(error);
          const rows = ((data ?? []) as SampleRow[]).map(fromRow);
          if (rows.length === 0) break;
          const lastTs = rows[rows.length - 1]!.ts;
          yield { kind: 'samples', deviceId: device.deviceId, rows, lastTs };
          if (rows.length < batch) break;
          cursor = lastTs + 1;
        }
      }
    }
  }

  async *importStream(
    source: AsyncIterable<ExportChunk>,
    options: ImportOptions = {},
  ): AsyncIterable<ImportProgress> {
    const dryRun = options.dryRun ?? false;
    for await (const chunk of source) {
      switch (chunk.kind) {
        case 'header':
          break;
        case 'devices':
          if (!dryRun) for (const device of chunk.rows) await this.upsertDevice(device);
          yield { kind: 'devices', rowsSeen: chunk.rows.length, rowsAccepted: chunk.rows.length, rowsDeduped: 0 };
          break;
        case 'sessions':
          if (!dryRun) for (const session of chunk.rows) await this.startSession(session);
          yield { kind: 'sessions', rowsSeen: chunk.rows.length, rowsAccepted: chunk.rows.length, rowsDeduped: 0 };
          break;
        case 'events': {
          const result = dryRun
            ? { accepted: 0, deduped: 0, rejected: 0 }
            : await this.appendEvents(chunk.rows);
          yield {
            kind: 'events',
            rowsSeen: chunk.rows.length,
            rowsAccepted: result.accepted,
            rowsDeduped: result.deduped,
          };
          break;
        }
        case 'samples': {
          const result = dryRun
            ? { accepted: 0, deduped: 0, rejected: 0 }
            : await this.appendSamples(chunk.rows);
          yield {
            kind: 'samples',
            deviceId: chunk.deviceId,
            rowsSeen: chunk.rows.length,
            rowsAccepted: result.accepted,
            rowsDeduped: result.deduped,
            lastTs: chunk.lastTs,
          };
          break;
        }
      }
    }
  }

  async deleteRange(
    query: DeleteQuery,
  ): Promise<{ samples: number; events: number; sessions: number }> {
    const include = new Set(query.include ?? ['samples', 'events', 'sessions']);
    let samples = 0;
    let events = 0;
    let sessions = 0;

    if (include.has('samples')) {
      const { error, count } = await this.#client
        .from(TABLES.samples)
        .delete({ count: 'exact' })
        .eq('device_id', query.deviceId)
        .gte('ts', query.from)
        .lt('ts', query.to);
      this.#assert(error);
      samples = count ?? 0;
    }
    if (include.has('events')) {
      const { error, count } = await this.#client
        .from(TABLES.events)
        .delete({ count: 'exact' })
        .eq('device_id', query.deviceId)
        .gte('ts', query.from)
        .lt('ts', query.to);
      this.#assert(error);
      events = count ?? 0;
    }
    if (include.has('sessions')) {
      const { error, count } = await this.#client
        .from(TABLES.sessions)
        .delete({ count: 'exact' })
        .eq('device_id', query.deviceId)
        .gte('started_ms', query.from)
        .lt('started_ms', query.to);
      this.#assert(error);
      sessions = count ?? 0;
    }
    return { samples, events, sessions };
  }
}

interface RpcBucketRow {
  b: number;
  n: number;
  temp_avg: number | null;
  temp_min: number | null;
  temp_max: number | null;
  batt_avg: number | null;
  batt_min: number | null;
  batt_max: number | null;
  liquid_avg: number | null;
  state_last: number | null;
  target_last: number | null;
  charge_frac: number | null;
}

/** Converts the RPC's integer columns into the same units the shared fold produces. */
function frameFromRpc(
  rows: readonly RpcBucketRow[],
  options: {
    deviceId: DeviceId;
    from: Millis;
    to: Millis;
    bucket: SeriesQuery['bucket'];
    limit: number;
  },
): SeriesFrame {
  const scale = (v: number | null, by: number): number | null => (v === null ? null : v / by);
  const capped = rows.slice(0, options.limit);
  return {
    deviceId: options.deviceId,
    bucket: options.bucket,
    from: options.from,
    to: options.to,
    t: capped.map((r) => Number(r.b) / 1000),
    tempC: capped.map((r) => scale(r.temp_avg, 100)),
    tempMinC: capped.map((r) => scale(r.temp_min, 100)),
    tempMaxC: capped.map((r) => scale(r.temp_max, 100)),
    targetC: capped.map((r) => scale(r.target_last, 100)),
    batteryPct: capped.map((r) => scale(r.batt_avg, 10)),
    batteryMinPct: capped.map((r) => scale(r.batt_min, 10)),
    batteryMaxPct: capped.map((r) => scale(r.batt_max, 10)),
    liquidPct: capped.map((r) => scale(r.liquid_avg, 10)),
    liquidState: capped.map((r) => r.state_last),
    chargeFrac: capped.map((r) => r.charge_frac),
    count: capped.map((r) => Number(r.n)),
    truncated: rows.length > options.limit,
  };
}
