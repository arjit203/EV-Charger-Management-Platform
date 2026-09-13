/**
 * Shared API types.
 *
 * These mirror the backend contract defined in Module 0
 * (backend/src/utils/ApiResponse.ts and backend/src/middlewares/error.middleware.ts).
 * If one side changes, the other must change with it — that is a deliberate
 * structural change, not a casual edit.
 */

/** Every successful response from the backend. */
export interface ApiSuccessBody<T> {
  success: true;
  message: string;
  data: T;
}

/** Every error response from the backend. */
export interface ApiErrorBody {
  success: false;
  message: string;
  errorCode: string;
  details: unknown;
  /** Development only. */
  stack?: string;
}

export type ApiEnvelope<T> = ApiSuccessBody<T> | ApiErrorBody;

/* -------------------------------------------------------------------------- */
/* Module 1 — auth                                                            */
/* -------------------------------------------------------------------------- */

/** Mirrors backend/src/constants/roles.ts. LOCKED — see the RBAC model. */
export type Role = 'super_admin' | 'cpo_admin' | 'operator' | 'driver';

export type UserStatus = 'active' | 'suspended';

/** Mirrors `PublicUser` in backend/src/models/user.model.ts. */
export interface User {
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

/** Response payload of POST /auth/register and POST /auth/login. */
export interface AuthResult {
  user: User;
  token: string;
}

/** Response payload of GET /auth/me. */
export interface MePayload {
  user: User;
}

/** Human-readable role labels for the UI. */
export const ROLE_LABELS: Record<Role, string> = {
  super_admin: 'Platform Admin',
  cpo_admin: 'CPO Admin',
  operator: 'Operator',
  driver: 'Driver',
};

/* -------------------------------------------------------------------------- */
/* Module 3 — vehicles                                                        */
/* -------------------------------------------------------------------------- */

/** Mirrors backend/src/constants/vehicle.ts. */
export type ConnectorType = 'CCS2' | 'CHAdeMO' | 'Type2' | 'GBT';

export const CONNECTOR_LABELS: Record<ConnectorType, string> = {
  CCS2: 'CCS2 — DC fast charging',
  CHAdeMO: 'CHAdeMO — DC (Nissan and similar)',
  Type2: 'Type 2 — AC charging',
  GBT: 'GB/T — Chinese standard',
};

/** Mirrors `PublicVehicle` in backend/src/models/vehicle.model.ts. */
export interface Vehicle {
  id: string;
  userId: string;
  make: string;
  model: string;
  registrationNumber: string;
  batteryCapacityKwh: number | null;
  connectorType: ConnectorType;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface VehiclePayload {
  vehicle: Vehicle;
}

export interface UserPayload {
  user: User;
}

/* -------------------------------------------------------------------------- */
/* Module 2 — companies                                                       */
/* -------------------------------------------------------------------------- */

/** Mirrors backend/src/constants/company.ts. Descriptive only — nothing branches on it. */
export type CompanyType = 'CPO' | 'eMSP' | 'PLATFORM';

export type CompanyStatus = 'active' | 'suspended';

export const COMPANY_TYPE_LABELS: Record<CompanyType, string> = {
  CPO: 'CPO — Charge Point Operator',
  eMSP: 'eMSP — e-Mobility Service Provider',
  PLATFORM: 'Platform — CPMS software provider',
};

export interface CompanyAddress {
  line1: string;
  city: string;
  state: string;
  country: string;
  postalCode: string;
}

/** Mirrors `PublicCompany` in backend/src/models/company.model.ts. */
export interface Company {
  id: string;
  name: string;
  legalName: string | null;
  type: CompanyType;
  contactEmail: string | null;
  contactPhone: string | null;
  address: CompanyAddress | null;
  status: CompanyStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Standard list envelope used by every paginated endpoint. */
export interface Paginated<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface CompanyPayload {
  company: Company;
}

/* -------------------------------------------------------------------------- */
/* Module 0 — health                                                          */
/* -------------------------------------------------------------------------- */

export type DatabaseState =
  | 'connected'
  | 'connecting'
  | 'disconnected'
  | 'disconnecting'
  | 'not_configured'
  | 'unknown';

export interface DatabaseStatus {
  state: DatabaseState;
  name: string | null;
  host: string | null;
  lastError: string | null;
}

export interface HealthPayload {
  status: 'ok' | 'degraded';
  service: string;
  environment: string;
  uptimeSeconds: number;
  timestamp: string;
  database: DatabaseStatus;
}
