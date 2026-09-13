/**
 * The one success-response shape used by every endpoint in this project.
 *
 *   { "success": true, "message": "...", "data": { ... } }
 *
 * Errors use the mirrored shape (see error.middleware.ts):
 *
 *   { "success": false, "message": "...", "errorCode": "...", "details": ... }
 *
 * Locking this down in Module 0 means the frontend can write ONE response handler
 * and reuse it for auth, stations, chargers, sessions, wallet — everything.
 */

import type { Response } from 'express';

export interface SuccessBody<T> {
  success: true;
  message: string;
  data: T;
}

/** Send a standard success response. */
export function sendSuccess<T>(
  res: Response,
  data: T,
  message = 'Success',
  statusCode = 200,
): Response<SuccessBody<T>> {
  return res.status(statusCode).json({ success: true, message, data });
}
