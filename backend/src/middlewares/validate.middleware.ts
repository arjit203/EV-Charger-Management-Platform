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

/**
 * Validate route parameters (Module 2 addition).
 *
 * Fails with **400 Bad Request**, not 422, because a malformed path segment means the URL
 * itself is wrong — there is no resource being addressed. A body that fails business rules
 * is a well-formed request the server cannot process, which is what 422 means. This also
 * matches the existing `CastError -> 400` mapping in the error middleware.
 */
export function validateParams(schema: ZodType): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.params);

    if (!result.success) {
      const details: FieldError[] = result.error.issues.map((issue) => ({
        field: issue.path.length > 0 ? issue.path.join('.') : '(params)',
        message: issue.message,
      }));

      next(ApiError.badRequest('Invalid request parameters.', details));
      return;
    }

    next();
  };
}

/**
 * Validate and coerce the query string (Module 2 addition).
 *
 * Query values always arrive as strings, so schemas here use `z.coerce` to turn `?page=2`
 * into a real number. The parsed result replaces `req.query` so controllers receive typed
 * values with defaults already applied.
 */
export function validateQuery(schema: ZodType): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.query);

    if (!result.success) {
      const details: FieldError[] = result.error.issues.map((issue) => ({
        field: issue.path.length > 0 ? issue.path.join('.') : '(query)',
        message: issue.message,
      }));

      next(ApiError.badRequest('Invalid query parameters.', details));
      return;
    }

    // Express 4 allows reassigning req.query; the cast is needed because the parsed shape
    // holds coerced numbers while the declared type is a string-only ParsedQs.
    req.query = result.data as typeof req.query;
    next();
  };
}
