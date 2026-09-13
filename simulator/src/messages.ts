/**
 * OCPP-J framing for the simulator.
 *
 * Deliberately duplicated from the backend rather than imported. This process stands in for
 * third-party hardware, and real hardware does not share code with the backend it talks to —
 * keeping them separate means the protocol boundary is genuinely exercised. If the two
 * implementations ever disagreed, that is a bug worth catching, not one to hide behind a
 * shared module.
 *
 *   CALL        [2, uniqueId, action, payload]
 *   CALLRESULT  [3, uniqueId, payload]
 *   CALLERROR   [4, uniqueId, errorCode, errorDescription, errorDetails]
 */

import crypto from 'crypto';

export const CALL = 2;
export const CALLRESULT = 3;
export const CALLERROR = 4;

export type Payload = Record<string, unknown>;

export type Incoming =
  | { type: typeof CALL; uniqueId: string; action: string; payload: Payload }
  | { type: typeof CALLRESULT; uniqueId: string; payload: Payload }
  | { type: typeof CALLERROR; uniqueId: string; errorCode: string; errorDescription: string };

export function newUniqueId(): string {
  return crypto.randomUUID();
}

export function buildCall(uniqueId: string, action: string, payload: Payload): string {
  return JSON.stringify([CALL, uniqueId, action, payload]);
}

export function buildCallResult(uniqueId: string, payload: Payload): string {
  return JSON.stringify([CALLRESULT, uniqueId, payload]);
}

export function buildCallError(uniqueId: string, code: string, description: string): string {
  return JSON.stringify([CALLERROR, uniqueId, code, description, {}]);
}

export function parse(raw: string): Incoming | null {
  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!Array.isArray(frame) || frame.length < 3) return null;
  const [type, uniqueId] = frame as [unknown, unknown];
  if (typeof uniqueId !== 'string') return null;

  if (type === CALL) {
    const [, , action, payload] = frame as [unknown, string, unknown, unknown];
    if (typeof action !== 'string' || typeof payload !== 'object' || payload === null) return null;
    return { type: CALL, uniqueId, action, payload: payload as Payload };
  }

  if (type === CALLRESULT) {
    const [, , payload] = frame as [unknown, string, unknown];
    if (typeof payload !== 'object' || payload === null) return null;
    return { type: CALLRESULT, uniqueId, payload: payload as Payload };
  }

  if (type === CALLERROR) {
    const [, , errorCode, errorDescription] = frame as [unknown, string, unknown, unknown];
    return {
      type: CALLERROR,
      uniqueId,
      errorCode: typeof errorCode === 'string' ? errorCode : 'InternalError',
      errorDescription: typeof errorDescription === 'string' ? errorDescription : '',
    };
  }

  return null;
}
