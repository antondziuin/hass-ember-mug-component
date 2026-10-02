import { useEffect, useState } from 'react';

import { ConnectScreen } from './ui/ConnectScreen.js';
import { HistoryView } from './ui/HistoryView.js';
import { LiveView } from './ui/LiveView.js';
import { SettingsView } from './ui/SettingsView.js';
import { Toast, ToastHost } from './ui/components.js';
import { AppProvider, useAppState, useController } from './ui/context.js';

type Tab = 'live' | 'history' | 'settings';
const UNIT_KEY = 'ember.displayUnit';
const TABS: ReadonlyArray<[Tab, string]> = [
  ['live', 'Live'],
  ['history', 'History'],
  ['settings', 'Settings'],
];

export function App(): JSX.Element {
  return (
    <AppProvider>
      <ToastHost>
        <Shell />
      </ToastHost>
    </AppProvider>
  );
}

function Shell(): JSX.Element {
  const state = useAppState();
  const controller = useController();
  const [tab, setTab] = useState<Tab>(() => readTab());
  const [unit, setUnit] = useState<'C' | 'F'>(() => readUnit());

  useEffect(() => {
    try {
      localStorage.setItem(UNIT_KEY, unit);
    } catch {
      // A blocked storage just means the choice is not remembered.
    }
  }, [unit]);

  useEffect(() => {
    const sync = (): void => setTab(readTab());
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const selectTab = (next: Tab): void => {
    setTab(next);
    const hash = `#${next}`;
    if (window.location.hash !== hash) {
      history.replaceState(null, '', hash);
    }
  };

  const connected = state.device !== null;
  const recording = state.recorder?.recording ?? false;
  const connection = state.deviceState.connection;
  const status = connectionStatus(connection, recording, state.recorder?.isLeader);

  return (
    <div className="app">
      <header className="app-head">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <h1>Ember</h1>
        </div>

        <nav className="tabs" aria-label="Sections">
          {TABS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={tab === value ? 'active' : ''}
              onClick={() => selectTab(value)}
              aria-current={tab === value ? 'page' : undefined}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="app-tools">
          <div className="status" title={status.title}>
            <span className={`dot${status.dot}`} aria-hidden="true" />
            <span className="small muted status-label">{status.label}</span>
          </div>
          <div className="segmented compact" role="group" aria-label="Display unit">
            {(['C', 'F'] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={unit === value ? 'active' : ''}
                onClick={() => setUnit(value)}
              >
                °{value}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main>
        {state.notice && (
          <Toast key={state.notice} tone="warn" timeoutMs={6_000} onDismiss={() => controller.dismissNotice()}>
            {state.notice}
          </Toast>
        )}

        {tab === 'live' &&
          (connected ? (
            <LiveView unit={unit} />
          ) : (
            <ConnectScreen unit={unit} />
          ))}
        {tab === 'history' && <HistoryView unit={unit} />}
        {tab === 'settings' && <SettingsView />}
      </main>

      <footer className="small">
        Unofficial · protocol from{' '}
        <a href="https://github.com/sopelj/python-ember-mug" target="_blank" rel="noreferrer">
          python-ember-mug
        </a>
      </footer>
    </div>
  );
}

function connectionStatus(
  connection: { status: string; attempt?: number },
  recording: boolean,
  isLeader: boolean | undefined,
): { label: string; title: string; dot: string } {
  if (connection.status === 'connected') {
    return {
      label: recording ? 'Recording' : 'Connected',
      title: recording ? 'Connected and recording history' : 'Connected',
      dot: ' dot-live',
    };
  }
  if (connection.status === 'reconnecting') {
    return {
      label: 'Reconnecting',
      title: `Trying to restore the link (attempt ${connection.attempt ?? 1})`,
      dot: ' dot-warn',
    };
  }
  if (connection.status === 'connecting' || connection.status === 'discovering') {
    return { label: 'Connecting', title: 'Opening a Bluetooth session', dot: ' dot-warn' };
  }
  if (isLeader === false) {
    return { label: 'Other tab', title: 'Recording in another tab', dot: '' };
  }
  return { label: 'Offline', title: 'Not connected', dot: '' };
}

function readTab(): Tab {
  const hash = window.location.hash.replace(/^#/, '');
  return hash === 'history' || hash === 'settings' || hash === 'live' ? hash : 'live';
}

function readUnit(): 'C' | 'F' {
  try {
    const stored = localStorage.getItem(UNIT_KEY);
    if (stored === 'C' || stored === 'F') return stored;
  } catch {
    // Fall through to the locale guess.
  }
  const locale = typeof navigator === 'undefined' ? 'en-GB' : navigator.language;
  return /^en-(US|LR)|^my/i.test(locale) ? 'F' : 'C';
}
