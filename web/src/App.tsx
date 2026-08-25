import { useEffect, useState } from 'react';

import { ConnectScreen } from './ui/ConnectScreen.js';
import { HistoryView } from './ui/HistoryView.js';
import { LiveView } from './ui/LiveView.js';
import { SettingsView } from './ui/SettingsView.js';
import { Banner } from './ui/components.js';
import { AppProvider, useAppState, useController } from './ui/context.js';

type Tab = 'live' | 'history' | 'settings';
const UNIT_KEY = 'ember.displayUnit';

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
  const [tab, setTab] = useState<Tab>('live');
  const [unit, setUnit] = useState<'C' | 'F'>(() => readUnit());

  useEffect(() => {
    try {
      localStorage.setItem(UNIT_KEY, unit);
    } catch {
      // A blocked storage just means the choice is not remembered.
    }
  }, [unit]);

  const connected = state.device !== null;
  const recording = state.recorder?.recording ?? false;

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
          {(
            [
              ['live', 'Live'],
              ['history', 'History'],
              ['settings', 'Settings'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={tab === value ? 'active' : ''}
              onClick={() => setTab(value)}
              aria-current={tab === value ? 'page' : undefined}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="status" title={recording ? 'Recording history' : 'Not recording'}>
          <span className={`dot${recording ? ' dot-live' : ''}`} aria-hidden="true" />
          <span className="small muted">
            {recording
              ? `${state.recorder?.samplesWritten ?? 0} stored`
              : state.recorder?.isLeader === false
                ? 'Recording in another tab'
                : 'Idle'}
          </span>
        </div>
      </header>

      <main>
        {state.notice && (
          <Banner tone="warn" onDismiss={() => controller.dismissNotice()}>
            {state.notice}
          </Banner>
        )}

        {tab === 'live' &&
          (connected ? <LiveView unit={unit} onUnitChange={setUnit} /> : <ConnectScreen />)}
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

function readUnit(): 'C' | 'F' {
  try {
    const stored = localStorage.getItem(UNIT_KEY);
    if (stored === 'C' || stored === 'F') return stored;
  } catch {
    // Fall through to the locale guess.
  }
  // Fahrenheit only where it is actually the everyday unit.
  const locale = typeof navigator === 'undefined' ? 'en-GB' : navigator.language;
  return /^en-(US|LR)|^my/i.test(locale) ? 'F' : 'C';
}
