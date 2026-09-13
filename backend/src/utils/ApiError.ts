/**
 * The single error type every layer of the backend throws.
 *
 * Controllers and services throw `ApiError`; the central error middleware is the
 * only place that turns an error into an HTTP response. No handler builds its own
 * error payload — that is what keeps the error shape identical across all 17 modules.
 */

export class ApiError extends Error {
  /** HTTP status code to send. */
  public readonly statusCode: number;

  /** Stable machine-readable code the frontend can branch on, e.g. "NOT_FOUND". */
  public readonly errorCode: string;

  /** Field-level validation details, when applicable. */
  public readonly details: unknown;

  /**
   * `true` for errors we raised deliberately (bad input, missing resource) and
   * `false` for unexpected crashes. The middleware hides the message of
   * non-operational errors in production.
   */
  public readonly isOperational: boolean;

  constructor(
    statusCode: number,
    message: string,
    errorCode = 'INTERNAL_ERROR',
    details: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message: string, details: unknown = null): ApiError {
    return new ApiError(400, message, 'BAD_REQUEST', details);
  }

  static unauthorized(message = 'Authentication required'): ApiError {
    return new ApiError(401, message, 'UNAUTHORIZED');
  }

  static forbidden(message = 'You do not have permission to perform this action'): ApiError {
    return new ApiError(403, message, 'FORBIDDEN');
  }

  static notFound(message = 'Resource not found'): ApiError {
    return new ApiError(404, message, 'NOT_FOUND');
  }

  static conflict(message: string, details: unknown = null): ApiError {
    return new ApiError(409, message, 'CONFLICT', details);
  }

  static validation(message = 'Validation failed', details: unknown = null): ApiError {
    return new ApiError(422, message, 'VALIDATION_ERROR', details);
  }

  static internal(message = 'Something went wrong'): ApiError {
    return new ApiError(500, message, 'INTERNAL_ERROR');
  }
}
