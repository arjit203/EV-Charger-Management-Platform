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
      : new ApiError(
          500,
          error instanceof Error ? error.message : 'Unexpected server error',
          'INTERNAL_ERROR',
        );

  // 5xx means we broke something — always log it with the stack.
  // 4xx is the caller's mistake and is expected traffic, so log it quietly.
  if (apiError.statusCode >= 500) {
    logger.error(SCOPE, `${req.method} ${req.originalUrl} -> ${apiError.statusCode}`, error);
  } else {
    logger.warn(SCOPE, `${req.method} ${req.originalUrl} -> ${apiError.statusCode}: ${apiError.message}`);
  }

  // Never leak internal failure details to clients in production.
  const clientMessage =
    apiError.statusCode >= 500 && env.isProduction ? 'Something went wrong' : apiError.message;

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
