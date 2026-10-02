/**
 * Everything before there is a live connection.
 *
 * The reload case matters most: without the persistent-permissions flag the page cannot
 * re-acquire a device on its own, so it shows the last known readings greyed out with a
 * timestamp and one obvious button, rather than an empty skeleton that looks broken.
 */

import { canSilentlyReconnect } from '../lib/ember/requestDevice.js';
import { celsiusToFahrenheit } from '../lib/ember/codecs.js';
import type { RememberedDevice } from '../lib/ember/types.js';
import { LIQUID_STATE_LABEL, type LiquidState } from '../lib/ember/constants.js';

import { Banner, Card, CopyBox } from './components.js';
import { useAppState, useController } from './context.js';

const PERMISSIONS_FLAG = 'chrome://flags/#enable-web-bluetooth-new-permissions-backend';

function relativeTime(ts: number): string {
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 60) return 'moments ago';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function ConnectScreen({ unit }: { unit: 'C' | 'F' }): JSX.Element {
  const state = useAppState();
  const controller = useController();

  if (state.unsupported) {
    return (
      <Card title="Bluetooth unavailable" subtitle={describeUnsupported(state.unsupported.reason)}>
        <p className="muted small">
          Use Chrome, Edge or Opera on desktop, Chrome on Android, or Bluefy on iOS. Firefox and
          Safari do not support Web Bluetooth.
        </p>
      </Card>
    );
  }

  const remembered =
    state.deviceState.connection.status === 'needs-gesture'
      ? state.deviceState.connection.remembered
      : null;

  return (
    <div className="stack">
      {!state.adapterAvailable && (
        <Banner tone="warn" title="Bluetooth is off">
          Turn it on and try again.
        </Banner>
      )}

      {remembered ? (
        <RememberedCard remembered={remembered} busy={state.busy} unit={unit} />
      ) : (
        <Card title="Connect your mug" subtitle="Runs entirely in this browser.">
          <ol className="steps">
            <li>Take the mug off its charger.</li>
            <li>
              Hold the bottom button until the light flashes <strong>blue</strong>.
            </li>
            <li>Press Connect and pick the mug.</li>
          </ol>
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={state.busy}
              onClick={() => void controller.connect()}
            >
              {state.busy ? 'Waiting…' : 'Connect'}
            </button>
            <button
              type="button"
              className="ghost"
              disabled={state.busy}
              onClick={() => void controller.connect({ acceptAll: true })}
            >
              Show all devices
            </button>
          </div>
          <p className="subtle small">Close the Ember phone app first — the mug allows one connection.</p>
        </Card>
      )}

      {!canSilentlyReconnect() && (
        <details className="disclosure">
          <summary>Skip the device picker on reload</summary>
          <div>
            <p className="muted small">
              Enable this Chrome flag, then restart Chrome. Pages can&apos;t open{' '}
              <code>chrome://</code> links, so paste it into the address bar.
            </p>
            <CopyBox value={PERMISSIONS_FLAG} />
          </div>
        </details>
      )}
    </div>
  );
}

function RememberedCard({
  remembered,
  busy,
  unit,
}: {
  remembered: RememberedDevice;
  busy: boolean;
  unit: 'C' | 'F';
}): JSX.Element {
  const controller = useController();
  const { attrs } = remembered;
  const temp =
    attrs.currentTemp === undefined
      ? '--'
      : `${(unit === 'F' ? celsiusToFahrenheit(attrs.currentTemp) : attrs.currentTemp).toFixed(1)}°${unit}`;

  return (
    <Card
      title={attrs.name || remembered.bleName || 'Your Ember mug'}
      subtitle={`Last seen ${relativeTime(remembered.lastSeenAt)}`}
    >
      <div className="stale-readings" aria-hidden="true">
        <div className="stat">
          <span className="stat-label">Temperature</span>
          <span className="stat-value">{temp}</span>
        </div>
        <div className="stat">
          <span className="stat-label">State</span>
          <span className="stat-value">
            {attrs.liquidState === undefined || attrs.liquidState === null
              ? '--'
              : LIQUID_STATE_LABEL[attrs.liquidState as LiquidState]}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Battery</span>
          <span className="stat-value">
            {attrs.battery ? `${attrs.battery.percent}%` : '--'}
          </span>
        </div>
      </div>

      <div className="row">
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void controller.connect()}
        >
          Reconnect
        </button>
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() => void controller.disconnect()}
        >
          Forget
        </button>
        {remembered.bleName && (
          <span className="subtle small">
            Pick <strong>{remembered.bleName}</strong> in the dialog.
          </span>
        )}
      </div>
    </Card>
  );
}

function describeUnsupported(reason: string): string {
  switch (reason) {
    case 'insecure-context':
      return 'Open this page over https:// or from localhost.';
    case 'no-adapter':
      return 'No Bluetooth adapter found.';
    default:
      return 'This browser does not support Web Bluetooth.';
  }
}
