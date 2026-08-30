import { useEffect, useState } from 'react';

import { ConnectScreen } from './ui/ConnectScreen.js';
import { HistoryView } from './ui/HistoryView.js';
import { LiveView } from './ui/LiveView.js';
import { SettingsView } from './ui/SettingsView.js';
import { Banner } from './ui/components.js';
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
      <Shell />
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
          <div>
            <h1>Ember Mug</h1>
            <p className="muted small">Bluetooth, straight from the browser</p>
          </div>
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
          <div className="segmented" role="group" aria-label="Display unit">
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
          <div className="status" title={status.title}>
            <span className={`dot${status.dot}`} aria-hidden="true" />
            <span className="small muted">{status.label}</span>
          </div>
        </div>
      </header>

      <main>
        {state.notice && (
          <Banner tone="warn" onDismiss={() => controller.dismissNotice()}>
            {state.notice}
          </Banner>
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

      <footer className="muted small">
        Not affiliated with Ember. Protocol details come from the{' '}
        <a href="https://github.com/sopelj/python-ember-mug" target="_blank" rel="noreferrer">
          python-ember-mug
        </a>{' '}
        project.
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
      label: recording ? 'Connected · recording' : 'Connected',
      title: recording ? 'Recording history' : 'Connected',
      dot: ' dot-live',
    };
  }
  if (connection.status === 'reconnecting') {
    return {
      label: `Reconnecting · ${connection.attempt ?? 1}`,
      title: 'Trying to restore the link',
      dot: ' dot-warn',
    };
  }
  if (connection.status === 'connecting' || connection.status === 'discovering') {
    return { label: 'Connecting', title: 'Opening a Bluetooth session', dot: ' dot-warn' };
  }
  if (isLeader === false) {
    return { label: 'Recording in another tab', title: 'This tab is not the writer', dot: '' };
  }
  return { label: 'Idle', title: 'Not recording', dot: '' };
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
