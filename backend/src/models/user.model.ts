/**
 * User — the first domain model in the project.
 *
 * Covers every human actor: platform admins, CPO admins, operators and EV drivers.
 * They are one collection rather than several because they share identity, login and
 * status; what differs is the `role`, which drives authorisation.
 *
 * Password handling note: the field is called `passwordHash`, never `password`, and
 * hashing happens through the `hashPassword` static rather than a `pre('save')` hook.
 * A hook that hashes "the password field" is the classic source of double-hashing bugs
 * when a document is saved twice. Being explicit costs one line at the call site and
 * removes the whole class of bug.
 */

import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';
import bcrypt from 'bcryptjs';

import { ALL_ROLES, ROLES, type Role } from '../constants/roles';
import { env } from '../config/env';

export type UserStatus = 'active' | 'suspended';

export const USER_STATUSES: UserStatus[] = ['active', 'suspended'];

export interface IUser {
  name: string;
  email: string;
  phone?: string;
  passwordHash: string;
  role: Role;
  status: UserStatus;
  /**
   * Owning company. Null for `super_admin` (platform-wide) and `driver` (not company
   * staff). Required in practice for `cpo_admin` and `operator`.
   *
   * The `ref` points at a Company model that does not exist until Module 2. Mongoose
   * only resolves a ref when `.populate()` is called, so declaring it now is safe and
   * means Module 2 does not have to alter this schema's shape.
   */
  companyId: Types.ObjectId | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IUserMethods {
  /** Constant-time comparison of a plaintext password against the stored hash. */
  comparePassword(plainPassword: string): Promise<boolean>;
}

export interface IUserStatics {
  /** Hash a plaintext password using the configured cost factor. */
  hashPassword(plainPassword: string): Promise<string>;
}

export type UserModel = Model<IUser, Record<string, never>, IUserMethods> & IUserStatics;

const userSchema = new Schema<IUser, UserModel, IUserMethods>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },

    email: {
      type: String,
      required: true,
      unique: true, // also creates the index — do not add `index: true` as well
      lowercase: true,
      trim: true,
      maxlength: 254,
    },

    phone: { type: String, trim: true, maxlength: 20 },

    // `select: false` means queries never return the hash unless explicitly asked
    // for with `.select('+passwordHash')`. This is the main defence against leaking
    // it through a careless `res.json(user)`.
    passwordHash: { type: String, required: true, select: false },

    role: { type: String, enum: ALL_ROLES, required: true, default: ROLES.DRIVER, index: true },

    // Lets an admin disable an account without deleting it, which would orphan that
    // user's charging sessions and payment history.
    status: { type: String, enum: USER_STATUSES, required: true, default: 'active', index: true },

    companyId: { type: Schema.Types.ObjectId, ref: 'Company', default: null, index: true },

    lastLoginAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.passwordHash;
        return ret;
      },
    },
  },
);

// Supports the company-scoped lookups every later module performs, e.g.
// "all operators belonging to company X".
userSchema.index({ companyId: 1, role: 1 });

userSchema.methods.comparePassword = function comparePassword(
  plainPassword: string,
): Promise<boolean> {
  return bcrypt.compare(plainPassword, this.passwordHash);
};

userSchema.statics.hashPassword = function hashPassword(plainPassword: string): Promise<string> {
  return bcrypt.hash(plainPassword, env.bcryptSaltRounds);
};

export const User = model<IUser, UserModel>('User', userSchema);

export type UserDocument = HydratedDocument<IUser, IUserMethods>;

/**
 * The user shape the API is allowed to return.
 *
 * This is an explicit allow-list, which is the point: the `toJSON` transform above
 * deletes `passwordHash`, but a delete-list silently leaks any sensitive field added
 * later. Anything not named here never reaches a client, by construction.
 *
 * It is also the contract the frontend's `User` type mirrors.
 */
export interface PublicUser {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: Role;
  status: UserStatus;
  companyId: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toPublicUser(user: UserDocument): PublicUser {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    phone: user.phone ?? null,
    role: user.role,
    status: user.status,
    companyId: user.companyId ? String(user.companyId) : null,
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}
