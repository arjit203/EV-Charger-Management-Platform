/**
 * User HTTP handlers. Thin: read the request, call a service, send the envelope.
 * No access decisions here — those live in middleware and in the services' scoped queries.
 */

import type { Request, Response } from 'express';

import * as userService from '../services/user.service';
import { ApiError } from '../utils/ApiError';
import { sendSuccess } from '../utils/ApiResponse';
import { asyncHandler } from '../utils/asyncHandler';
import type { UserStatus } from '../models/user.model';
import type {
  CreateUserInput,
  ListUsersQuery,
  UpdateUserInput,
  UserStatusInput,
} from '../validators/user.validator';

function requireUser(req: Request) {
  if (!req.user) throw ApiError.unauthorized('Authentication required.');
  return req.user;
}

/** GET /users — super_admin (all) · cpo_admin (own company staff). */
export const listUsers = asyncHandler(async (req: Request, res: Response) => {
  const result = await userService.listUsers(
    requireUser(req),
    req.query as unknown as ListUsersQuery,
  );
  sendSuccess(res, result, 'Users retrieved');
});

/** GET /users/:userId */
export const getUserById = asyncHandler(async (req: Request, res: Response) => {
  const user = await userService.getUserById(requireUser(req), String(req.params.userId));
  sendSuccess(res, { user }, 'User retrieved');
});

/** POST /users — creates staff only. Supersedes Module 2's stopgap endpoint. */
export const createUser = asyncHandler(async (req: Request, res: Response) => {
  const user = await userService.createStaffUser(requireUser(req), req.body as CreateUserInput);
  sendSuccess(res, { user }, 'User created successfully', 201);
});

/** PATCH /users/:userId — name and phone only. */
export const updateUser = asyncHandler(async (req: Request, res: Response) => {
  const user = await userService.updateUser(
    requireUser(req),
    String(req.params.userId),
    req.body as UpdateUserInput,
  );
  sendSuccess(res, { user }, 'User updated successfully');
});

/** PATCH /users/:userId/status */
export const updateUserStatus = asyncHandler(async (req: Request, res: Response) => {
  const { status } = req.body as UserStatusInput;
  const user = await userService.setUserStatus(
    requireUser(req),
    String(req.params.userId),
    status as UserStatus,
  );
  sendSuccess(res, { user }, status === 'active' ? 'User activated' : 'User suspended');
});

/**
 * PATCH /users/me — the caller's own profile.
 *
 * There is no matching GET: `GET /auth/me` already returns the current user, and a second
 * identical read would be redundant surface.
 */
export const updateMe = asyncHandler(async (req: Request, res: Response) => {
  const user = await userService.updateOwnProfile(requireUser(req), req.body as UpdateUserInput);
  sendSuccess(res, { user }, 'Profile updated successfully');
});
