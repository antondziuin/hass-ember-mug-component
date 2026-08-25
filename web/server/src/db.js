/**
 * SQLite access for the local history server.
 *
 * Uses Node's built-in `node:sqlite`, so there is no native module to compile and no
 * build tools to install - which matters most on Windows. On Node 22 the module is behind
 * `--experimental-sqlite`; the npm scripts pass that flag.
 *
 * Bucketing and the time-weighted aggregates here must produce exactly the same numbers
 * as `src/history/bucketing.ts`. In particular, every interval is clamped to MAX_GAP_MS
 * and attributed to the state observed at its start.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export const SCHEMA_VERSION = 1;
/** Must match MAX_GAP_MS in src/history/constants.ts. */
export const MAX_GAP_MS = 120_000;
export const LIQUID_STATE_COUNT = 8;
export const LIQUID_PRESENT_DPC = 100;
export const TARGET_HISTOGRAM_BIN_CENTI_C = 50;

let DatabaseSync;

export async function loadSqlite() {
  if (DatabaseSync) return DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch (error) {
    throw new Error(
      'node:sqlite is unavailable. Run with Node 22.5+ and the --experimental-sqlite flag, ' +
        'or upgrade to Node 24 where it is enabled by default.\n' +
        String(error),
    );
  }
  return DatabaseSync;
}

export async function openDatabase(path) {
  const Database = await loadSqlite();
  const db = new Database(path);
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  return new HistoryDb(db);
}

const nul = (v) => (v === undefined ? null : v);

export class HistoryDb {
  #db;
  #statements = new Map();

  constructor(db) {
    this.#db = db;
  }

  #prepare(sql) {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  close() {
    this.#db.close();
  }

  transaction(fn) {
    this.#db.exec('BEGIN');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  vacuum() {
    this.#db.exec('VACUUM');
  }

  // --- devices ------------------------------------------------------------

  upsertDevice(device) {
    this.#prepare(
      `INSERT INTO devices (device_id, serial_number, name, model, device_type, capacity_ml,
                            colour, fw_version, fw_hardware, fw_bootloader, liquid_level_max,
                            first_seen_ms, last_seen_ms, ble_hint, meta_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(device_id) DO UPDATE SET
         serial_number = excluded.serial_number,
         name          = excluded.name,
         model         = excluded.model,
         device_type   = excluded.device_type,
         capacity_ml   = excluded.capacity_ml,
         colour        = excluded.colour,
         fw_version    = excluded.fw_version,
         fw_hardware   = excluded.fw_hardware,
         fw_bootloader = excluded.fw_bootloader,
         liquid_level_max = excluded.liquid_level_max,
         -- first_seen_ms is the earliest of the two, never overwritten by a later value.
         first_seen_ms = MIN(devices.first_seen_ms, excluded.first_seen_ms),
         last_seen_ms  = MAX(devices.last_seen_ms, excluded.last_seen_ms),
         ble_hint      = excluded.ble_hint,
         meta_json     = excluded.meta_json`,
    ).run(
      device.deviceId,
      nul(device.serialNumber),
      nul(device.name),
      nul(device.model),
      device.deviceType ?? 'unknown',
      nul(device.capacityMl),
      nul(device.colour),
      nul(device.fwVersion),
      nul(device.fwHardware),
      nul(device.fwBootloader),
      device.liquidLevelMax ?? 30,
      device.firstSeenMs,
      device.lastSeenMs,
      nul(device.bleHint),
      device.meta ? JSON.stringify(device.meta) : null,
    );
  }

  listDevices() {
    return this.#prepare('SELECT * FROM devices ORDER BY last_seen_ms DESC')
      .all()
      .map(deviceFromRow);
  }

  deleteDevice(deviceId) {
    this.transaction(() => {
      this.#prepare('DELETE FROM samples WHERE device_id = ?').run(deviceId);
      this.#prepare('DELETE FROM events WHERE device_id = ?').run(deviceId);
      this.#prepare('DELETE FROM sessions WHERE device_id = ?').run(deviceId);
      this.#prepare('DELETE FROM devices WHERE device_id = ?').run(deviceId);
    });
  }

  /** Folds one device into another, dropping rows that would collide on the natural key. */
  mergeDevices(fromId, intoId) {
    return this.transaction(() => {
      this.#prepare(
        `DELETE FROM samples WHERE device_id = ? AND ts IN (SELECT ts FROM samples WHERE device_id = ?)`,
      ).run(fromId, intoId);
      const samples = this.#prepare('UPDATE samples SET device_id = ? WHERE device_id = ?').run(
        intoId,
        fromId,
      );
      this.#prepare(
        `DELETE FROM events WHERE device_id = ? AND EXISTS (
           SELECT 1 FROM events t WHERE t.device_id = ? AND t.ts = events.ts AND t.type = events.type)`,
      ).run(fromId, intoId);
      const events = this.#prepare('UPDATE events SET device_id = ? WHERE device_id = ?').run(
        intoId,
        fromId,
      );
      this.#prepare('UPDATE sessions SET device_id = ? WHERE device_id = ?').run(intoId, fromId);
      this.#prepare('DELETE FROM devices WHERE device_id = ?').run(fromId);
      return {
        movedSamples: Number(samples.changes ?? 0),
        movedEvents: Number(events.changes ?? 0),
      };
    });
  }

  // --- sessions -----------------------------------------------------------

  upsertSession(session) {
    this.#prepare(
      `INSERT INTO sessions (session_id, device_id, started_ms, ended_ms, end_reason, sample_count, app_version)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET
         ended_ms     = COALESCE(excluded.ended_ms, sessions.ended_ms),
         end_reason   = COALESCE(excluded.end_reason, sessions.end_reason),
         sample_count = MAX(sessions.sample_count, excluded.sample_count)`,
    ).run(
      session.sessionId,
      session.deviceId,
      session.startedMs,
      nul(session.endedMs),
      nul(session.endReason),
      session.sampleCount ?? 0,
      nul(session.appVersion),
    );
  }

  endSession(sessionId, endedMs, reason, sampleCount) {
    this.#prepare(
      'UPDATE sessions SET ended_ms = ?, end_reason = ?, sample_count = ? WHERE session_id = ?',
    ).run(endedMs, reason, sampleCount, sessionId);
  }

  listSessions(deviceId, from, to) {
    return this.#prepare(
      `SELECT * FROM sessions
        WHERE device_id = ? AND started_ms < ? AND COALESCE(ended_ms, 9223372036854775807) > ?
        ORDER BY started_ms`,
    )
      .all(deviceId, to, from)
      .map((r) => ({
        sessionId: r.session_id,
        deviceId: r.device_id,
        startedMs: Number(r.started_ms),
        endedMs: r.ended_ms === null ? null : Number(r.ended_ms),
        endReason: r.end_reason,
        sampleCount: Number(r.sample_count),
        appVersion: r.app_version,
      }));
  }

  // --- samples ------------------------------------------------------------

  /** Tuples: [ts, tempC, targetC, batteryDpc, liquidDpc, liquidState, batteryMv, flags, sessionId] */
  insertSamples(deviceId, tuples) {
    const insert = this.#prepare(
      `INSERT INTO samples (device_id, ts, temp_c, target_c, battery_dpc, liquid_dpc,
                            liquid_state, battery_mv, flags, session_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(device_id, ts) DO NOTHING`,
    );
    return this.transaction(() => {
      let accepted = 0;
      for (const t of tuples) {
        const info = insert.run(
          deviceId,
          t[0],
          nul(t[1]),
          nul(t[2]),
          nul(t[3]),
          nul(t[4]),
          nul(t[5]),
          nul(t[6]),
          t[7] ?? 0,
          nul(t[8]),
        );
        accepted += Number(info.changes ?? 0);
      }
      return { accepted, deduped: tuples.length - accepted, rejected: 0 };
    });
  }

  insertEvents(rows) {
    const insert = this.#prepare(
      `INSERT INTO events (event_id, device_id, ts, type, session_id, num_a, num_b, text_a, data_json)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(device_id, ts, type) DO NOTHING`,
    );
    return this.transaction(() => {
      let accepted = 0;
      for (const e of rows) {
        const info = insert.run(
          e.eventId,
          e.deviceId,
          e.ts,
          e.type,
          nul(e.sessionId),
          nul(e.numA),
          nul(e.numB),
          nul(e.textA),
          e.data ? JSON.stringify(e.data) : null,
        );
        accepted += Number(info.changes ?? 0);
      }
      return { accepted, deduped: rows.length - accepted, rejected: 0 };
    });
  }

  bounds(deviceId) {
    const row = this.#prepare(
      'SELECT MIN(ts) AS min_ts, MAX(ts) AS max_ts, COUNT(*) AS n FROM samples WHERE device_id = ?',
    ).get(deviceId);
    if (!row || Number(row.n) === 0) return null;
    const events = this.#prepare('SELECT COUNT(*) AS n FROM events WHERE device_id = ?').get(
      deviceId,
    );
    return {
      minTs: Number(row.min_ts),
      maxTs: Number(row.max_ts),
      sampleCount: Number(row.n),
      eventCount: Number(events?.n ?? 0),
    };
  }

  rawSamples(deviceId, from, to, limit) {
    return this.#prepare(
      'SELECT * FROM samples WHERE device_id = ? AND ts >= ? AND ts < ? ORDER BY ts LIMIT ?',
    ).all(deviceId, from, to, limit);
  }

  /**
   * Bucketed series.
   *
   * The bare `liquid_state` and `target_c` columns alongside `MAX(ts)` are SQLite's
   * documented "row of the max" behaviour, which is exactly the last-in-bucket semantics
   * the client-side fold uses.
   */
  bucketed(deviceId, from, to, bucketMs, limit) {
    if (bucketMs <= 0) {
      const rows = this.rawSamples(deviceId, from, to, limit);
      return rows.map((r) => ({
        b: Number(r.ts),
        n: 1,
        temp_avg: r.temp_c,
        temp_min: null,
        temp_max: null,
        batt_avg: r.battery_dpc,
        batt_min: null,
        batt_max: null,
        liquid_avg: r.liquid_dpc,
        state_last: r.liquid_state,
        target_last: r.target_c,
        charge_frac: (r.flags & 1) === 1 ? 1 : 0,
      }));
    }

    return this.#prepare(
      // CAST is load-bearing: node:sqlite binds JS numbers as doubles, so a bare
      // `ts / :bucket` is float division and every bucket key comes back as the raw
      // timestamp instead of the bucket start.
      `SELECT CAST(ts / :bucket AS INTEGER) * :bucket AS b,
              COUNT(*)          AS n,
              AVG(temp_c)       AS temp_avg,
              MIN(temp_c)       AS temp_min,
              MAX(temp_c)       AS temp_max,
              AVG(battery_dpc)  AS batt_avg,
              MIN(battery_dpc)  AS batt_min,
              MAX(battery_dpc)  AS batt_max,
              AVG(liquid_dpc)   AS liquid_avg,
              MAX(ts)           AS ts_last,
              liquid_state      AS state_last,
              target_c          AS target_last,
              SUM(flags & 1) * 1.0 / COUNT(*) AS charge_frac
         FROM samples
        WHERE device_id = :dev AND ts >= :from AND ts < :to
        GROUP BY b
        ORDER BY b
        LIMIT :limit`,
    ).all({ dev: deviceId, from, to, bucket: bucketMs, limit });
  }

  /**
   * Time-weighted aggregates.
   *
   * Computed row by row rather than in SQL so the clamp and the left-attribution rule are
   * written once, in a form that is obviously the same as the client's.
   */
  aggregate(deviceId, from, to) {
    const rows = this.#prepare(
      'SELECT * FROM samples WHERE device_id = ? AND ts >= ? AND ts < ? ORDER BY ts',
    ).all(deviceId, from, to);

    const msPerState = new Array(LIQUID_STATE_COUNT).fill(0);
    const targetMs = new Map();
    let msOnCharger = 0;
    let msTempControlOn = 0;
    let msLiquidPresent = 0;
    let tempMin = null;
    let tempMax = null;
    let tempSum = 0;
    let tempCount = 0;
    let battMin = null;
    let battMax = null;
    let discharged = 0;
    let charged = 0;
    let previousBattery = null;

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (row.temp_c !== null) {
        tempSum += row.temp_c;
        tempCount += 1;
        if (tempMin === null || row.temp_c < tempMin) tempMin = row.temp_c;
        if (tempMax === null || row.temp_c > tempMax) tempMax = row.temp_c;
      }
      if (row.battery_dpc !== null) {
        if (battMin === null || row.battery_dpc < battMin) battMin = row.battery_dpc;
        if (battMax === null || row.battery_dpc > battMax) battMax = row.battery_dpc;
        if (previousBattery !== null) {
          const delta = row.battery_dpc - previousBattery;
          if (delta < 0) discharged += -delta;
          else charged += delta;
        }
        previousBattery = row.battery_dpc;
      }

      const next = rows[i + 1];
      if (!next) continue;
      const dt = Math.min(Number(next.ts) - Number(row.ts), MAX_GAP_MS);
      if (dt <= 0) continue;

      if (row.liquid_state !== null) msPerState[row.liquid_state] += dt;
      if ((row.flags & 1) === 1) msOnCharger += dt;
      if (row.target_c !== null) {
        msTempControlOn += dt;
        const bin =
          Math.round(row.target_c / TARGET_HISTOGRAM_BIN_CENTI_C) * TARGET_HISTOGRAM_BIN_CENTI_C;
        targetMs.set(bin, (targetMs.get(bin) ?? 0) + dt);
      }
      if (row.liquid_dpc !== null && row.liquid_dpc >= LIQUID_PRESENT_DPC) msLiquidPresent += dt;
    }

    const sessions = this.listSessions(deviceId, from, to);
    const observed = observedMs(sessions, from, to);
    const window = Math.max(to - from, 1);

    return {
      from,
      to,
      observedMs: observed,
      coverage: Math.min(observed / window, 1),
      sampleCount: rows.length,
      temp: {
        minC: tempMin === null ? null : tempMin / 100,
        maxC: tempMax === null ? null : tempMax / 100,
        meanC: tempCount > 0 ? tempSum / tempCount / 100 : null,
      },
      msPerState,
      msOnCharger,
      msTempControlOn,
      msLiquidPresent,
      battery: {
        minPct: battMin === null ? null : battMin / 10,
        maxPct: battMax === null ? null : battMax / 10,
        dischargedPct: discharged / 10,
        chargedPct: charged / 10,
      },
      targetHistogram: [...targetMs.entries()]
        .map(([centi, ms]) => ({ targetC: centi / 100, ms }))
        .sort((a, b) => a.targetC - b.targetC),
      sessionCount: sessions.length,
    };
  }

  queryEvents(deviceId, from, to, types, limit) {
    const rows = this.#prepare(
      'SELECT * FROM events WHERE device_id = ? AND ts >= ? AND ts < ? ORDER BY ts LIMIT ?',
    ).all(deviceId, from, to, limit ?? 100000);
    return rows
      .filter((r) => !types || types.includes(r.type))
      .map((r) => ({
        eventId: r.event_id,
        deviceId: r.device_id,
        ts: Number(r.ts),
        type: r.type,
        sessionId: r.session_id,
        numA: r.num_a,
        numB: r.num_b,
        textA: r.text_a,
        data: r.data_json ? JSON.parse(r.data_json) : null,
      }));
  }

  deleteRange(deviceId, from, to, include) {
    return this.transaction(() => {
      let samples = 0;
      let events = 0;
      let sessions = 0;
      if (include.includes('samples')) {
        samples = Number(
          this.#prepare('DELETE FROM samples WHERE device_id = ? AND ts >= ? AND ts < ?').run(
            deviceId,
            from,
            to,
          ).changes ?? 0,
        );
      }
      if (include.includes('events')) {
        events = Number(
          this.#prepare('DELETE FROM events WHERE device_id = ? AND ts >= ? AND ts < ?').run(
            deviceId,
            from,
            to,
          ).changes ?? 0,
        );
      }
      if (include.includes('sessions')) {
        sessions = Number(
          this.#prepare(
            'DELETE FROM sessions WHERE device_id = ? AND started_ms >= ? AND started_ms < ?',
          ).run(deviceId, from, to).changes ?? 0,
        );
      }
      return { samples, events, sessions };
    });
  }
}

/** Union of session spans clipped to the window, so overlap is never counted twice. */
function observedMs(sessions, from, to) {
  const intervals = sessions
    .map((s) => [Math.max(s.startedMs, from), Math.min(s.endedMs ?? to, to)])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);

  let total = 0;
  let cursor = -Infinity;
  for (const [start, end] of intervals) {
    const begin = Math.max(start, cursor);
    if (end > begin) {
      total += end - begin;
      cursor = end;
    }
  }
  return total;
}

function deviceFromRow(r) {
  return {
    deviceId: r.device_id,
    serialNumber: r.serial_number,
    name: r.name,
    model: r.model,
    deviceType: r.device_type,
    capacityMl: r.capacity_ml,
    colour: r.colour,
    fwVersion: r.fw_version,
    fwHardware: r.fw_hardware,
    fwBootloader: r.fw_bootloader,
    liquidLevelMax: r.liquid_level_max,
    firstSeenMs: Number(r.first_seen_ms),
    lastSeenMs: Number(r.last_seen_ms),
    bleHint: r.ble_hint,
    meta: r.meta_json ? JSON.parse(r.meta_json) : null,
  };
}
