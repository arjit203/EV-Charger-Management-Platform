/**
 * Authentication HTTP handlers.
 *
 * Thin by design: read the request, call a service, send the standard envelope.
 * No business rules here.
 */

import type { Request, Response } from 'express';

import * as authService from '../services/auth.service';
import { ApiError } from '../utils/ApiError';
import { sendSuccess } from '../utils/ApiResponse';
import { asyncHandler } from '../utils/asyncHandler';
import type { LoginInput, RegisterInput } from '../validators/auth.validator';

/** POST /auth/register — public. Always creates a `driver`. */
export const register = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.registerDriver(req.body as RegisterInput);
  sendSuccess(res, result, 'Account created successfully', 201);
});

/** POST /auth/login — public. */
export const login = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.login(req.body as LoginInput);
  sendSuccess(res, result, 'Logged in successfully');
});

/** GET /auth/me — authenticated. Self-scoped by definition: it reads req.user.id only. */
export const me = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    throw ApiError.unauthorized('Authentication required.');
  }

  const user = await authService.getCurrentUser(req.user.id);
  sendSuccess(res, { user }, 'Current user');
});
