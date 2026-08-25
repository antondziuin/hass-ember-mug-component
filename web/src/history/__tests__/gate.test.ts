import { describe, expect, it } from 'vitest';

import { DEFAULT_GATE, SampleGate, type DeviceSnapshot } from '../gate.js';
import { SampleFlag, type LiquidStateCode } from '../types.js';

const DEVICE = 'sn:TESTDEVICE';
const SESSION = 'session-1';

function snapshot(patch: Partial<DeviceSnapshot> = {}): DeviceSnapshot {
  return {
    currentTempC: 23.5,
    targetTempC: 57,
    batteryPercent: 80,
    onChargingBase: false,
    batteryVoltage: null,
    liquidPercent: 0,
    liquidState: 1,
    deviceUnitIsFahrenheit: false,
    ledHex: '#ffffff',
    volumeLevel: null,
    name: 'Ember',
    firmwareVersion: 355,
    ...patch,
  };
}

function newGate(): SampleGate {
  const gate = new SampleGate(DEVICE, DEFAULT_GATE);
  gate.reset(SESSION);
  return gate;
}

describe('SampleGate', () => {
  it('always records the first reading of a session', () => {
    const gate = newGate();
    const out = gate.push(snapshot(), 1000);
    expect(out.samples).toHaveLength(1);
    expect(out.samples[0]!.flags & SampleFlag.SessionBoundary).toBeTruthy();
    expect(out.samples[0]!.tempC).toBe(2350);
  });

  it('never records two readings closer together than the minimum interval', () => {
    const gate = newGate();
    gate.push(snapshot(), 1000);
    // A large jump, but too soon: notification storms must not become rows.
    expect(gate.push(snapshot({ currentTempC: 60 }), 3000).samples).toHaveLength(0);
    expect(gate.push(snapshot({ currentTempC: 60 }), 6001).samples).toHaveLength(1);
  });

  it('suppresses drift below the temperature dead-band', () => {
    const gate = newGate();
    gate.push(snapshot({ currentTempC: 50 }), 0);
    expect(gate.push(snapshot({ currentTempC: 50.1 }), 10_000).samples).toHaveLength(0);
    expect(gate.push(snapshot({ currentTempC: 50.19 }), 20_000).samples).toHaveLength(0);
    expect(gate.push(snapshot({ currentTempC: 50.2 }), 30_000).samples).toHaveLength(1);
  });

  it('records battery and liquid movement past their own thresholds', () => {
    const gate = newGate();
    gate.push(snapshot({ batteryPercent: 80, liquidPercent: 50 }), 0);

    expect(
      gate.push(snapshot({ batteryPercent: 80.4, liquidPercent: 50 }), 10_000).samples,
    ).toHaveLength(0);
    expect(
      gate.push(snapshot({ batteryPercent: 80.5, liquidPercent: 50 }), 20_000).samples,
    ).toHaveLength(1);
    expect(
      gate.push(snapshot({ batteryPercent: 80.5, liquidPercent: 53 }), 30_000).samples,
    ).toHaveLength(1);
  });

  it('records a heartbeat so a flat line still has points on it', () => {
    const gate = newGate();
    gate.push(snapshot(), 0);
    expect(gate.push(snapshot(), 200_000).samples).toHaveLength(0);

    const beat = gate.push(snapshot(), 300_000);
    expect(beat.samples).toHaveLength(1);
    expect(beat.samples[0]!.flags & SampleFlag.Heartbeat).toBeTruthy();
  });

  it('uses the slower idle heartbeat when standing by on the charger', () => {
    const gate = newGate();
    const idle = snapshot({ liquidState: 0, onChargingBase: true });
    gate.push(idle, 0);
    expect(gate.push(idle, 600_000).samples).toHaveLength(0);
    expect(gate.push(idle, 900_000).samples).toHaveLength(1);
  });

  it('always records a liquid-state change, with an event', () => {
    const gate = newGate();
    gate.push(snapshot({ liquidState: 5 }), 0);
    const out = gate.push(snapshot({ liquidState: 6 }), 30_000);

    expect(out.samples.length).toBeGreaterThanOrEqual(1);
    expect(out.events.map((e) => e.type)).toContain('state_change');
    expect(out.events[0]!.numA).toBe(5);
    expect(out.events[0]!.numB).toBe(6);
  });

  it('replays the suppressed reading so a transition renders as a step', () => {
    const gate = newGate();
    gate.push(snapshot({ liquidState: 5, currentTempC: 56.9 }), 0);
    // Suppressed: below the dead-band, but it is the last thing seen before the change.
    expect(gate.push(snapshot({ liquidState: 5, currentTempC: 56.95 }), 240_000).samples).toHaveLength(
      0,
    );

    const out = gate.push(snapshot({ liquidState: 6, currentTempC: 57 }), 250_000);
    expect(out.samples).toHaveLength(2);
    expect(out.samples[0]!.flags & SampleFlag.EdgeHold).toBeTruthy();
    expect(out.samples[0]!.ts).toBe(240_000);
    expect(out.samples[1]!.ts).toBe(250_000);
  });

  it('records charger transitions and target changes', () => {
    const gate = newGate();
    gate.push(snapshot(), 0);

    const charger = gate.push(snapshot({ onChargingBase: true }), 10_000);
    expect(charger.events.map((e) => e.type)).toContain('charger_on');

    const target = gate.push(snapshot({ onChargingBase: true, targetTempC: 59 }), 20_000);
    expect(target.events.map((e) => e.type)).toContain('target_change');
  });

  it('stores temperature control off as null rather than the device zero sentinel', () => {
    const gate = newGate();
    gate.push(snapshot({ targetTempC: 57 }), 0);
    const out = gate.push(snapshot({ targetTempC: 0 }), 10_000);

    expect(out.events.map((e) => e.type)).toContain('temp_control_off');
    const sample = out.samples.at(-1)!;
    // A literal 0 would be swept into AVG() and drag the target line to the floor.
    expect(sample.targetC).toBeNull();
    expect(sample.flags & SampleFlag.TempControlOn).toBe(0);
  });

  it('detects a fill and an empty', () => {
    const gate = newGate();
    gate.push(snapshot({ liquidPercent: 5 }), 0);
    const filled = gate.push(snapshot({ liquidPercent: 95 }), 10_000);
    expect(filled.events.map((e) => e.type)).toContain('liquid_filled');

    const emptied = gate.push(snapshot({ liquidPercent: 2 }), 20_000);
    expect(emptied.events.map((e) => e.type)).toContain('liquid_emptied');
  });

  it('flushes the held reading so a series ends on a real observation', () => {
    const gate = newGate();
    gate.push(snapshot({ currentTempC: 50 }), 0);
    gate.push(snapshot({ currentTempC: 50.05 }), 10_000);

    const out = gate.flush(11_000, 'session_end');
    expect(out.samples).toHaveLength(1);
    expect(out.samples[0]!.flags & SampleFlag.SessionBoundary).toBeTruthy();
    expect(out.samples[0]!.tempC).toBe(5005);
  });

  it('never emits a duplicate timestamp when flushing', () => {
    const gate = newGate();
    gate.push(snapshot(), 1000);
    const out = gate.flush(1000, 'session_end');
    expect(out.samples[0]!.ts).toBeGreaterThan(1000);
  });

  it('reduces a realistic day to roughly a tenth of the readings', () => {
    const gate = newGate();
    let ts = 0;
    let kept = 0;
    let offered = 0;

    const record = (snap: DeviceSnapshot, stepMs: number): void => {
      offered += 1;
      kept += gate.push(snap, ts).samples.length;
      ts += stepMs;
    };

    // Heating from room temperature to target, then holding, then cooling as it is drunk.
    for (let temp = 20; temp < 57; temp += 1.5) {
      record(snapshot({ currentTempC: temp, liquidState: 5, liquidPercent: 95 }), 15_000);
    }
    for (let i = 0; i < 240; i += 1) {
      const wobble = 57 + Math.sin(i / 6) * 0.15;
      record(snapshot({ currentTempC: wobble, liquidState: 6, liquidPercent: 90 }), 15_000);
    }
    // Fourteen hours idle on the charger.
    for (let i = 0; i < 3360; i += 1) {
      record(
        snapshot({ currentTempC: 22, liquidState: 0, liquidPercent: 0, onChargingBase: true }),
        15_000,
      );
    }

    expect(offered).toBeGreaterThan(3600);
    expect(kept).toBeLessThan(offered / 5);
    // Still enough points that the heating ramp is not lost.
    expect(kept).toBeGreaterThan(25);
  });
});

describe('SampleGate liquid state typing', () => {
  it('carries the state code through unchanged', () => {
    const gate = newGate();
    for (let state = 0; state <= 7; state += 1) {
      gate.reset(`s-${state}`);
      const out = gate.push(snapshot({ liquidState: state as LiquidStateCode }), state * 1000);
      expect(out.samples[0]!.liquidState).toBe(state);
    }
  });
});
