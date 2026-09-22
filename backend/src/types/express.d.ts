/**
 * Augments Express's `Request` with the authenticated user.
 *
 * `auth.middleware.ts` populates `req.user`; every protected handler reads it.
 * It carries `companyId` deliberately, so a handler can scope a query by company
 * without a second database lookup.
 */

import type { Role } from '../constants/roles';
import type { PublicCompany } from '../models/company.model';

export interface AuthUser {
  /** User's MongoDB _id as a string. */
  id: string;
  email: string;
  role: Role;
  /** Null for super_admin and driver; set for company-scoped roles. */
  companyId: string | null;
}

declare global {
   
  namespace Express {
    interface Request {
      user?: AuthUser;
      /**
       * The caller's own company, loaded and status-checked by `requireActiveCompany`
       * (Module 2). Present only for company-scoped roles; `super_admin` has none.
       * Saves later handlers a second lookup.
       */
      company?: PublicCompany;
      /**
       * The unparsed request body, captured by `express.json({ verify })` in `app.ts`
       * (Module 10).
       *
       * Needed by exactly one route: the Razorpay webhook, whose signature is an HMAC over the
       * bytes as sent. Re-serialising the parsed object would not reproduce them.
       */
      rawBody?: Buffer;
    }
  }
}
