/**
 * The live dashboard: current readings plus every control the connected model supports.
 *
 * Controls are gated on `capabilities`, which is the model table intersected with the
 * characteristics this unit actually exposes - so a Cup never shows a name field and a
 * Travel Mug shows volume instead of an LED colour.
 */

import { useEffect, useState } from 'react';

import {
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

import { Banner, Card, Field, Stat } from './components.js';
import { useAppState, useController } from './context.js';

export interface LiveViewProps {
  unit: 'C' | 'F';
  onUnitChange: (unit: 'C' | 'F') => void;
}

export function LiveView({ unit, onUnitChange }: LiveViewProps): JSX.Element {
  const state = useAppState();
  const controller = useController();
  const device = state.device;
  const deviceState = state.deviceState;
  const [error, setError] = useState<string | null>(null);

  if (!device) return <p className="muted">Not connected.</p>;

  const connected = deviceState.connection.status === 'connected';
  const stale = !connected;
  const showTemp = (celsius: number | undefined): string => {
    if (celsius === undefined) return '--';
    const value = unit === 'F' ? celsiusToFahrenheit(celsius) : celsius;
    return `${value.toFixed(1)}°${unit}`;
  };

  const run = (action: () => Promise<unknown>) => () => {
    setError(null);
    action().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <div className="stack">
      <ConnectionBanner state={deviceState} />

      {deviceState.writability === 'no' && (
        <Banner
          tone="warn"
          title="This mug is ignoring changes"
          action={<ForceWritableButton device={device} />}
        >
          The mug accepts the write and then discards it. Ember devices stay read-only until they
          have been set up once in the official Ember app.
        </Banner>
      )}

      {error && (
        <Banner tone="error" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}

      <Card
        title={deviceState.attrs.name || deviceState.bleName || 'Ember mug'}
        subtitle={<ModelLine state={deviceState} />}
        actions={
          <div className="row">
            <div className="segmented" role="group" aria-label="Display unit">
              {(['C', 'F'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={unit === value ? 'active' : ''}
                  onClick={() => onUnitChange(value)}
                >
                  °{value}
                </button>
              ))}
            </div>
            <button type="button" className="ghost" onClick={() => void controller.disconnect()}>
              Disconnect
            </button>
          </div>
        }
      >
        <div className={`readings${stale ? ' stale' : ''}`}>
          <Stat
            label="Current"
            value={showTemp(deviceState.attrs.currentTemp)}
            hint={
              deviceState.attrs.liquidState === undefined || deviceState.attrs.liquidState === null
                ? undefined
                : LIQUID_STATE_LABEL[deviceState.attrs.liquidState]
            }
            tone={deviceState.attrs.liquidState === LiquidState.PERFECT ? 'good' : 'default'}
          />
          <Stat
            label="Target"
            value={
              deviceState.attrs.targetTemp === 0 ? 'Off' : showTemp(deviceState.attrs.targetTemp)
            }
          />
          <Stat
            label="Liquid"
            value={
              deviceState.attrs.liquidLevel === undefined
                ? '--'
                : `${Math.round(
                    liquidLevelPercent(deviceState.attrs.liquidLevel, device.liquidLevelMax),
                  )}%`
            }
            hint={
              deviceState.attrs.liquidLevel === undefined
                ? undefined
                : `raw ${deviceState.attrs.liquidLevel}/${device.liquidLevelMax}`
            }
          />
          <Stat
            label="Battery"
            value={
              deviceState.attrs.battery ? `${deviceState.attrs.battery.percent.toFixed(0)}%` : '--'
            }
            hint={deviceState.attrs.battery?.onChargingBase ? 'On charger' : 'Off charger'}
            tone={
              deviceState.attrs.battery && deviceState.attrs.battery.percent < 15 ? 'warn' : 'default'
            }
          />
          {deviceState.capabilities.has('batteryVoltage') && (
            <Stat label="Voltage" value={deviceState.attrs.batteryVoltage ?? '--'} />
          )}
        </div>
      </Card>

      <Card title="Temperature">
        <TargetControls device={device} state={deviceState} unit={unit} onRun={run} />
      </Card>

      {(deviceState.capabilities.has('name') ||
        deviceState.capabilities.has('ledColour') ||
        deviceState.capabilities.has('volumeLevel') ||
        deviceState.capabilities.has('temperatureUnit')) && (
        <Card title="Device settings">
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

function ConnectionBanner({ state }: { state: EmberDeviceState }): JSX.Element | null {
  const connection = state.connection;
  if (connection.status === 'connected') return null;

  if (connection.status === 'reconnecting') {
    const seconds = Math.max(Math.round((connection.nextRetryAt - Date.now()) / 1000), 0);
    return (
      <Banner tone="warn" title="Reconnecting">
        Attempt {connection.attempt}; next try in {seconds}s.
        {connection.attempt >= 3 && ' If the Ember phone app is connected, close it — the mug only accepts one connection at a time.'}
      </Banner>
    );
  }
  if (connection.status === 'connecting' || connection.status === 'discovering') {
    return <Banner tone="info">Connecting…</Banner>;
  }
  return (
    <Banner tone="warn" title="Disconnected">
      Showing the last readings received.
    </Banner>
  );
}

function ModelLine({ state }: { state: EmberDeviceState }): JSX.Element {
  const controller = useController();
  const detection = state.detection;
  const spec = detection?.model ? ALL_MODELS.find((m) => m.model === detection.model) : null;
  const serial = state.attrs.meta?.serialNumber;

  return (
    <span className="row small">
      <span>{spec?.displayName ?? 'Ember device'}</span>
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
          <option value="">Which model is this?</option>
          {ALL_MODELS.map((model) => (
            <option key={model.model} value={model.model}>
              {model.displayName}
            </option>
          ))}
        </select>
      )}
      {serial && <span className="muted">· {serial}</span>}
      {state.attrs.firmware && <span className="muted">· fw {state.attrs.firmware.version}</span>}
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

  return (
    <div className="stack">
      <div className="row">
        <button
          type="button"
          className={controlOn ? 'primary' : 'ghost'}
          disabled={!writable}
          onClick={onRun(() => device.setTemperatureControl(!controlOn))}
        >
          {controlOn ? 'Temperature control is on' : 'Temperature control is off'}
        </button>
        {state.pending.has('targetTemp') && <span className="muted small">saving…</span>}
      </div>

      <Field
        label={`Target ${display(draft)}`}
        hint={`${MIN_TEMP_C}–${MAX_TEMP_C} °C is the range the mug accepts.`}
      >
        <input
          type="range"
          min={MIN_TEMP_C}
          max={MAX_TEMP_C}
          step={0.1}
          value={draft}
          disabled={!writable}
          onChange={(event) => setDraft(Number(event.target.value))}
          onPointerUp={onRun(() => device.setTargetTemp(draft))}
          onKeyUp={onRun(() => device.setTargetTemp(draft))}
        />
      </Field>

      <div className="chips">
        {DEFAULT_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={`chip${Math.abs(target - preset.celsius) < 0.05 ? ' active' : ''}`}
            disabled={!writable}
            onClick={onRun(() => device.setTargetTemp(preset.celsius))}
          >
            {preset.label}
            <span className="muted small"> {display(preset.celsius)}</span>
          </button>
        ))}
      </div>
    </div>
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
      hint="Up to 16 characters."
      error={draft.length > 0 && !valid ? 'That character is not allowed on the mug.' : undefined}
    >
      <div className="row">
        <input
          value={draft}
          maxLength={16}
          onChange={(event) => setDraft(event.target.value)}
          disabled={state.writability === 'no'}
        />
        <button
          type="button"
          className="ghost"
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

  return (
    <Field label="LED colour" hint="The LED cannot be switched off, only recoloured.">
      <div className="row">
        <input
          type="color"
          value={hex}
          disabled={state.writability === 'no'}
          onChange={(event) =>
            onRun(() =>
              device.setLedColour(hexToColour(event.target.value, colour?.brightness ?? 255)),
            )()
          }
        />
        <code className="muted">{hex}</code>
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
    <Field
      label="Unit shown on the mug"
      hint="This is the mug's own display unit, used by the Ember app. It does not change this page."
    >
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
        Try to force it
      </button>
    );
  }

  return (
    <div className="row">
      <span className="small">
        This overwrites the mug&apos;s pairing key. The Ember phone app will most likely have to
        add the mug again.
      </span>
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
        {busy ? 'Working…' : 'I understand, do it'}
      </button>
      <button type="button" className="ghost" onClick={() => setConfirming(false)}>
        Cancel
      </button>
    </div>
  );
}
