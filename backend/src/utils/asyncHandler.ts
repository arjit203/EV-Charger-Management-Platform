/**
 * Wrapper that forwards rejected promises from async route handlers to Express.
 *
 * Express 4 does not catch errors thrown inside `async` handlers — an unhandled
 * rejection would hang the request instead of hitting the error middleware. Every
 * async controller in this project is wrapped in this, so `throw ApiError.notFound(...)`
 * works identically in sync and async code.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

export function asyncHandler(handler: AsyncRequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
