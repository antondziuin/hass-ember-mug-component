import type { Attribute } from './types.js';
import type { CharId } from './uuids.js';
import { CHAR_NAME } from './uuids.js';

export type EmberFailure =
  | { kind: 'unsupported'; reason: 'no-web-bluetooth' | 'insecure-context' | 'no-adapter' }
  /** The user closed the device chooser. Never surface this as an error. */
  | { kind: 'cancelled' }
  | { kind: 'permission-denied' }
  | { kind: 'connect-failed'; attempt: number; cause: unknown }
  | { kind: 'disconnected'; unexpected: boolean }
  | { kind: 'not-writable'; hint: 'setup-in-ember-app' }
  | { kind: 'gatt'; op: string; characteristic?: CharId; cause: unknown; transient: boolean }
  | { kind: 'timeout'; op: string; ms: number }
  | { kind: 'validation'; field: string; message: string }
  | { kind: 'unsupported-attribute'; attribute: Attribute };

export class EmberError extends Error {
  readonly failure: EmberFailure;

  constructor(failure: EmberFailure) {
    super(describeFailure(failure));
    this.name = 'EmberError';
    this.failure = failure;
  }
}

const UNSUPPORTED_MESSAGE = {
  'no-web-bluetooth':
    'This browser does not support Web Bluetooth. Use Chrome, Edge or Opera on desktop, or Chrome on Android.',
  'insecure-context':
    'Web Bluetooth needs a secure context. Open this page over https:// or from http://localhost.',
  'no-adapter': 'No Bluetooth adapter is available. Check that Bluetooth is turned on.',
} as const;

export function describeFailure(f: EmberFailure): string {
  switch (f.kind) {
    case 'unsupported':
      return UNSUPPORTED_MESSAGE[f.reason];
    case 'cancelled':
      return 'Device selection was cancelled.';
    case 'permission-denied':
      return 'The browser refused access to Bluetooth devices.';
    case 'connect-failed':
      return `Could not connect to the device (attempt ${f.attempt}).`;
    case 'disconnected':
      return f.unexpected ? 'The device disconnected unexpectedly.' : 'Disconnected.';
    case 'not-writable':
      return 'This device ignores writes. It has to be set up in the Ember app once before it will accept changes.';
    case 'gatt':
      return `Bluetooth operation "${f.op}" failed${
        f.characteristic ? ` on ${CHAR_NAME[f.characteristic]}` : ''
      }.`;
    case 'timeout':
      return `Bluetooth operation "${f.op}" timed out after ${f.ms} ms.`;
    case 'validation':
      return f.message;
    case 'unsupported-attribute':
      return `This device does not have a "${f.attribute}" attribute.`;
  }
}

/**
 * Chrome messages that indicate a retry has a real chance of succeeding.
 * These are matched on the message because Chrome reuses `NetworkError` for everything.
 */
const TRANSIENT_MESSAGES: readonly string[] = [
  'GATT operation already in progress',
  'GATT operation failed for unknown reason',
  'Connection Error',
  'Authentication failed',
  'Unknown ATT error',
];

export function classify(e: unknown, op: string, characteristic?: CharId): EmberFailure {
  if (e instanceof EmberError) return e.failure;

  const name = (e as DOMException | undefined)?.name;
  const message = String((e as Error | undefined)?.message ?? e ?? '');

  switch (name) {
    case 'NotFoundError':
      // Chrome overloads NotFoundError for "user cancelled the chooser" and for
      // "no matching device". `classifyChooserError` disambiguates at the call site;
      // here we are past the chooser, so treat it as a hard failure.
      return { kind: 'connect-failed', attempt: 0, cause: e };
    case 'SecurityError':
      return { kind: 'permission-denied' };
    case 'InvalidStateError':
      return { kind: 'disconnected', unexpected: true };
    case 'NetworkError':
      if (/disconnected|not connected/i.test(message)) {
        return { kind: 'disconnected', unexpected: true };
      }
      return {
        kind: 'gatt',
        op,
        characteristic,
        cause: e,
        transient: TRANSIENT_MESSAGES.some((t) => message.includes(t)),
      };
    case 'AbortError':
      return { kind: 'timeout', op, ms: -1 };
    case 'NotSupportedError':
      return { kind: 'gatt', op, characteristic, cause: e, transient: false };
    default:
      return { kind: 'gatt', op, characteristic, cause: e, transient: false };
  }
}

/**
 * Disambiguates the chooser's `NotFoundError`.
 *
 * A "no devices matched" rejection comes back within a few hundred milliseconds; a real
 * cancel takes human time. When it is ambiguous we report `cancelled`, because a spurious
 * error toast is worse than a missing one.
 */
export function classifyChooserError(e: unknown, elapsedMs: number): EmberFailure {
  const name = (e as DOMException | undefined)?.name;
  if (name === 'SecurityError') return { kind: 'permission-denied' };
  if (name === 'TypeError') return { kind: 'gatt', op: 'requestDevice', cause: e, transient: false };
  if (name === 'NotFoundError') {
    const message = String((e as Error).message ?? '');
    if (/user cancel/i.test(message)) return { kind: 'cancelled' };
    if (elapsedMs < 300) return { kind: 'connect-failed', attempt: 0, cause: e };
    return { kind: 'cancelled' };
  }
  return classify(e, 'requestDevice');
}

export function isTransient(f: EmberFailure): boolean {
  return f.kind === 'timeout' || (f.kind === 'gatt' && f.transient);
}

export function validationError(field: string, message: string): EmberError {
  return new EmberError({ kind: 'validation', field, message });
}
