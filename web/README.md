# Ember Mug — browser app

**Live: [antondziuin.github.io/hass-ember-mug-component](https://antondziuin.github.io/hass-ember-mug-component/)**

Monitor and control an Ember mug directly from a browser over Web Bluetooth, and keep a
history of temperature and battery with charts and statistics. No Home Assistant, no
Python, no phone app.

This lives alongside the Home Assistant integration in the same repository and shares its
protocol knowledge, but it is an entirely separate program — the Python side is untouched.

> The hosted build can use browser storage or Supabase. The local SQLite server is not
> reachable from it — a page served over https cannot reliably talk to `http://localhost`.
> For that, run it yourself as described below.

## Requirements

Web Bluetooth is not a universal API. It works in:

- **Chrome, Edge or Opera** on Windows, macOS, Linux and ChromeOS
- **Chrome on Android**
- **Bluefy** on iOS

Firefox and Safari have both declined to implement it, so there is no version of this page
that will work in them. The page also has to be served from `https://` or from
`http://localhost` — Web Bluetooth refuses to run in an insecure context.

Node 22.5 or newer is needed only if you want the optional SQLite server.

## Running it

```bash
cd web
npm install
npm run dev          # http://localhost:5173
```

Take the mug off its charger, hold the button underneath until the light flashes blue,
then press **Connect** and pick it in the browser dialog.

> The mug accepts one connection at a time. If the Ember phone app is connected, close it
> first, or expect repeated disconnects.

## Where history goes

| Backend | What it gives you | What it costs |
| --- | --- | --- |
| **This browser** (default) | Nothing to set up | Stays on this machine; the browser may evict it (see below) |
| **Local server** | A SQLite file you own, and it serves the app too | One Node process |
| **Supabase** | Syncs across devices | An account, and a SQL migration to run once |

Switching backends offers to copy the existing history across first. The copy is
idempotent — samples are keyed on `(device, timestamp)` and events on a natural key — so a
migration that is interrupted can simply be run again, and running it twice changes
nothing. The local copy is kept as a backup rather than deleted.

### Local server

```bash
npm run db:start     # builds the app, then serves it and the API on http://localhost:41821
```

Open **http://localhost:41821**, not the Vite dev server. That is deliberate: a page served
from somewhere else and reaching into `http://localhost` runs into Chrome's private
network access rules, which are actively being reworked into a user prompt. Serving the
page and the API from one origin removes CORS, mixed content and that prompt at a stroke —
and `localhost` is still a secure context, so Bluetooth keeps working.

The server binds to `127.0.0.1` and requires no password, but it does enforce an origin
allowlist, because a malicious page you visit could otherwise reach `127.0.0.1` from your
own browser. Binding it to anything other than loopback requires an access token, and it
refuses to start without one.

```bash
DATA_DIR=./mug-data PORT=41821 npm run db:dev   # development, with reload
docker compose up -d                            # or in a container
```

### Supabase

1. Create a project.
2. Run `supabase/migrations/0001_init.sql` in its SQL editor.
3. Paste the project URL and **anon** key into Settings, then sign in by email.

The anon key is public by design — it is meant to ship in a browser bundle. Row-level
security is what actually protects the data, so the app checks that RLS is enabled on all
four tables and refuses to use a project where it is not. Never paste a `service_role` key
anywhere in this app; it bypasses RLS entirely.

Free-tier projects pause after about a week of inactivity, which is a very plausible gap
for a mug logger. Readings queue locally and upload when the project wakes up.

## Things worth knowing

**Reconnecting after a reload needs one click.** Chrome will not let a page re-acquire a
Bluetooth device on its own unless
`chrome://flags/#enable-web-bluetooth-new-permissions-backend` is enabled. Without it the
app shows the last readings greyed out and a Reconnect button; with it, reconnection is
silent. Settings has the flag ready to copy.

**Recording only happens while the tab is open.** Chrome throttles background tabs to
roughly one timer tick a minute, so a backgrounded tab records less. Every rate statistic
is therefore shown next to a coverage figure — "drinks per day" measured over 30% coverage
would otherwise be wrong by about three times with nothing on screen to say so.

**Browser storage can be evicted.** Under storage pressure Chrome may discard an entire
origin's data without warning. The app asks for persistent storage after the first
successful connection, shows the result in Settings, and keeps a one-click export. If the
history matters, connect a database or export a backup.

**A mug that was never set up in the Ember app ignores writes.** It acknowledges them at
the Bluetooth level and then discards them, so the app detects this by reading values back
after writing. There is a way to force it, but it overwrites the mug's pairing key and
will most likely make the phone app re-add the device, so it sits behind a warning.

## Development

```bash
npm run dev          # dev server
npm test             # unit tests
npm run typecheck    # strict TypeScript
npm run build        # production bundle
```

Layout:

```
src/lib/ember/    Web Bluetooth device layer — protocol, GATT queue, connection lifecycle
src/history/      Storage abstraction, dead-banding, bucketing, three backends, migration
src/charts/       uPlot wrapper and plugins
src/stats/        Beverage segmentation and derived statistics
src/ui/           React screens
server/           Optional Node + SQLite service (plain JS, no dependencies)
supabase/         SQL migration
```

Both `lib/ember/` and `history/` are React-free, which is what makes them testable in Node
without a browser or a radio. `src/lib/ember/testing/fakeGatt.ts` is a full in-memory Ember
device: it stores raw bytes and lets the production codecs decode them, and it enforces
one GATT operation at a time exactly as Chrome does.

`src/history/__tests__/storeConformance.test.ts` is the test to keep an eye on. It holds
IndexedDB and SQLite to identical frames and aggregates over a 30-day fixture full of
awkward cases. Three independent implementations of gap-clamped, time-weighted bucketing
will drift apart, and the drift is invisible until two screens disagree about how long your
coffee was at the right temperature.

Hardware behaviour cannot be covered by any of that. See [TESTING.md](TESTING.md).

## Protocol

The Bluetooth protocol was extracted from
[python-ember-mug](https://github.com/sopelj/python-ember-mug), the library behind the Home
Assistant integration in this repository. `src/lib/ember/uuids.ts` and `codecs.ts` document
every characteristic, and the codec tests use the same golden vectors as the Python test
suite.

Not affiliated with Ember. Ember and related marks belong to their respective owners.
