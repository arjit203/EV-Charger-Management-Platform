/**
 * OCPP-J message envelope.
 *
 * We follow the real OCPP-J wire format: every frame is a JSON ARRAY whose first element is
 * a message type id.
 *
 *   CALL        [2, uniqueId, action, payload]
 *   CALLRESULT  [3, uniqueId, payload]
 *   CALLERROR   [4, uniqueId, errorCode, errorDescription, errorDetails]
 *
 * `uniqueId` correlates a response with its request. It matters because BOTH sides can have
 * several messages in flight at once: a charger can be sending MeterValues while the backend
 * sends RemoteStopTransaction, and each side must know which reply belongs to which call.
 *
 * HONESTY NOTE: this is an OCPP-INSPIRED SIMULATION. The envelope matches OCPP-J and the
 * action names are real, but payload schemas are simplified and we implement only the subset
 * this project needs. It is not a spec-compliant OCPP stack, and should never be described
 * as one.
 *
 * This file knows nothing about what any action MEANS — that is `handlers.ts`.
 */

export const MessageType = {
  CALL: 2,
  CALLRESULT: 3,
  CALLERROR: 4,
} as const;

export type OcppPayload = Record<string, unknown>;

export interface OcppCall {
  type: typeof MessageType.CALL;
  uniqueId: string;
  action: string;
  payload: OcppPayload;
}

export interface OcppCallResult {
  type: typeof MessageType.CALLRESULT;
  uniqueId: string;
  payload: OcppPayload;
}

export interface OcppCallError {
  type: typeof MessageType.CALLERROR;
  uniqueId: string;
  errorCode: string;
  errorDescription: string;
  errorDetails: OcppPayload;
}

export type OcppMessage = OcppCall | OcppCallResult | OcppCallError;

/** Standard OCPP error codes, plus the few we actually raise. */
export const OcppErrorCode = {
  NOT_SUPPORTED: 'NotSupported',
  PROTOCOL_ERROR: 'ProtocolError',
  FORMATION_VIOLATION: 'FormationViolation',
  PROPERTY_CONSTRAINT_VIOLATION: 'PropertyConstraintViolation',
  INTERNAL_ERROR: 'InternalError',
  SECURITY_ERROR: 'SecurityError',
} as const;

/** Thrown by a handler to produce a CALLERROR instead of a CALLRESULT. */
export class OcppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: OcppPayload = {},
  ) {
    super(message);
    this.name = 'OcppError';
  }
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Parse a raw frame.
 *
 * Returns `null` for anything unparseable. The caller turns that into a CALLERROR rather
 * than throwing — one malformed frame from one simulated charger must never take down the
 * backend, and must not even close that charger's socket.
 */
export function parseMessage(raw: string): OcppMessage | null {
  let frame: unknown;

  try {
    frame = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!Array.isArray(frame) || frame.length < 3) return null;

  const [type, uniqueId] = frame as [unknown, unknown];
  if (typeof uniqueId !== 'string' || uniqueId.length === 0 || uniqueId.length > 64) return null;

  if (type === MessageType.CALL) {
    const [, , action, payload] = frame as [unknown, string, unknown, unknown];
    if (typeof action !== 'string' || action.length === 0) return null;
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
    return { type: MessageType.CALL, uniqueId, action, payload: payload as OcppPayload };
  }

  if (type === MessageType.CALLRESULT) {
    const [, , payload] = frame as [unknown, string, unknown];
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
    return { type: MessageType.CALLRESULT, uniqueId, payload: payload as OcppPayload };
  }

  if (type === MessageType.CALLERROR) {
    const [, , errorCode, errorDescription, errorDetails] = frame as [
      unknown,
      string,
      unknown,
      unknown,
      unknown,
    ];
    return {
      type: MessageType.CALLERROR,
      uniqueId,
      errorCode: typeof errorCode === 'string' ? errorCode : OcppErrorCode.INTERNAL_ERROR,
      errorDescription: typeof errorDescription === 'string' ? errorDescription : '',
      errorDetails:
        typeof errorDetails === 'object' && errorDetails !== null && !Array.isArray(errorDetails)
          ? (errorDetails as OcppPayload)
          : {},
    };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Building                                                                   */
/* -------------------------------------------------------------------------- */

export function buildCall(uniqueId: string, action: string, payload: OcppPayload): string {
  return JSON.stringify([MessageType.CALL, uniqueId, action, payload]);
}

export function buildCallResult(uniqueId: string, payload: OcppPayload): string {
  return JSON.stringify([MessageType.CALLRESULT, uniqueId, payload]);
}

export function buildCallError(
  uniqueId: string,
  errorCode: string,
  errorDescription: string,
  errorDetails: OcppPayload = {},
): string {
  return JSON.stringify([MessageType.CALLERROR, uniqueId, errorCode, errorDescription, errorDetails]);
}

/** OCPP timestamps are ISO 8601 UTC. */
export function ocppNow(): string {
  return new Date().toISOString();
}
