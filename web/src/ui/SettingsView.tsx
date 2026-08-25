/**
 * Storage configuration, migration, recording detail and diagnostics.
 */

import { useEffect, useState } from 'react';

import {
  createLocalStore,
  createStore,
  describeStoreConfig,
  type StoreConfig,
} from '../history/activeStore.js';
import { Migrator, exportToNdjson, readNdjson, type MigrationEvent } from '../history/migrate/Migrator.js';
import { GATE_PRESETS } from '../history/gate.js';
import { requestPersistence } from '../history/recorder.js';
import type { HistoryStore, StoreProbe } from '../history/HistoryStore.js';
import type { GatePreset } from '../app/AppController.js';

import { Banner, Card, CopyBox, Field, Spinner } from './components.js';
import { useAppState, useController } from './context.js';

export function SettingsView(): JSX.Element {
  const state = useAppState();

  return (
    <div className="stack">
      <StorageCard />
      <PersistenceCard />
      <RecordingCard preset={state.gatePreset} />
      <BackupCard />
      <DiagnosticsCard />
    </div>
  );
}

function StorageCard(): JSX.Element {
  const state = useAppState();
  const controller = useController();
  const [kind, setKind] = useState<StoreConfig['kind']>(state.storeConfig.kind);
  const [baseUrl, setBaseUrl] = useState(
    state.storeConfig.kind === 'server' ? state.storeConfig.baseUrl : 'http://localhost:41821',
  );
  const [token, setToken] = useState(
    state.storeConfig.kind === 'server' ? (state.storeConfig.token ?? '') : '',
  );
  const [url, setUrl] = useState(state.storeConfig.kind === 'supabase' ? state.storeConfig.url : '');
  const [anonKey, setAnonKey] = useState(
    state.storeConfig.kind === 'supabase' ? state.storeConfig.anonKey : '',
  );
  const [probe, setProbe] = useState<StoreProbe | null>(null);
  const [testing, setTesting] = useState(false);
  const [migration, setMigration] = useState<MigrationEvent[] | null>(null);

  const build = (): StoreConfig => {
    if (kind === 'server') return token ? { kind, baseUrl, token } : { kind, baseUrl };
    if (kind === 'supabase') return { kind, url, anonKey };
    return { kind: 'indexeddb' };
  };

  const test = async (): Promise<void> => {
    setTesting(true);
    setProbe(null);
    try {
      const store = await createStore(build());
      await store.open();
      setProbe(await store.probe());
      await store.close();
    } catch (error) {
      setProbe({
        ok: false,
        kind: kind === 'indexeddb' ? 'indexeddb' : kind,
        id: '',
        latencyMs: 0,
        schemaVersion: 0,
        writable: false,
        capabilities: {
          buckets: [],
          serverSideBucketing: false,
          serverSideStats: false,
          maxBatchRows: 0,
          streamingExport: false,
          deleteRange: false,
          multiDevice: false,
          transactional: false,
        },
        error: {
          code: 'unknown',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      setTesting(false);
    }
  };

  const migrate = async (): Promise<void> => {
    const source = state.historyStore;
    if (!source) return;
    setMigration([]);
    const target = await createStore(build());
    await target.open();

    const migrator = new Migrator(source, target);
    const events: MigrationEvent[] = [];
    for await (const event of migrator.run({})) {
      events.push(event);
      setMigration([...events]);
    }
    // The active store only changes once the copy has been verified.
    const verified = events.find((e) => e.type === 'verified');
    if (verified && verified.type === 'verified' && verified.perDevice.every((d) => d.ok)) {
      await controller.setStoreConfig(build());
    }
  };

  const changed = JSON.stringify(build()) !== JSON.stringify(state.storeConfig);

  return (
    <Card
      title="Where history is stored"
      subtitle={`Currently: ${describeStoreConfig(state.storeConfig)}`}
    >
      <div className="segmented wide" role="group" aria-label="Storage backend">
        {(
          [
            ['indexeddb', 'This browser'],
            ['server', 'Local server'],
            ['supabase', 'Supabase'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={kind === value ? 'active' : ''}
            onClick={() => {
              setKind(value);
              setProbe(null);
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {kind === 'indexeddb' && (
        <p className="muted">
          Readings stay in this browser. Nothing leaves the machine — and nothing syncs to your
          other devices either.
        </p>
      )}

      {kind === 'server' && (
        <div className="stack">
          <p className="muted">
            A small Node process with a SQLite file. It also serves this app, which is the
            supported way to use it: a page loaded from anywhere else is subject to Chrome&apos;s
            local-network rules and may be blocked.
          </p>
          <CopyBox value="npm run db:start" label="Copy command" />
          <Field label="Server address">
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
          </Field>
          <Field
            label="Access token"
            hint="Only needed if the server is not on localhost. It prints one on startup."
          >
            <input
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="optional"
            />
          </Field>
        </div>
      )}

      {kind === 'supabase' && (
        <div className="stack">
          <p className="muted">
            Syncs across devices. Run <code>web/supabase/migrations/0001_init.sql</code> in the
            project&apos;s SQL editor first, then sign in.
          </p>
          <Field label="Project URL">
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://xxxx.supabase.co"
            />
          </Field>
          <Field
            label="Anon key"
            hint="This key is meant to be public. Row level security is what protects the data — never paste a service_role key here."
          >
            <input value={anonKey} onChange={(event) => setAnonKey(event.target.value)} />
          </Field>
        </div>
      )}

      <div className="row">
        <button type="button" className="ghost" onClick={() => void test()} disabled={testing}>
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        {changed && (
          <>
            <button type="button" className="primary" onClick={() => void migrate()}>
              Move history here
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => void controller.setStoreConfig(build())}
            >
              Switch without copying
            </button>
          </>
        )}
      </div>

      {probe && (
        <Banner tone={probe.ok ? 'good' : 'error'}>
          {probe.ok ? (
            <>
              Connected in {probe.latencyMs} ms.
              {probe.usage?.rowCount !== undefined && ` ${probe.usage.rowCount} readings stored.`}
            </>
          ) : (
            <>
              {probe.error?.message}
              {probe.error?.hint && <> {probe.error.hint}</>}
            </>
          )}
        </Banner>
      )}

      {migration && <MigrationProgress events={migration} />}

      {state.storeError && <Banner tone="warn">{state.storeError}</Banner>}
    </Card>
  );
}

function MigrationProgress({ events }: { events: MigrationEvent[] }): JSX.Element {
  const last = events[events.length - 1];
  const progress = [...events].reverse().find((e) => e.type === 'progress');
  const done = events.find((e) => e.type === 'done');
  const failed = events.find((e) => e.type === 'failed');
  const plan = events.find((e) => e.type === 'plan');

  if (failed && failed.type === 'failed') {
    return (
      <Banner tone="error" title="Copy stopped">
        {failed.error} Nothing was lost — press &ldquo;Move history here&rdquo; again to carry on
        from where it stopped.
      </Banner>
    );
  }

  if (done && done.type === 'done') {
    return (
      <Banner tone="good" title="Copied">
        {done.rowsCopied} readings copied, {done.rowsDeduped} already there. Your local copy has
        been kept as a backup — you can clear it below once you are happy.
      </Banner>
    );
  }

  const total = plan?.type === 'plan' ? plan.plan.totalRows : 0;
  const rowsDone = progress?.type === 'progress' ? progress.rowsDone : 0;
  const percent = total > 0 ? Math.min((rowsDone / total) * 100, 100) : 0;

  return (
    <div className="stack">
      <div className="coverage-bar">
        <span style={{ width: `${percent}%` }} />
      </div>
      <p className="muted small">
        {last?.type === 'plan' ? 'Planning…' : `${rowsDone} of ${total} rows`}
        {progress?.type === 'progress' && ` · ${Math.round(progress.rowsPerSec)}/s`}
      </p>
    </div>
  );
}

function PersistenceCard(): JSX.Element {
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [usage, setUsage] = useState<StorageEstimate | null>(null);

  useEffect(() => {
    void requestPersistence().then((result) => {
      setPersisted(result.persisted);
      setUsage(result.usage ?? null);
    });
  }, []);

  const used = usage?.usage ? (usage.usage / 1024 / 1024).toFixed(1) : null;
  const quota = usage?.quota ? (usage.quota / 1024 / 1024).toFixed(0) : null;

  return (
    <Card title="Browser storage">
      {persisted === null ? (
        <Spinner />
      ) : persisted ? (
        <p className="muted">
          Storage is marked as persistent, so the browser will not clear it to reclaim space.
          {used && quota && ` Using ${used} MB of about ${quota} MB.`}
        </p>
      ) : (
        <Banner tone="warn" title="Storage is not persistent">
          The browser may clear this site&apos;s data at any time to reclaim space, taking the
          history with it. Keeping using the app usually earns persistence automatically. Until
          then, export a backup or connect a database.
          {used && quota && ` Using ${used} MB of about ${quota} MB.`}
        </Banner>
      )}
    </Card>
  );
}

function RecordingCard({ preset }: { preset: GatePreset }): JSX.Element {
  const controller = useController();
  const config = GATE_PRESETS[preset]!;

  return (
    <Card
      title="Recording detail"
      subtitle="How much movement is needed before a reading is stored."
    >
      <div className="segmented wide">
        {(Object.keys(GATE_PRESETS) as GatePreset[]).map((value) => (
          <button
            key={value}
            type="button"
            className={preset === value ? 'active' : ''}
            onClick={() => controller.setGatePreset(value)}
          >
            {value[0]!.toUpperCase() + value.slice(1)}
          </button>
        ))}
      </div>
      <p className="muted small">
        Stores a reading when temperature moves {(config.tempDeltaCentiC / 100).toFixed(2)} °C,
        battery moves {(config.batteryDeltaDpc / 10).toFixed(1)} %, the state changes, or every{' '}
        {Math.round(config.heartbeatMs / 60_000)} minutes regardless. Applies from the next
        connection.
      </p>
    </Card>
  );
}

function BackupCard(): JSX.Element {
  const state = useAppState();
  const controller = useController();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const download = async (): Promise<void> => {
    if (!state.historyStore) return;
    setBusy(true);
    try {
      const blob = await exportToNdjson(state.historyStore);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `ember-mug-history-${new Date().toISOString().slice(0, 10)}.ndjson`;
      anchor.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  };

  const restore = async (file: File): Promise<void> => {
    if (!state.historyStore) return;
    setBusy(true);
    setMessage(null);
    try {
      let accepted = 0;
      let deduped = 0;
      for await (const progress of state.historyStore.importStream(readNdjson(file))) {
        accepted += progress.rowsAccepted;
        deduped += progress.rowsDeduped;
      }
      setMessage(`Restored ${accepted} rows, skipped ${deduped} already present.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const clearLocal = async (): Promise<void> => {
    if (!confirm('Delete the local copy of your history? This cannot be undone.')) return;
    setBusy(true);
    try {
      const local = await createLocalStore();
      for (const device of await local.listDevices()) {
        await local.deleteDevice(device.deviceId);
      }
      setMessage('Local copy cleared.');
      await controller.setStoreConfig(state.storeConfig);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Backup" subtitle="One file, one line per batch. Re-importing is always safe.">
      <div className="row">
        <button type="button" className="ghost" disabled={busy} onClick={() => void download()}>
          Export everything
        </button>
        <label className="ghost button-like">
          Restore from a file
          <input
            type="file"
            accept=".ndjson,.json,application/x-ndjson"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void restore(file);
            }}
          />
        </label>
        {state.storeConfig.kind !== 'indexeddb' && (
          <button type="button" className="danger" disabled={busy} onClick={() => void clearLocal()}>
            Clear local copy
          </button>
        )}
      </div>
      {busy && <Spinner label="Working…" />}
      {message && <Banner tone="info">{message}</Banner>}
    </Card>
  );
}

function DiagnosticsCard(): JSX.Element {
  const state = useAppState();
  const device = state.device;
  const [copied, setCopied] = useState(false);

  const report = (): string => {
    const snapshot = state.deviceState;
    return JSON.stringify(
      {
        userAgent: navigator.userAgent,
        bleName: snapshot.bleName,
        serialNumber: snapshot.attrs.meta?.serialNumber ?? null,
        firmware: snapshot.attrs.firmware ?? null,
        detection: snapshot.detection,
        capabilities: [...snapshot.capabilities],
        unknownCharacteristics: snapshot.unknownCharUuids,
        writability: snapshot.writability,
        authInfoMissing: snapshot.authInfoMissing,
        log: device?.diagnostics.slice(-50) ?? [],
      },
      null,
      2,
    );
  };

  return (
    <Card
      title="Diagnostics"
      subtitle="Useful when a device is not recognised properly."
      actions={
        <button
          type="button"
          className="ghost"
          disabled={!device}
          onClick={() => {
            void navigator.clipboard?.writeText(report());
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? 'Copied' : 'Copy report'}
        </button>
      }
    >
      {!device ? (
        <p className="muted">Connect a device to collect diagnostics.</p>
      ) : (
        <>
          {state.deviceState.unknownCharUuids.length > 0 && (
            <p className="muted small">
              This device exposes {state.deviceState.unknownCharUuids.length} characteristic(s)
              this app does not recognise. Including them in a bug report helps.
            </p>
          )}
          <pre className="log">
            {device.diagnostics
              .slice(-20)
              .map((entry) => `${new Date(entry.at).toLocaleTimeString()}  ${entry.level.padEnd(5)}  ${entry.message}`)
              .join('\n') || 'Nothing logged yet.'}
          </pre>
        </>
      )}
    </Card>
  );
}

/** Re-exported for the settings page's dynamic store creation. */
export type { HistoryStore };
