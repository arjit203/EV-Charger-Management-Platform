/**
 * Catch-all for unmatched routes.
 *
 * Registered after every router, so anything that reaches it is genuinely an unknown
 * path. It converts that into an `ApiError` and hands it to the error middleware,
 * which keeps 404s in the same JSON shape as every other error — no stray HTML
 * "Cannot GET /foo" pages leaking to the frontend.
 */

import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils/ApiError';

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}
