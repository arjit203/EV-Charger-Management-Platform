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
/* Module 5 — chargers & connectors                                           */
/* -------------------------------------------------------------------------- */

/** AC passes mains power to the car's onboard charger; DC converts it and feeds the battery. */
export type ChargerType = 'AC' | 'DC';

export type ChargerStatus = 'available' | 'unavailable' | 'faulted' | 'maintenance';

/** Note: NOT OCPP's PascalCase names — the gateway translates those in Module 6. */
export type ConnectorStatus =
  | 'available'
  | 'occupied'
  | 'faulted'
  | 'unavailable'
  // Added in Module 6 — reported by the hardware over OCPP.
  | 'preparing'
  | 'charging'
  | 'finishing';

export const CHARGER_STATUS_LABELS: Record<ChargerStatus, string> = {
  available: 'Available — in service',
  unavailable: 'Unavailable — out of service',
  faulted: 'Faulted — hardware fault reported',
  maintenance: 'Maintenance — planned servicing',
};

export const CONNECTOR_STATUS_LABELS: Record<ConnectorStatus, string> = {
  available: 'Available',
  occupied: 'Occupied',
  faulted: 'Faulted',
  unavailable: 'Unavailable',
  preparing: 'Preparing',
  charging: 'Charging',
  finishing: 'Finishing',
};

/** Mirrors `PublicCharger` in backend/src/models/charger.model.ts. */
export interface Charger {
  id: string;
  stationId: string;
  companyId: string;
  name: string;
  chargerCode: string;
  ocppId: string;
  manufacturer: string;
  model: string;
  chargerType: ChargerType;
  powerKw: number;
  firmwareVersion: string | null;
  status: ChargerStatus;
  /**
   * Module 6 — CONNECTIVITY, written only by the OCPP gateway. Distinct from `status`, which
   * is administrative, and from each connector's status, which is operational.
   */
  isOnline: boolean;
  lastHeartbeatAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Live gateway state (Module 6) — the registry's view right now, not the database mirror. */
export interface ChargerConnection {
  ocppId: string;
  connected: boolean;
  connectedAt: string | null;
  lastHeartbeatAt: string | null;
  transaction: {
    transactionId: number;
    connectorNumber: number;
    startedAt: string;
  } | null;
}

/** Mirrors `PublicConnector` in backend/src/models/connector.model.ts. */
export interface Connector {
  id: string;
  chargerId: string;
  connectorNumber: number;
  connectorType: ConnectorType;
  powerKw: number;
  status: ConnectorStatus;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChargerPayload {
  charger: Charger;
}

export interface ConnectorPayload {
  connector: Connector;
}

/* -------------------------------------------------------------------------- */
/* Module 4 — stations                                                        */
/* -------------------------------------------------------------------------- */

/** Mirrors backend/src/constants/station.ts. */
export type StationStatus = 'active' | 'inactive' | 'suspended';

export const STATION_STATUS_LABELS: Record<StationStatus, string> = {
  active: 'Active — in service',
  inactive: 'Inactive — temporarily out of service',
  suspended: 'Suspended — by platform administrator',
};

/** Mirrors `PublicStation` in backend/src/models/station.model.ts. */
export interface Station {
  id: string;
  companyId: string;
  name: string;
  stationCode: string;
  address: string;
  city: string;
  state: string;
  country: string;
  postalCode: string | null;
  latitude: number;
  longitude: number;
  status: StationStatus;
  contactPhone: string | null;
  openingHours: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface StationPayload {
  station: Station;
}

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
