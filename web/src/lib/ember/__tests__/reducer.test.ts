import { describe, expect, it } from 'vitest';

import { DeviceModel, LiquidState } from '../constants.js';
import { emberReducer, initialState } from '../reducer.js';
import type { Attribute, ModelDetection } from '../types.js';

const detection: ModelDetection = {
  model: DeviceModel.MUG_2_10_OZ,
  deviceType: 'mug',
  colour: null,
  source: 'gatt-probe',
  confidence: 'exact',
  ambiguous: [],
};

const caps = (...attrs: Attribute[]): ReadonlySet<Attribute> => new Set(attrs);

describe('emberReducer identity', () => {
  /**
   * The snapshot feeds `useSyncExternalStore`, which compares by reference. A transition
   * that changes nothing must return the same object or React re-renders forever.
   */
  it('returns the identical object when nothing changed', () => {
    let state = initialState();
    state = emberReducer(state, { type: 'attrs', attrs: { currentTemp: 23.5 }, at: 1000 });

    expect(emberReducer(state, { type: 'attrs', attrs: { currentTemp: 23.5 }, at: 1000 })).toBe(
      state,
    );
    expect(emberReducer(state, { type: 'connection', connection: state.connection })).toBe(state);
    expect(emberReducer(state, { type: 'writability', value: 'unknown' })).toBe(state);
    expect(emberReducer(state, { type: 'failure', failure: null })).toBe(state);
    expect(emberReducer(state, { type: 'unknown-chars', uuids: [] })).toBe(state);
    expect(emberReducer(state, { type: 'device-info', bleId: null, bleName: null })).toBe(state);
  });

  it('compares nested attribute values structurally', () => {
    let state = initialState();
    state = emberReducer(state, {
      type: 'attrs',
      attrs: { battery: { percent: 80, onChargingBase: false } },
      at: 1000,
    });

    const unchanged = emberReducer(state, {
      type: 'attrs',
      attrs: { battery: { percent: 80, onChargingBase: false } },
      at: 1000,
    });
    expect(unchanged).toBe(state);

    const changed = emberReducer(state, {
      type: 'attrs',
      attrs: { battery: { percent: 80, onChargingBase: true } },
      at: 1001,
    });
    expect(changed).not.toBe(state);
    expect(changed.attrs.battery?.onChargingBase).toBe(true);
  });

  it('advances lastUpdate only forwards', () => {
    let state = initialState();
    state = emberReducer(state, { type: 'attrs', attrs: { currentTemp: 50 }, at: 2000 });
    expect(state.lastUpdate).toBe(2000);

    const older = emberReducer(state, { type: 'attrs', attrs: { currentTemp: 50 }, at: 1000 });
    expect(older).toBe(state);
  });

  it('keeps capability sets stable when equal', () => {
    let state = initialState();
    state = emberReducer(state, { type: 'identified', detection, capabilities: caps('name') });
    const same = emberReducer(state, {
      type: 'identified',
      detection: { ...detection },
      capabilities: caps('name'),
    });
    expect(same).toBe(state);
  });
});

describe('emberReducer writes', () => {
  it('marks an attribute pending and clears it on settle', () => {
    let state = initialState();
    state = emberReducer(state, { type: 'optimistic', attr: 'targetTemp', value: 57 });
    expect(state.pending.has('targetTemp')).toBe(true);
    expect(state.attrs.targetTemp).toBe(57);

    state = emberReducer(state, { type: 'settle', attr: 'targetTemp', value: 57, at: 10 });
    expect(state.pending.has('targetTemp')).toBe(false);
    expect(state.attrs.targetTemp).toBe(57);
  });

  it('restores the previous value on revert', () => {
    let state = initialState();
    state = emberReducer(state, { type: 'attrs', attrs: { targetTemp: 55 }, at: 1 });
    state = emberReducer(state, { type: 'optimistic', attr: 'targetTemp', value: 60 });
    state = emberReducer(state, { type: 'revert', attr: 'targetTemp', value: 55 });

    expect(state.attrs.targetTemp).toBe(55);
    expect(state.pending.size).toBe(0);
  });

  it('drops the key entirely when reverting to an unset value', () => {
    let state = initialState();
    state = emberReducer(state, { type: 'optimistic', attr: 'name', value: 'Nope' });
    state = emberReducer(state, { type: 'revert', attr: 'name', value: undefined });
    expect('name' in state.attrs).toBe(false);
  });

  it('treats missing auth info as definitively not writable', () => {
    let state = initialState();
    state = emberReducer(state, { type: 'auth-info-missing' });
    expect(state.authInfoMissing).toBe(true);
    expect(state.writability).toBe('no');
    expect(emberReducer(state, { type: 'auth-info-missing' })).toBe(state);
  });
});

describe('emberReducer connection', () => {
  it('keeps the last known attributes when disconnecting', () => {
    let state = initialState();
    state = emberReducer(state, {
      type: 'attrs',
      attrs: { currentTemp: 57, liquidState: LiquidState.PERFECT },
      at: 1,
    });
    state = emberReducer(state, { type: 'optimistic', attr: 'targetTemp', value: 58 });
    state = emberReducer(state, {
      type: 'connection',
      connection: { status: 'disconnected', failure: null },
    });

    expect(state.attrs.currentTemp).toBe(57);
    expect(state.attrs.liquidState).toBe(LiquidState.PERFECT);
    // Pending writes cannot survive the link going away.
    expect(state.pending.size).toBe(0);
  });
});
