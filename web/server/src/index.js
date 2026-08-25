/**
 * Local history server.
 *
 * It also serves the built single-page app. That is deliberate: a page loaded over https
 * from somewhere else cannot reliably reach http://localhost, because Chrome's private
 * network access rules are being reworked into a user prompt. Serving both from the same
 * origin removes CORS, mixed content and that prompt in one go - and `localhost` counts
 * as a secure context, so Web Bluetooth still works.
 *
 * No dependencies: node:http, node:sqlite and the standard library only.
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import { SCHEMA_VERSION, openDatabase } from './db.js';

const DEFAULT_PORT = 41821;
const DEFAULT_HOST = '127.0.0.1';
const BUCKET_MS = { '1m': 60_000, '5m': 300_000, '1h': 3_600_000, '1d': 86_400_000 };
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function parseArgs(argv) {
  const args = { staticDir: null, open: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--serve-static') args.staticDir = argv[i + 1] ?? null;
    if (argv[i] === '--open') args.open = true;
  }
  return args;
}

function loadOrCreateToken(dataDir) {
  const fromEnv = process.env.AUTH_TOKEN;
  if (fromEnv) return fromEnv;
  const file = join(dataDir, 'token.txt');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const token = randomBytes(24).toString('base64url');
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

const isLoopback = (host) => host === '127.0.0.1' || host === 'localhost' || host === '::1';

function main() {
  const args = parseArgs(process.argv.slice(2));
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const host = process.env.HOST ?? DEFAULT_HOST;
  const dataDir = resolve(process.env.DATA_DIR ?? '.data');
  mkdirSync(dataDir, { recursive: true });

  const token = loadOrCreateToken(dataDir);
  const requireToken = !isLoopback(host) || process.env.REQUIRE_AUTH === '1';

  // Refuse to start unauthenticated on a non-loopback interface rather than quietly
  // exposing a writable database to the whole network.
  if (!isLoopback(host) && !process.env.AUTH_TOKEN && !existsSync(join(dataDir, 'token.txt'))) {
    console.error(
      `Refusing to bind ${host} without an access token. Set AUTH_TOKEN, or bind 127.0.0.1.`,
    );
    process.exit(1);
  }

  const origin = `http://${isLoopback(host) ? 'localhost' : host}:${port}`;
  const allowedOrigins = new Set([
    origin,
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    ...(process.env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean),
  ]);

  const staticRoot = args.staticDir ? resolve(args.staticDir) : null;

  void openDatabase(join(dataDir, 'history.db')).then((db) => {
    const server = createServer((req, res) => {
      handle(req, res, { db, allowedOrigins, token, requireToken, staticRoot }).catch((error) => {
        send(res, 500, { error: String(error?.message ?? error) });
      });
    });

    server.listen(port, host, () => {
      console.log(`Ember Mug history server listening on ${origin}`);
      console.log(`  database: ${join(dataDir, 'history.db')}`);
      if (staticRoot) console.log(`  app:      ${origin}  (open this, not a file:// page)`);
      if (requireToken) console.log(`  token:    ${token}`);
      else console.log('  auth:     none (loopback only, origin allowlist enforced)');
      if (args.open) openBrowser(origin);
    });
  });
}

function openBrowser(url) {
  import('node:child_process')
    .then(({ spawn }) => {
      const command =
        process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      spawn(command, [url], { shell: process.platform === 'win32', stdio: 'ignore', detached: true }).unref();
    })
    .catch(() => undefined);
}

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function corsHeaders(req, allowedOrigins) {
  const origin = req.headers.origin;
  const headers = {
    vary: 'Origin',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '86400',
    // Best effort for a page served from elsewhere; Chrome's handling of this is in flux,
    // which is why serving the app from here is the supported path.
    'access-control-allow-private-network': 'true',
  };
  if (origin && allowedOrigins.has(origin)) headers['access-control-allow-origin'] = origin;
  return headers;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function handle(req, res, ctx) {
  const { db, allowedOrigins, token, requireToken, staticRoot } = ctx;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const cors = corsHeaders(req, allowedOrigins);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  if (!url.pathname.startsWith('/api/')) {
    serveStatic(req, res, staticRoot, url.pathname);
    return;
  }

  // A malicious page the user visits could otherwise reach 127.0.0.1 directly.
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.has(origin)) {
    send(res, 403, { error: `Origin ${origin} is not allowed.` }, cors);
    return;
  }
  if (requireToken) {
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${token}`) {
      send(res, 401, { error: 'Missing or invalid access token.' }, cors);
      return;
    }
  }

  const path = url.pathname.replace(/^\/api\/v1/, '');
  const q = url.searchParams;
  const num = (key, fallback) => {
    const raw = q.get(key);
    if (raw === null) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };

  // GET /health
  if (req.method === 'GET' && path === '/health') {
    send(res, 200, { ok: true, schemaVersion: SCHEMA_VERSION, writable: true }, cors);
    return;
  }

  // GET /devices
  if (req.method === 'GET' && path === '/devices') {
    send(res, 200, db.listDevices(), cors);
    return;
  }

  const deviceMatch = /^\/devices\/([^/]+)(\/.*)?$/.exec(path);
  if (deviceMatch) {
    const deviceId = decodeURIComponent(deviceMatch[1]);
    const rest = deviceMatch[2] ?? '';

    if (req.method === 'PUT' && rest === '') {
      db.upsertDevice(await readBody(req));
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (req.method === 'DELETE' && rest === '') {
      db.deleteDevice(deviceId);
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (req.method === 'POST' && rest === '/merge') {
      const body = await readBody(req);
      send(res, 200, db.mergeDevices(deviceId, body.intoId), cors);
      return;
    }
    if (req.method === 'POST' && rest === '/samples') {
      const body = await readBody(req);
      send(res, 200, db.insertSamples(deviceId, body.rows ?? []), cors);
      return;
    }
    if (req.method === 'GET' && rest === '/samples') {
      const bucket = q.get('bucket') ?? 'raw';
      const from = num('from', 0);
      const to = num('to', Date.now());
      const limit = num('limit', 20000);
      const rows = db.bucketed(deviceId, from, to, BUCKET_MS[bucket] ?? 0, limit);
      send(res, 200, frameFromRows(deviceId, bucket, from, to, rows, limit), cors);
      return;
    }
    if (req.method === 'DELETE' && rest === '/samples') {
      const include = (q.get('include') ?? 'samples,events,sessions').split(',');
      send(
        res,
        200,
        db.deleteRange(deviceId, num('from', 0), num('to', Date.now()), include),
        cors,
      );
      return;
    }
    if (req.method === 'POST' && rest === '/events') {
      const body = await readBody(req);
      send(res, 200, db.insertEvents(body.rows ?? []), cors);
      return;
    }
    if (req.method === 'GET' && rest === '/events') {
      const types = q.get('types')?.split(',');
      send(
        res,
        200,
        db.queryEvents(deviceId, num('from', 0), num('to', Date.now()), types, num('limit', 100000)),
        cors,
      );
      return;
    }
    if (req.method === 'GET' && rest === '/bounds') {
      send(res, 200, db.bounds(deviceId), cors);
      return;
    }
    if (req.method === 'GET' && rest === '/stats') {
      send(res, 200, db.aggregate(deviceId, num('from', 0), num('to', Date.now())), cors);
      return;
    }
    if (req.method === 'GET' && rest === '/sessions') {
      send(res, 200, db.listSessions(deviceId, num('from', 0), num('to', Date.now())), cors);
      return;
    }
    const sessionMatch = /^\/sessions\/([^/]+)$/.exec(rest);
    if (req.method === 'PUT' && sessionMatch) {
      db.upsertSession(await readBody(req));
      res.writeHead(204, cors);
      res.end();
      return;
    }
  }

  const endMatch = /^\/sessions\/([^/]+)\/end$/.exec(path);
  if (req.method === 'POST' && endMatch) {
    const body = await readBody(req);
    db.endSession(
      decodeURIComponent(endMatch[1]),
      body.endedMs,
      body.reason,
      body.sampleCount ?? 0,
    );
    res.writeHead(204, cors);
    res.end();
    return;
  }

  if (req.method === 'GET' && path === '/export') {
    streamExport(res, db, url.searchParams, cors);
    return;
  }

  if (req.method === 'POST' && path === '/import') {
    const body = await readBody(req);
    send(res, 200, importChunk(db, body.chunk, body.options ?? {}), cors);
    return;
  }

  if (req.method === 'POST' && path === '/maintenance/vacuum') {
    db.vacuum();
    send(res, 200, { ok: true }, cors);
    return;
  }

  send(res, 404, { error: `No route for ${req.method} ${url.pathname}` }, cors);
}

/** Converts SQL rows into the columnar frame the client expects. */
function frameFromRows(deviceId, bucket, from, to, rows, limit) {
  const scale = (v, by) => (v === null || v === undefined ? null : v / by);
  const capped = rows.slice(0, limit);
  return {
    deviceId,
    bucket,
    from,
    to,
    t: capped.map((r) => Number(r.b) / 1000),
    tempC: capped.map((r) => scale(r.temp_avg, 100)),
    tempMinC: capped.map((r) => scale(r.temp_min, 100)),
    tempMaxC: capped.map((r) => scale(r.temp_max, 100)),
    targetC: capped.map((r) => scale(r.target_last, 100)),
    batteryPct: capped.map((r) => scale(r.batt_avg, 10)),
    batteryMinPct: capped.map((r) => scale(r.batt_min, 10)),
    batteryMaxPct: capped.map((r) => scale(r.batt_max, 10)),
    liquidPct: capped.map((r) => scale(r.liquid_avg, 10)),
    liquidState: capped.map((r) => (r.state_last === undefined ? null : r.state_last)),
    chargeFrac: capped.map((r) => (r.charge_frac === undefined ? null : r.charge_frac)),
    count: capped.map((r) => Number(r.n)),
    truncated: rows.length > limit,
  };
}

function streamExport(res, db, params, cors) {
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    ...cors,
  });
  const line = (obj) => res.write(`${JSON.stringify(obj)}\n`);

  const from = Number(params.get('from') ?? Number.MIN_SAFE_INTEGER);
  const to = Number(params.get('to') ?? Number.MAX_SAFE_INTEGER);
  const only = params.get('deviceIds')?.split(',');
  const include = (params.get('include') ?? 'devices,sessions,events,samples').split(',');

  line({ kind: 'header', v: 1, exportedAt: Date.now(), source: 'server', sourceId: 'server' });

  const devices = db.listDevices().filter((d) => !only || only.includes(d.deviceId));
  if (include.includes('devices')) line({ kind: 'devices', rows: devices });

  for (const device of devices) {
    if (include.includes('sessions')) {
      const rows = db.listSessions(device.deviceId, from, to);
      if (rows.length > 0) line({ kind: 'sessions', rows });
    }
    if (include.includes('events')) {
      const rows = db.queryEvents(device.deviceId, from, to, null, 1000000);
      for (let i = 0; i < rows.length; i += 1000) {
        line({ kind: 'events', rows: rows.slice(i, i + 1000) });
      }
    }
    if (include.includes('samples')) {
      // Paged by timestamp rather than offset, so concurrent writes cannot shift the page.
      let cursor = from;
      for (;;) {
        const rows = db.rawSamples(device.deviceId, cursor, to, 1000);
        if (rows.length === 0) break;
        const lastTs = Number(rows[rows.length - 1].ts);
        line({
          kind: 'samples',
          deviceId: device.deviceId,
          rows: rows.map(sampleFromRow),
          lastTs,
        });
        if (rows.length < 1000) break;
        cursor = lastTs + 1;
      }
    }
  }
  res.end();
}

function sampleFromRow(r) {
  return {
    deviceId: r.device_id,
    ts: Number(r.ts),
    sessionId: r.session_id,
    tempC: r.temp_c,
    targetC: r.target_c,
    batteryDpc: r.battery_dpc,
    liquidDpc: r.liquid_dpc,
    liquidState: r.liquid_state,
    batteryMv: r.battery_mv,
    flags: r.flags,
  };
}

function importChunk(db, chunk, options) {
  if (options.dryRun) {
    const rows = chunk.rows?.length ?? 0;
    return { kind: chunk.kind, rowsSeen: rows, rowsAccepted: 0, rowsDeduped: 0 };
  }
  switch (chunk.kind) {
    case 'devices':
      for (const device of chunk.rows) db.upsertDevice(device);
      return {
        kind: 'devices',
        rowsSeen: chunk.rows.length,
        rowsAccepted: chunk.rows.length,
        rowsDeduped: 0,
      };
    case 'sessions':
      for (const session of chunk.rows) db.upsertSession(session);
      return {
        kind: 'sessions',
        rowsSeen: chunk.rows.length,
        rowsAccepted: chunk.rows.length,
        rowsDeduped: 0,
      };
    case 'events': {
      const result = db.insertEvents(chunk.rows);
      return {
        kind: 'events',
        rowsSeen: chunk.rows.length,
        rowsAccepted: result.accepted,
        rowsDeduped: result.deduped,
      };
    }
    case 'samples': {
      const tuples = chunk.rows.map((s) => [
        s.ts,
        s.tempC,
        s.targetC,
        s.batteryDpc,
        s.liquidDpc,
        s.liquidState,
        s.batteryMv,
        s.flags,
        s.sessionId,
      ]);
      const result = db.insertSamples(chunk.deviceId, tuples);
      return {
        kind: 'samples',
        deviceId: chunk.deviceId,
        rowsSeen: chunk.rows.length,
        rowsAccepted: result.accepted,
        rowsDeduped: result.deduped,
        lastTs: chunk.lastTs,
      };
    }
    default:
      return { kind: chunk.kind ?? 'devices', rowsSeen: 0, rowsAccepted: 0, rowsDeduped: 0 };
  }
}

function serveStatic(req, res, staticRoot, pathname) {
  if (!staticRoot) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('This server is running API-only. Start it with --serve-static ./dist to host the app.');
    return;
  }

  const requested = pathname === '/' ? '/index.html' : pathname;
  const candidate = resolve(join(staticRoot, normalize(requested)));
  // Anything that escapes the static root falls through to the SPA entry point.
  const inside = candidate.startsWith(staticRoot);
  const file = inside && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : join(staticRoot, 'index.html');

  if (!existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('The app has not been built yet. Run: npm run build');
    return;
  }

  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000',
  });
  createReadStream(file).pipe(res);
}

main();
