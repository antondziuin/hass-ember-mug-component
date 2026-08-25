import { describe, expect, it, vi } from 'vitest';

import { EmberError } from '../errors.js';
import { GattQueue } from '../gattQueue.js';

/** Deferred promise, so a test can decide exactly when an operation settles. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function named(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** No-op sleep, so retry backoff does not need real or fake timers. */
const instantSleep = (): Promise<void> => Promise.resolve();

/**
 * Captures a rejection at call time. Necessary whenever the rejection happens during
 * `advanceTimersByTimeAsync`, because attaching the handler afterwards is reported as an
 * unhandled rejection.
 */
function settled<T>(promise: Promise<T>): Promise<T | Error> {
  return promise.catch((error: Error) => error);
}

describe('GattQueue', () => {
  it('runs operations one at a time, in order', async () => {
    const queue = new GattQueue({ sleep: instantSleep });
    const order: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;

    const op = (label: string) => async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await Promise.resolve();
      order.push(label);
      concurrent -= 1;
      return label;
    };

    const results = await Promise.all([
      queue.run('a', op('a')),
      queue.run('b', op('b')),
      queue.run('c', op('c')),
    ]);

    expect(results).toEqual(['a', 'b', 'c']);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(maxConcurrent).toBe(1);
  });

  it('runs a higher priority task first but keeps FIFO within a priority', async () => {
    const queue = new GattQueue({ sleep: instantSleep });
    const order: string[] = [];
    const blocker = deferred<void>();

    // Occupy the queue so the rest genuinely queue up behind it.
    const running = queue.run('blocker', () => blocker.promise);

    const low1 = queue.run('low1', async () => void order.push('low1'));
    const high = queue.run('high', async () => void order.push('high'), { priority: 10 });
    const low2 = queue.run('low2', async () => void order.push('low2'));

    blocker.resolve();
    await Promise.all([running, low1, high, low2]);

    expect(order).toEqual(['high', 'low1', 'low2']);
  });

  it('retries a transient failure and then succeeds', async () => {
    const queue = new GattQueue({ sleep: instantSleep });
    let attempts = 0;

    const result = await queue.run('flaky', async () => {
      attempts += 1;
      if (attempts < 3) throw named('NetworkError', 'GATT operation already in progress.');
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('gives up on a transient failure once retries are exhausted', async () => {
    const queue = new GattQueue({ sleep: instantSleep });
    let attempts = 0;

    await expect(
      queue.run(
        'flaky',
        async () => {
          attempts += 1;
          throw named('NetworkError', 'GATT operation already in progress.');
        },
        { retries: 1 },
      ),
    ).rejects.toBeInstanceOf(EmberError);

    expect(attempts).toBe(2);
  });

  it('does not retry a non-transient failure', async () => {
    const queue = new GattQueue({ sleep: instantSleep });
    let attempts = 0;

    await expect(
      queue.run('hard', async () => {
        attempts += 1;
        throw named('NotSupportedError', 'GATT operation not permitted.');
      }),
    ).rejects.toBeInstanceOf(EmberError);

    expect(attempts).toBe(1);
  });

  it('waits for a timed-out operation to settle before starting the next one', async () => {
    vi.useFakeTimers();
    try {
      const queue = new GattQueue({ sleep: instantSleep });
      const stalled = deferred<string>();
      let secondStarted = false;

      // Attach the rejection handler immediately: the timeout fires while the timers are
      // being advanced, so a later `await` would be reported as an unhandled rejection.
      const first = settled(
        queue.run('stalled', () => stalled.promise, { timeoutMs: 1000, retries: 0 }),
      );
      const second = queue.run('second', async () => {
        secondStarted = true;
        return 'second';
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(await first).toMatchObject({ failure: { kind: 'timeout' } });

      // The orphaned operation still owns the radio, so nothing else may start.
      await vi.advanceTimersByTimeAsync(500);
      expect(secondStarted).toBe(false);

      stalled.resolve('late');
      await vi.advanceTimersByTimeAsync(0);
      await expect(second).resolves.toBe('second');
      expect(secondStarted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a fatal failure when an orphaned operation never settles', async () => {
    vi.useFakeTimers();
    try {
      const onFatal = vi.fn();
      const queue = new GattQueue({ sleep: instantSleep, onFatal, hardTimeoutFactor: 2 });

      const first = settled(
        queue.run('wedged', () => new Promise<never>(() => undefined), {
          timeoutMs: 1000,
          retries: 0,
        }),
      );
      void settled(queue.run('never-runs', async () => 'nope'));

      await vi.advanceTimersByTimeAsync(1000);
      expect(await first).toMatchObject({ failure: { kind: 'timeout' } });

      // Hard timeout is DEFAULT_OP_TIMEOUT_MS (10s) * factor 2.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(onFatal).toHaveBeenCalledTimes(1);
      expect(onFatal.mock.calls[0]?.[0]).toMatchObject({ kind: 'gatt', transient: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects everything pending when closed, and refuses new work until reopened', async () => {
    const queue = new GattQueue({ sleep: instantSleep });
    const blocker = deferred<void>();
    const running = queue.run('blocker', () => blocker.promise);
    const queued = queue.run('queued', async () => 'never');

    queue.close({ kind: 'disconnected', unexpected: true });

    await expect(queued).rejects.toMatchObject({ failure: { kind: 'disconnected' } });
    await expect(queue.run('after-close', async () => 'no')).rejects.toMatchObject({
      failure: { kind: 'disconnected' },
    });
    expect(queue.isClosed).toBe(true);

    blocker.resolve();
    await running;

    queue.reopen();
    expect(queue.isClosed).toBe(false);
    await expect(queue.run('after-reopen', async () => 'yes')).resolves.toBe('yes');
  });

  it('closes itself when an operation reports a disconnect', async () => {
    const queue = new GattQueue({ sleep: instantSleep });

    await expect(
      queue.run('read', async () => {
        throw named('NetworkError', 'GATT Server is disconnected.');
      }),
    ).rejects.toMatchObject({ failure: { kind: 'disconnected' } });

    expect(queue.isClosed).toBe(true);
  });
});
