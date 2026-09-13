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
  /**
   * Every transaction the gateway currently believes this charger is running.
   *
   * A LIST since the Module 6 registry patch: a charger with several plugs can run several
   * transactions at once, and reporting only one misrepresented that.
   */
  transactions: {
    transactionId: number;
    connectorNumber: number;
    startedAt: string;
  }[];
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

/* -------------------------------------------------------------------------- */
/* Module 7 — charging sessions                                               */
/* -------------------------------------------------------------------------- */

/**
 * The fourth status concept in this app, and the one the driver actually watches.
 *
 *   initiating  the charger has been asked and has not yet confirmed
 *   active      energy is flowing
 *   stopping    a stop has been sent, waiting for the charger to confirm
 *   completed   finished normally, energy finalised
 *   failed      never started, or the charger vanished mid-charge
 */
export type SessionStatus = 'initiating' | 'active' | 'stopping' | 'completed' | 'failed';

export type StopReason =
  | 'Remote'
  | 'Local'
  | 'ChargerDisconnected'
  | 'StartTimeout'
  | 'Rejected';

export interface ChargingSession {
  id: string;
  userId: string;
  vehicleId: string | null;
  companyId: string;
  stationId: string;
  chargerId: string;
  connectorId: string;
  connectorNumber: number;
  transactionId: number | null;
  status: SessionStatus;
  idTag: string;
  requestedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  startMeterWh: number | null;
  lastMeterWh: number | null;
  endMeterWh: number | null;
  energyConsumedWh: number;
  energyConsumedKwh: number;
  durationSeconds: number | null;
  stopReason: StopReason | null;
  failureReason: string | null;

  /* ---------------------------- Module 9: pricing --------------------------- */

  /** Provenance — WHICH price sheet applied. The snapshot below is what priced it. */
  appliedTariffId: string | null;
  /**
   * The rate in integer paise, frozen when the session started.
   *
   * This is also what makes a live cost estimate possible with no extra backend work: multiply
   * it by the `energyConsumedKwh` that Module 8 already streams.
   */
  appliedPricePerKwhPaise: number | null;
  /** Integer paise. Null until the session ends. Computed server-side, always. */
  amountPaise: number | null;
  /** Display convenience only. Never calculate with this. */
  amountRupees: number | null;

  createdAt: string;
  updatedAt: string;
}

export interface MeterReading {
  id: string;
  sessionId: string;
  meterTimestamp: string;
  energyWh: number;
  powerKw: number | null;
  socPercent: number | null;
}

/** What the QR code on a physical plug resolves to. */
export interface ConnectorChargingView {
  connectorId: string;
  connectorNumber: number;
  connectorType: ConnectorType;
  status: ConnectorStatus;
  chargerId: string;
  chargerName: string;
  powerKw: number;
  isOnline: boolean;
  stationName: string;
  stationAddress: string;
  /** Module 9 — integer paise per kWh, or null if the operator has published no price. */
  pricePerKwhPaise: number | null;
  canStart: boolean;
  unavailableReason: string | null;
}

export interface SessionPayload {
  session: ChargingSession;
}

export interface ActiveSessionPayload {
  session: ChargingSession | null;
}

export interface ReadingsPayload {
  readings: MeterReading[];
  count: number;
}

export interface ConnectorChargingPayload {
  connector: ConnectorChargingView;
}

/* -------------------------------------------------------------------------- */
/* Module 9 — tariffs                                                         */
/* -------------------------------------------------------------------------- */

export type TariffStatus = 'active' | 'inactive';

/**
 * A company's price sheet.
 *
 * COMPANY-LEVEL, not per-station: one rate applies to every station the company owns, and at
 * most one tariff can be active at a time (enforced by a database index, not by the UI).
 */
export interface Tariff {
  id: string;
  companyId: string;
  name: string;
  /** INTEGER paise per kWh. ₹12.00 is 1200. The unit is in the name for a reason. */
  pricePerKwhPaise: number;
  /** The same number in rupees, for display and for pre-filling a form. */
  pricePerKwhRupees: number;
  status: TariffStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface TariffPayload {
  tariff: Tariff;
}
