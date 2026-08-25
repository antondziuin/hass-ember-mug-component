/**
 * Everything before there is a live connection.
 *
 * The reload case matters most: without the persistent-permissions flag the page cannot
 * re-acquire a device on its own, so it shows the last known readings greyed out with a
 * timestamp and one obvious button, rather than an empty skeleton that looks broken.
 */

import { useState } from 'react';

import { canSilentlyReconnect } from '../lib/ember/requestDevice.js';
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

export function ConnectScreen(): JSX.Element {
  const state = useAppState();
  const controller = useController();
  const [showFlagHelp, setShowFlagHelp] = useState(false);

  if (state.unsupported) {
    return (
      <Card title="This browser cannot talk to Bluetooth devices">
        <p>{describeUnsupported(state.unsupported.reason)}</p>
        <ul className="muted">
          <li>Chrome, Edge or Opera on Windows, macOS, Linux or ChromeOS.</li>
          <li>Chrome on Android.</li>
          <li>On iOS, the Bluefy browser — Safari does not implement Web Bluetooth.</li>
        </ul>
        <p className="muted small">
          Firefox and Safari have both declined to implement the API, so there is no version of
          this page that will work in them.
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
          Turn Bluetooth on, then try connecting again.
        </Banner>
      )}

      {remembered ? (
        <RememberedCard remembered={remembered} busy={state.busy} />
      ) : (
        <Card
          title="Connect your Ember mug"
          subtitle="Everything happens in this browser — nothing is sent anywhere."
        >
          <ol className="steps">
            <li>Take the mug off its charger.</li>
            <li>
              Hold the button on the bottom until the light flashes <strong>blue</strong>.
            </li>
            <li>Press Connect and pick the mug in the browser dialog.</li>
          </ol>
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={state.busy}
              onClick={() => void controller.connect()}
            >
              {state.busy ? 'Waiting for the picker…' : 'Connect'}
            </button>
            <button
              type="button"
              className="ghost"
              disabled={state.busy}
              onClick={() => void controller.connect({ acceptAll: true })}
            >
              My mug isn&apos;t listed
            </button>
          </div>
          <p className="muted small">
            If the phone app is connected to the mug, close it first — the mug accepts only one
            connection at a time.
          </p>
        </Card>
      )}

      {!canSilentlyReconnect() && (
        <Card
          title="Reconnect without the picker"
          subtitle="Optional, and only if the dialog every reload gets tiresome."
        >
          {showFlagHelp ? (
            <>
              <p className="muted">
                Chrome can remember Bluetooth permissions, but the feature is still behind a flag.
                A page is not allowed to open a <code>chrome://</code> address, so copy this and
                paste it into the address bar yourself:
              </p>
              <CopyBox value={PERMISSIONS_FLAG} />
              <p className="muted small">
                Set it to Enabled and restart Chrome. This page will then reconnect on its own.
              </p>
            </>
          ) : (
            <button type="button" className="ghost" onClick={() => setShowFlagHelp(true)}>
              Show me how
            </button>
          )}
        </Card>
      )}
    </div>
  );
}

function RememberedCard({
  remembered,
  busy,
}: {
  remembered: RememberedDevice;
  busy: boolean;
}): JSX.Element {
  const controller = useController();
  const { attrs } = remembered;

  return (
    <Card
      title={attrs.name || remembered.bleName || 'Your Ember mug'}
      subtitle={`Last seen ${relativeTime(remembered.lastSeenAt)}`}
    >
      <div className="stale-readings" aria-hidden="true">
        <div>
          <span className="stat-label">Temperature</span>
          <span className="stat-value">
            {attrs.currentTemp === undefined ? '--' : `${attrs.currentTemp.toFixed(1)}°C`}
          </span>
        </div>
        <div>
          <span className="stat-label">State</span>
          <span className="stat-value">
            {attrs.liquidState === undefined || attrs.liquidState === null
              ? '--'
              : LIQUID_STATE_LABEL[attrs.liquidState as LiquidState]}
          </span>
        </div>
        <div>
          <span className="stat-label">Battery</span>
          <span className="stat-value">
            {attrs.battery ? `${attrs.battery.percent}%` : '--'}
          </span>
        </div>
      </div>

      <p className="muted">
        These are the last readings from before the page reloaded. The browser will not let a page
        reconnect on its own, so one press is needed.
      </p>
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
          Forget this mug
        </button>
      </div>
      {remembered.bleName && (
        <p className="muted small">
          Pick <strong>{remembered.bleName}</strong> in the dialog.
        </p>
      )}
    </Card>
  );
}

function describeUnsupported(reason: string): string {
  switch (reason) {
    case 'insecure-context':
      return 'Web Bluetooth needs a secure page. Open this over https://, or from http://localhost.';
    case 'no-adapter':
      return 'No Bluetooth adapter was found. Check that Bluetooth is switched on.';
    default:
      return 'This browser does not implement the Web Bluetooth API.';
  }
}
