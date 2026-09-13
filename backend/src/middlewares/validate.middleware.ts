/**
 * Generic Zod validation middleware.
 *
 * Rejects a bad request before it reaches a controller, and reports every invalid
 * field at once rather than one per round trip. On success it replaces `req.body`
 * with the parsed value, so defaults and coercions defined in the schema apply.
 */

import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';

import { ApiError } from '../utils/ApiError';

export interface FieldError {
  field: string;
  message: string;
}

export function validateBody(schema: ZodType): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      const details: FieldError[] = result.error.issues.map((issue) => ({
        field: issue.path.length > 0 ? issue.path.join('.') : '(body)',
        message: issue.message,
      }));

      next(ApiError.validation('Validation failed', details));
      return;
    }

    req.body = result.data;
    next();
  };
}
