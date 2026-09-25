/**
 * The single place where any error becomes an HTTP response.
 *
 * Express identifies error middleware by its four-argument signature, so
 * `_next` must stay in the parameter list even though it is unused.
 */

import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils/ApiError';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const SCOPE = 'middleware:error';

export interface ErrorBody {
  success: false;
  message: string;
  errorCode: string;
  details: unknown;
  /** Present only in development, to keep stack traces out of production responses. */
  stack?: string;
}

/**
 * Translate database-layer errors into the right HTTP answer.
 *
 * Added in Module 1. A unique-index violation is a race the application cannot fully
 * prevent: two simultaneous registrations can both pass the "does this email exist?"
 * check and only fail at insert time. Without this, that race would surface as a 500,
 * blaming the server for what is really a 409 Conflict.
 */
function translateKnownErrors(error: unknown): ApiError | null {
  if (typeof error !== 'object' || error === null) return null;

  const candidate = error as { name?: string; code?: number; keyPattern?: Record<string, unknown> };

  // MongoDB duplicate key
  if (candidate.code === 11000) {
    const field = Object.keys(candidate.keyPattern ?? {})[0] ?? 'value';
    return ApiError.conflict(`That ${field} is already in use.`, { field });
  }

  // Mongoose schema validation (a bug in our code, but a 422 is more honest than a 500)
  if (candidate.name === 'ValidationError') {
    return ApiError.validation('The submitted data is not valid.');
  }

  // Malformed ObjectId in a route param, e.g. /stations/not-an-id
  if (candidate.name === 'CastError') {
    return ApiError.badRequest('Malformed identifier in request.');
  }

  /*
   * MODULE 16 — a body that is not valid JSON.
   *
   * `express.json()` throws a SyntaxError tagged `entity.parse.failed`, and until now it fell
   * through to the 500 branch. That was wrong twice over: a client sending `{bad` has made a
   * CLIENT error, and classifying it as 5xx meant anyone could make the server log an
   * internal-error stack trace at will — noise that hides real faults.
   *
   * The body-parser error already carries the correct status; honouring it is the fix, and
   * the message is replaced so the response does not echo parser internals back to the caller.
   */
  const parseFailure = error as { type?: string; status?: number; statusCode?: number };
  if (parseFailure.type === 'entity.parse.failed') {
    return ApiError.badRequest('Request body is not valid JSON.');
  }

  /*
   * THE DATABASE IS UNREACHABLE — a 503, not a 500.
   *
   * Tested by stopping MongoDB under a running server: every request answered "500 Something
   * went wrong", which tells a client (and a load balancer, and an operator reading a status
   * page) that the request itself was broken. It was not; the platform was briefly down, and
   * trying again shortly is exactly right. Mongoose surfaces this either as a driver
   * connectivity error or, while it queues commands for a lost connection, as a buffering timeout.
   */
  const name = candidate.name ?? '';
  const message = error instanceof Error ? error.message : '';
  if (
    /^Mongo(ose)?(ServerSelection|Network|NetworkTimeout|NotConnected|TopologyClosed)Error$/.test(name) ||
    (name === 'MongooseError' && /buffering timed out/i.test(message))
  ) {
    return new ApiError(
      503,
      'The service is temporarily unavailable. Please try again in a moment.',
      'SERVICE_UNAVAILABLE',
    );
  }

  /* Body larger than the configured limit — also the caller's problem, not ours. */
  if (parseFailure.type === 'entity.too.large') {
    return new ApiError(413, 'Request body is too large.', 'PAYLOAD_TOO_LARGE');
  }

  return null;
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // Normalise anything thrown anywhere in the app into an ApiError.
  const apiError =
    error instanceof ApiError
      ? error
      : (translateKnownErrors(error) ??
        new ApiError(
          500,
          error instanceof Error ? error.message : 'Unexpected server error',
          'INTERNAL_ERROR',
        ));

  // 5xx means we broke something — always log it with the stack.
  // 4xx is the caller's mistake and is expected traffic, so log it quietly.
  if (apiError.statusCode >= 500) {
    logger.error(SCOPE, `${req.method} ${req.originalUrl} -> ${apiError.statusCode}`, error);
  } else {
    logger.warn(SCOPE, `${req.method} ${req.originalUrl} -> ${apiError.statusCode}: ${apiError.message}`);
  }

  // Never leak internal failure details to clients in production.
  // 503's message is ours and says only "try again" — safe, and useful, to pass through.
  const clientMessage =
    apiError.statusCode >= 500 && apiError.statusCode !== 503 && env.isProduction
      ? 'Something went wrong'
      : apiError.message;
  if (apiError.statusCode === 503) res.setHeader('Retry-After', '5');

  const body: ErrorBody = {
    success: false,
    message: clientMessage,
    errorCode: apiError.errorCode,
    details: apiError.details,
  };

  if (env.isDevelopment && error instanceof Error && error.stack) {
    body.stack = error.stack;
  }

  res.status(apiError.statusCode).json(body);
}
