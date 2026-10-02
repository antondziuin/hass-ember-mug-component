/**
 * The live dashboard: current readings plus every control the connected model supports.
 *
 * Controls are gated on `capabilities`, which is the model table intersected with the
 * characteristics this unit actually exposes - so a Cup never shows a name field and a
 * Travel Mug shows volume instead of an LED colour.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';

import {
  CONNECT_FAILURES_BEFORE_HINT,
  DEFAULT_PRESETS,
  LIQUID_STATE_LABEL,
  LiquidState,
  MAX_TEMP_C,
  MIN_TEMP_C,
  MUG_NAME_PATTERN,
  TemperatureUnit,
  VolumeLevel,
  VOLUME_LEVEL_LABEL,
  type DeviceModel,
} from '../lib/ember/constants.js';
import { celsiusToFahrenheit, colourToHex, hexToColour, liquidLevelPercent } from '../lib/ember/codecs.js';
import { ALL_MODELS } from '../lib/ember/models.js';
import type { EmberDevice } from '../lib/ember/emberDevice.js';
import type { EmberDeviceState } from '../lib/ember/types.js';

import { Card, Field, Stat, Switch, Toast, useHeld } from './components.js';
import { useAppState, useController } from './context.js';

export interface LiveViewProps {
  unit: 'C' | 'F';
}

export function LiveView({ unit }: LiveViewProps): JSX.Element {
  const state = useAppState();
  const controller = useController();
  const device = state.device;
  const deviceState = state.deviceState;
  const [error, setError] = useState<{ message: string; at: number } | null>(null);
  const [readOnlyDismissed, setReadOnlyDismissed] = useState(false);
  // Only a verdict that sticks, with nothing still in flight, is worth interrupting for.
  const readOnly = useHeld(
    deviceState.writability === 'no' && deviceState.pending.size === 0,
    1_200,
  );
  useEffect(() => {
    if (deviceState.writability !== 'no') setReadOnlyDismissed(false);
  }, [deviceState.writability]);

  if (!device) return <p className="muted">Not connected.</p>;

  const connected = deviceState.connection.status === 'connected';
  const stale = !connected;
  const { attrs } = deviceState;
  const value = (celsius: number): string =>
    (unit === 'F' ? celsiusToFahrenheit(celsius) : celsius).toFixed(1);
  const showTemp = (celsius: number | undefined): string =>
    celsius === undefined ? '--' : `${value(celsius)}°${unit}`;

  // Fire and forget: the device shows the new value at once and keeps writing it in the
  // background, through reconnects if need be. Only a definite refusal comes back here.
  const run = (action: () => Promise<unknown>) => () => {
    action().catch((e: unknown) =>
      setError({ message: e instanceof Error ? e.message : String(e), at: Date.now() }),
    );
  };

  const liquidLabel =
    attrs.liquidState === undefined || attrs.liquidState === null
      ? undefined
      : LIQUID_STATE_LABEL[attrs.liquidState];
  const targetOn = attrs.targetTemp !== undefined && attrs.targetTemp > 0;
  const hasDeviceSettings =
    deviceState.capabilities.has('name') ||
    deviceState.capabilities.has('ledColour') ||
    deviceState.capabilities.has('volumeLevel') ||
    deviceState.capabilities.has('temperatureUnit');

  return (
    <div className="stack">
      <ConnectionToast state={deviceState} device={device} />

      {readOnly && !readOnlyDismissed && (
        <Toast
          tone="warn"
          title="Read-only mug"
          action={<ForceWritableButton device={device} />}
          onDismiss={() => setReadOnlyDismissed(true)}
        >
          Set it up once in the Ember app to allow changes.
        </Toast>
      )}

      {error && (
        <Toast key={error.at} tone="error" timeoutMs={5_000} onDismiss={() => setError(null)}>
          {error.message}
        </Toast>
      )}

      <Card
        title={attrs.name || deviceState.bleName || 'Ember mug'}
        subtitle={<ModelLine state={deviceState} />}
        actions={
          <button type="button" className="ghost" onClick={() => void controller.disconnect()}>
            Disconnect
          </button>
        }
      >
        <div className={`hero${stale ? ' stale' : ''}`}>
          <div className="hero-temp" aria-label={`Current temperature ${showTemp(attrs.currentTemp)}`}>
            {attrs.currentTemp === undefined ? '--' : value(attrs.currentTemp)}
            <span className="unit">°{unit}</span>
          </div>
          <div className="hero-meta">
            {liquidLabel && (
              <span
                className={`chip-state${attrs.liquidState === LiquidState.PERFECT ? ' good' : ''}`}
              >
                {liquidLabel}
              </span>
            )}
            <span className="muted">
              {targetOn ? `Target ${showTemp(attrs.targetTemp)}` : 'Heating off'}
            </span>
          </div>
        </div>
        <hr className="divider" />
        <div className={`readings${stale ? ' stale' : ''}`}>
          <Stat
            label="Liquid"
            value={
              attrs.liquidLevel === undefined
                ? '--'
                : `${Math.round(liquidLevelPercent(attrs.liquidLevel, device.liquidLevelMax))}%`
            }
          />
          <Stat
            label="Battery"
            value={attrs.battery ? `${attrs.battery.percent.toFixed(0)}%` : '--'}
            hint={attrs.battery?.onChargingBase ? 'On charger' : undefined}
            tone={attrs.battery && attrs.battery.percent < 15 ? 'warn' : 'default'}
          />
          {deviceState.capabilities.has('batteryVoltage') && (
            <Stat label="Voltage" value={attrs.batteryVoltage ?? '--'} />
          )}
        </div>
      </Card>

      <TargetControls device={device} state={deviceState} unit={unit} onRun={run} />

      {hasDeviceSettings && (
        <Card title="Mug">
          <div className="grid">
            {deviceState.capabilities.has('name') && (
              <NameControl device={device} state={deviceState} onRun={run} />
            )}
            {deviceState.capabilities.has('ledColour') && (
              <LedControl device={device} state={deviceState} onRun={run} />
            )}
            {deviceState.capabilities.has('volumeLevel') && (
              <VolumeControl device={device} state={deviceState} onRun={run} />
            )}
            {deviceState.capabilities.has('temperatureUnit') && (
              <UnitControl device={device} state={deviceState} onRun={run} />
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

/**
 * Link status as a floating toast, shown only once a drop has lasted long enough to
 * matter. Controls stay usable meanwhile: changes are queued and sent on reconnect.
 */
function ConnectionToast({
  state,
  device,
}: {
  state: EmberDeviceState;
  device: EmberDevice;
}): JSX.Element | null {
  const connection = state.connection;
  const down = connection.status !== 'connected';
  const visible = useHeld(down, 1_500);
  const [attempt, setAttempt] = useState(0);
  // The first link of a session is "connecting", not "reconnecting".
  const [everConnected, setEverConnected] = useState(connection.status === 'connected');

  useEffect(() => {
    if (connection.status === 'reconnecting') setAttempt(connection.attempt);
    if (connection.status === 'connected') {
      setAttempt(0);
      setEverConnected(true);
    }
  }, [connection]);

  if (!visible) return null;

  if (!everConnected && connection.status !== 'reconnecting' && connection.status !== 'disconnected') {
    return <Toast title="Connecting…" />;
  }

  const retry = (
    <button type="button" onClick={() => void device.reconnectNow()}>
      Retry
    </button>
  );

  if (connection.status === 'disconnected') {
    return (
      <Toast tone="warn" title="Disconnected" action={retry}>
        Showing last readings.
      </Toast>
    );
  }

  const pending = state.pending.size > 0;
  return (
    <Toast tone="warn" title="Reconnecting…" action={retry}>
      {pending ? 'Your changes will be applied once the mug is back.' : 'Showing last readings.'}
      {attempt >= CONNECT_FAILURES_BEFORE_HINT && ' Close the Ember app if it is open.'}
    </Toast>
  );
}

function ModelLine({ state }: { state: EmberDeviceState }): JSX.Element {
  const controller = useController();
  const detection = state.detection;
  const spec = detection?.model ? ALL_MODELS.find((m) => m.model === detection.model) : null;
  const serial = state.attrs.meta?.serialNumber;

  return (
    <span className="row small">
      <span>{spec?.displayName ?? 'Ember'}</span>
      {detection && detection.confidence !== 'exact' && (
        <select
          value={detection.model ?? ''}
          onChange={(event) => {
            const value = event.target.value;
            controller
              .getSnapshot()
              .device?.setModelOverride(value ? (value as DeviceModel) : null);
          }}
          aria-label="Set the exact model"
        >
          <option value="">Select model</option>
          {ALL_MODELS.map((model) => (
            <option key={model.model} value={model.model}>
              {model.displayName}
            </option>
          ))}
        </select>
      )}
      {serial && <span className="subtle">{serial}</span>}
      {state.attrs.firmware && <span className="subtle">v{state.attrs.firmware.version}</span>}
    </span>
  );
}

type Runner = (action: () => Promise<unknown>) => () => void;

function TargetControls({
  device,
  state,
  unit,
  onRun,
}: {
  device: EmberDevice;
  state: EmberDeviceState;
  unit: 'C' | 'F';
  onRun: Runner;
}): JSX.Element {
  const target = state.attrs.targetTemp ?? 0;
  const controlOn = target > 0;
  const [draft, setDraft] = useState<number>(controlOn ? target : 57);
  const writable = state.writability !== 'no';

  useEffect(() => {
    if (controlOn) setDraft(target);
  }, [target, controlOn]);

  const display = (celsius: number): string =>
    unit === 'F' ? `${Math.round(celsiusToFahrenheit(celsius))}°F` : `${celsius.toFixed(1)}°C`;

  const commit = (): void => {
    if (controlOn && Math.abs(draft - target) < 0.005) return;
    onRun(() => device.setTargetTemp(draft))();
  };

  return (
    <Card
      title="Heating"
      actions={
        <>
          <span
            className={`sync-dot${state.pending.has('targetTemp') ? ' on' : ''}`}
            title="Saving to the mug"
            aria-hidden="true"
          />
          <Switch
            label="Temperature control"
            checked={controlOn}
            disabled={!writable}
            onChange={(next) => onRun(() => device.setTemperatureControl(next))()}
          />
        </>
      }
    >
      <div className="stack tight">
        <span className="target-value">{display(draft)}</span>
        <input
          type="range"
          min={MIN_TEMP_C}
          max={MAX_TEMP_C}
          step={0.1}
          value={draft}
          disabled={!writable}
          aria-label="Target temperature"
          style={{ '--fill': `${((draft - MIN_TEMP_C) / (MAX_TEMP_C - MIN_TEMP_C)) * 100}%` } as CSSProperties}
          onChange={(event) => setDraft(Number(event.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
        />
        <div className="range-ends" aria-hidden="true">
          <span>{display(MIN_TEMP_C)}</span>
          <span>{display(MAX_TEMP_C)}</span>
        </div>
      </div>

      <div className="chips">
        {DEFAULT_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={`chip${controlOn && Math.abs(target - preset.celsius) < 0.05 ? ' active' : ''}`}
            disabled={!writable}
            onClick={onRun(() => device.setTargetTemp(preset.celsius))}
          >
            {preset.label}
            <span className="subtle">{display(preset.celsius)}</span>
          </button>
        ))}
      </div>
    </Card>
  );
}

function NameControl({
  device,
  state,
  onRun,
}: {
  device: EmberDevice;
  state: EmberDeviceState;
  onRun: Runner;
}): JSX.Element {
  const [draft, setDraft] = useState(state.attrs.name ?? '');
  const current = state.attrs.name ?? '';

  useEffect(() => setDraft(current), [current]);
  const valid = MUG_NAME_PATTERN.test(draft);

  return (
    <Field
      label="Name"
      error={draft.length > 0 && !valid ? 'Unsupported character.' : undefined}
    >
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input
          style={{ flex: 1 }}
          value={draft}
          maxLength={16}
          onChange={(event) => setDraft(event.target.value)}
          disabled={state.writability === 'no'}
        />
        <button
          type="button"
          disabled={!valid || draft === current || state.writability === 'no'}
          onClick={onRun(() => device.setName(draft))}
        >
          Save
        </button>
      </div>
    </Field>
  );
}

function LedControl({
  device,
  state,
  onRun,
}: {
  device: EmberDevice;
  state: EmberDeviceState;
  onRun: Runner;
}): JSX.Element {
  const colour = state.attrs.ledColour;
  const hex = colour ? colourToHex(colour) : '#ffffff';
  const [draft, setDraft] = useState(hex);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setDraft(hex), [hex]);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <Field label="LED colour">
      <div className="row">
        <input
          type="color"
          value={draft}
          disabled={state.writability === 'no'}
          onChange={(event) => {
            const next = event.target.value;
            setDraft(next);
            if (timer.current !== null) clearTimeout(timer.current);
            timer.current = setTimeout(() => {
              onRun(() => device.setLedColour(hexToColour(next, colour?.brightness ?? 255)))();
            }, 280);
          }}
        />
        <code className="muted">{draft.toUpperCase()}</code>
      </div>
    </Field>
  );
}

function VolumeControl({
  device,
  state,
  onRun,
}: {
  device: EmberDevice;
  state: EmberDeviceState;
  onRun: Runner;
}): JSX.Element {
  return (
    <Field label="Button volume">
      <div className="segmented">
        {[VolumeLevel.LOW, VolumeLevel.MEDIUM, VolumeLevel.HIGH].map((level) => (
          <button
            key={level}
            type="button"
            className={state.attrs.volumeLevel === level ? 'active' : ''}
            disabled={state.writability === 'no'}
            onClick={onRun(() => device.setVolumeLevel(level))}
          >
            {VOLUME_LEVEL_LABEL[level]}
          </button>
        ))}
      </div>
    </Field>
  );
}

function UnitControl({
  device,
  state,
  onRun,
}: {
  device: EmberDevice;
  state: EmberDeviceState;
  onRun: Runner;
}): JSX.Element {
  return (
    <Field label="Unit on mug" hint="Used by the Ember app, not this page.">
      <div className="segmented">
        {([TemperatureUnit.CELSIUS, TemperatureUnit.FAHRENHEIT] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={state.attrs.temperatureUnit === value ? 'active' : ''}
            disabled={state.writability === 'no'}
            onClick={onRun(() => device.setTemperatureUnit(value))}
          >
            °{value}
          </button>
        ))}
      </div>
    </Field>
  );
}

/**
 * Overwrites the device's pairing key to force it to accept writes.
 *
 * Kept behind an explicit confirmation because that key is what the official Ember app
 * uses, so this very likely unpairs the phone.
 */
function ForceWritableButton({ device }: { device: EmberDevice }): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!confirming) {
    return (
      <button type="button" className="ghost" onClick={() => setConfirming(true)}>
        Force
      </button>
    );
  }

  return (
    <div className="row">
      <span className="small">Overwrites the pairing key; the Ember app will need to re-add the mug.</span>
      <button
        type="button"
        className="danger"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void device.forceWritable().finally(() => {
            setBusy(false);
            setConfirming(false);
          });
        }}
      >
        {busy ? 'Working…' : 'Overwrite'}
      </button>
      <button type="button" className="ghost" onClick={() => setConfirming(false)}>
        Cancel
      </button>
    </div>
  );
}
