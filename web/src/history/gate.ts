/**
 * Decides which device readings are worth keeping.
 *
 * Pure, synchronous and free of I/O: it sits between the device layer and whichever store
 * is active, so all three backends share exactly one recording policy and none of them
 * ever sees a rejected sample.
 *
 * Roughly 5,600 readings a day become about 600 rows without losing anything a chart
 * would show.
 */

import { MAX_GAP_MS } from './constants.js';
import {
  SampleFlag,
  type DeviceEvent,
  type DeviceId,
  type EventType,
  type LiquidStateCode,
  type Millis,
  type Sample,
  type SessionId,
} from './types.js';

/** What the device layer hands over, in human units. */
export interface DeviceSnapshot {
  /** Degrees Celsius. */
  currentTempC: number | null;
  /** Degrees Celsius; 0 or null means temperature control is off. */
  targetTempC: number | null;
  batteryPercent: number | null;
  onChargingBase: boolean;
  batteryVoltage: number | null;
  /** Already normalised to a percentage of the model's full scale. */
  liquidPercent: number | null;
  liquidState: LiquidStateCode | null;
  deviceUnitIsFahrenheit: boolean;
  ledHex: string | null;
  volumeLevel: number | null;
  name: string | null;
  firmwareVersion: number | null;
}

export interface SampleGateConfig {
  minIntervalMs: number;
  heartbeatMs: number;
  idleHeartbeatMs: number;
  /** Hundredths of a degree. */
  tempDeltaCentiC: number;
  /** Tenths of a percent. */
  batteryDeltaDpc: number;
  liquidDeltaDpc: number;
  voltageDeltaMv: number;
  edgeHold: boolean;
  maxGapMs: number;
}

export const DEFAULT_GATE: SampleGateConfig = {
  minIntervalMs: 5_000,
  heartbeatMs: 300_000,
  idleHeartbeatMs: 900_000,
  // Device resolution is 0.01 C and observed noise is around +/-0.1 C, so 0.20 C is about
  // two sigma: it removes the noise floor without clipping real thermal behaviour.
  tempDeltaCentiC: 20,
  batteryDeltaDpc: 5,
  // One raw step on a 30-step mug, so it is lossless there and lightly filtered on a
  // Travel Mug's 100-step scale.
  liquidDeltaDpc: 30,
  voltageDeltaMv: 20,
  edgeHold: true,
  maxGapMs: MAX_GAP_MS,
};

export const GATE_PRESETS: Readonly<Record<string, SampleGateConfig>> = {
  detailed: { ...DEFAULT_GATE, tempDeltaCentiC: 10, batteryDeltaDpc: 2, heartbeatMs: 120_000 },
  balanced: DEFAULT_GATE,
  minimal: {
    ...DEFAULT_GATE,
    tempDeltaCentiC: 50,
    batteryDeltaDpc: 10,
    heartbeatMs: 900_000,
    idleHeartbeatMs: 1_800_000,
  },
};

export interface GateOutput {
  samples: Sample[];
  events: DeviceEvent[];
}

const EMPTY: GateOutput = { samples: [], events: [] };

function toCenti(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100);
}

function toDpc(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10);
}

interface Held {
  sample: Sample;
  snapshot: DeviceSnapshot;
}

export class SampleGate {
  readonly #config: SampleGateConfig;
  #deviceId: DeviceId;
  #sessionId: SessionId | null = null;

  #lastEmitted: Sample | null = null;
  #lastSnapshot: DeviceSnapshot | null = null;
  /** Most recent suppressed reading, replayed ahead of a discrete transition. */
  #held: Held | null = null;
  #isFirstOfSession = true;
  #eventSeq = 0;

  constructor(deviceId: DeviceId, config: SampleGateConfig = DEFAULT_GATE) {
    this.#deviceId = deviceId;
    this.#config = config;
  }

  get deviceId(): DeviceId {
    return this.#deviceId;
  }

  /** Starts a new connection session; the next reading is always recorded. */
  reset(sessionId: SessionId, deviceId?: DeviceId): void {
    this.#sessionId = sessionId;
    if (deviceId) this.#deviceId = deviceId;
    this.#lastEmitted = null;
    this.#lastSnapshot = null;
    this.#held = null;
    this.#isFirstOfSession = true;
  }

  #event(
    type: EventType,
    ts: Millis,
    numA: number | null,
    numB: number | null,
    textA: string | null = null,
  ): DeviceEvent {
    this.#eventSeq += 1;
    return {
      eventId: crypto.randomUUID(),
      deviceId: this.#deviceId,
      ts,
      type,
      sessionId: this.#sessionId,
      numA,
      numB,
      textA,
      data: null,
    };
  }

  #build(snapshot: DeviceSnapshot, ts: Millis, flags: number): Sample {
    const controlOn = snapshot.targetTempC !== null && snapshot.targetTempC > 0;
    let allFlags = flags;
    if (snapshot.onChargingBase) allFlags |= SampleFlag.OnChargingBase;
    if (controlOn) allFlags |= SampleFlag.TempControlOn;
    if (snapshot.deviceUnitIsFahrenheit) allFlags |= SampleFlag.DeviceUnitF;

    return {
      deviceId: this.#deviceId,
      ts,
      sessionId: this.#sessionId,
      tempC: toCenti(snapshot.currentTempC),
      // Null rather than the device's 0 sentinel, so bucket averages stay honest.
      targetC: controlOn ? toCenti(snapshot.targetTempC) : null,
      batteryDpc: toDpc(snapshot.batteryPercent),
      liquidDpc: toDpc(snapshot.liquidPercent),
      liquidState: snapshot.liquidState,
      batteryMv: snapshot.batteryVoltage,
      flags: allFlags,
    };
  }

  /** Discrete changes that always produce a row, plus the events they generate. */
  #discreteEvents(previous: DeviceSnapshot, next: DeviceSnapshot, ts: Millis): DeviceEvent[] {
    const events: DeviceEvent[] = [];

    if (previous.liquidState !== next.liquidState) {
      events.push(this.#event('state_change', ts, previous.liquidState, next.liquidState));
    }
    if (previous.onChargingBase !== next.onChargingBase) {
      events.push(this.#event(next.onChargingBase ? 'charger_on' : 'charger_off', ts, null, null));
    }

    const previousOn = previous.targetTempC !== null && previous.targetTempC > 0;
    const nextOn = next.targetTempC !== null && next.targetTempC > 0;
    if (previousOn !== nextOn) {
      events.push(
        this.#event(nextOn ? 'temp_control_on' : 'temp_control_off', ts, null, next.targetTempC),
      );
    } else if (nextOn && previous.targetTempC !== next.targetTempC) {
      events.push(this.#event('target_change', ts, previous.targetTempC, next.targetTempC));
    }

    if (previous.deviceUnitIsFahrenheit !== next.deviceUnitIsFahrenheit) {
      events.push(
        this.#event('unit_change', ts, null, null, next.deviceUnitIsFahrenheit ? 'F' : 'C'),
      );
    }
    if (previous.ledHex !== next.ledHex && next.ledHex !== null) {
      events.push(this.#event('led_change', ts, null, null, next.ledHex));
    }
    if (previous.name !== next.name && next.name !== null) {
      events.push(this.#event('name_change', ts, null, null, next.name));
    }
    if (previous.firmwareVersion !== next.firmwareVersion && next.firmwareVersion !== null) {
      events.push(
        this.#event('firmware_change', ts, previous.firmwareVersion, next.firmwareVersion),
      );
    }

    const wasEmpty = (previous.liquidPercent ?? 0) < 15;
    const nowFull = (next.liquidPercent ?? 0) > 40;
    if (wasEmpty && nowFull) {
      events.push(this.#event('liquid_filled', ts, previous.liquidPercent, next.liquidPercent));
    }
    const wasFull = (previous.liquidPercent ?? 0) > 20;
    const nowEmpty = (next.liquidPercent ?? 0) < 10;
    if (wasFull && nowEmpty) {
      events.push(this.#event('liquid_emptied', ts, previous.liquidPercent, next.liquidPercent));
    }

    return events;
  }

  #exceedsThreshold(previous: Sample, next: Sample): boolean {
    const c = this.#config;
    if (
      previous.tempC !== null &&
      next.tempC !== null &&
      Math.abs(next.tempC - previous.tempC) >= c.tempDeltaCentiC
    ) {
      return true;
    }
    if (
      previous.batteryDpc !== null &&
      next.batteryDpc !== null &&
      Math.abs(next.batteryDpc - previous.batteryDpc) >= c.batteryDeltaDpc
    ) {
      return true;
    }
    if (
      previous.liquidDpc !== null &&
      next.liquidDpc !== null &&
      Math.abs(next.liquidDpc - previous.liquidDpc) >= c.liquidDeltaDpc
    ) {
      return true;
    }
    if (
      previous.batteryMv !== null &&
      next.batteryMv !== null &&
      Math.abs(next.batteryMv - previous.batteryMv) >= c.voltageDeltaMv
    ) {
      return true;
    }
    // A value appearing for the first time is worth a row.
    return (
      (previous.tempC === null && next.tempC !== null) ||
      (previous.batteryDpc === null && next.batteryDpc !== null) ||
      (previous.liquidDpc === null && next.liquidDpc !== null)
    );
  }

  push(snapshot: DeviceSnapshot, nowMs: Millis): GateOutput {
    const candidate = this.#build(snapshot, nowMs, 0);

    if (this.#isFirstOfSession || this.#lastEmitted === null || this.#lastSnapshot === null) {
      this.#isFirstOfSession = false;
      this.#lastEmitted = { ...candidate, flags: candidate.flags | SampleFlag.SessionBoundary };
      this.#lastSnapshot = snapshot;
      this.#held = null;
      return { samples: [this.#lastEmitted], events: [] };
    }

    const previous = this.#lastEmitted;
    const previousSnapshot = this.#lastSnapshot;
    const sinceLast = nowMs - previous.ts;

    // 1 - rate limit. Guards against notification storms, which re-read on every push.
    if (sinceLast < this.#config.minIntervalMs) {
      this.#held = { sample: candidate, snapshot };
      return EMPTY;
    }

    // 2 - discrete changes always record, and carry an event.
    const events = this.#discreteEvents(previousSnapshot, snapshot, nowMs);
    if (events.length > 0) {
      const samples: Sample[] = [];
      // Edge hold: replay the suppressed reading so the transition renders as a step
      // rather than a diagonal ramp across the quiet period.
      const held = this.#held;
      if (
        this.#config.edgeHold &&
        held &&
        held.sample.ts > previous.ts &&
        nowMs - held.sample.ts >= this.#config.minIntervalMs
      ) {
        samples.push({ ...held.sample, flags: held.sample.flags | SampleFlag.EdgeHold });
      }
      samples.push(candidate);
      this.#commit(candidate, snapshot);
      return { samples, events };
    }

    // 3 - threshold triggers.
    if (this.#exceedsThreshold(previous, candidate)) {
      this.#commit(candidate, snapshot);
      return { samples: [candidate], events: [] };
    }

    // 4 - heartbeat, so a flat line still has points on it.
    const quiet = snapshot.liquidState === 0 || snapshot.liquidState === 1;
    const heartbeat =
      quiet && snapshot.onChargingBase ? this.#config.idleHeartbeatMs : this.#config.heartbeatMs;
    if (sinceLast >= heartbeat) {
      const beat = { ...candidate, flags: candidate.flags | SampleFlag.Heartbeat };
      this.#commit(beat, snapshot);
      return { samples: [beat], events: [] };
    }

    this.#held = { sample: candidate, snapshot };
    return EMPTY;
  }

  #commit(sample: Sample, snapshot: DeviceSnapshot): void {
    this.#lastEmitted = sample;
    this.#lastSnapshot = snapshot;
    this.#held = null;
  }

  /**
   * Emits the held reading so a series ends on a real observation rather than trailing
   * off mid-dead-band. Call on session end and when the page is hidden.
   */
  flush(nowMs: Millis, reason: 'session_end' | 'visibility'): GateOutput {
    const held = this.#held;
    this.#held = null;
    if (!held) {
      if (reason !== 'session_end' || !this.#lastEmitted || !this.#lastSnapshot) return EMPTY;
      // Nothing was suppressed, so re-stamp the last known reading as the boundary.
      const boundary = this.#build(
        this.#lastSnapshot,
        Math.max(nowMs, this.#lastEmitted.ts + 1),
        SampleFlag.SessionBoundary,
      );
      this.#lastEmitted = boundary;
      return { samples: [boundary], events: [] };
    }

    const sample: Sample = {
      ...held.sample,
      ts: Math.max(held.sample.ts, (this.#lastEmitted?.ts ?? 0) + 1),
      flags: held.sample.flags | SampleFlag.SessionBoundary,
    };
    this.#commit(sample, held.snapshot);
    return { samples: [sample], events: [] };
  }
}
