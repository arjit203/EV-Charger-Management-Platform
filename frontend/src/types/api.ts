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
  faulted: 'Faulted — a person recorded a fault',
  maintenance: 'Maintenance — planned servicing',
};

/**
 * What the MACHINE says about itself, reported over OCPP on connectorId 0 — which addresses
 * the charge point as a whole rather than any one plug.
 *
 * Separate from `ChargerStatus` above, which is what a PERSON decided. They disagree often and
 * usefully: a charger can be administratively available and still be reporting a ground fault.
 */
export type ChargerHardwareStatus = 'operative' | 'faulted' | 'unavailable';

export const CHARGER_HARDWARE_STATUS_LABELS: Record<ChargerHardwareStatus, string> = {
  operative: 'Reporting healthy',
  faulted: 'Reporting a fault',
  unavailable: 'Out of service (self-reported)',
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
  /**
   * SELF-REPORTED HEALTH, also gateway-only. The fourth axis: a charger can be online,
   * administratively available, and still telling us it is broken.
   */
  hardwareStatus: ChargerHardwareStatus;
  /** The OCPP error code behind a fault — `GroundFailure`, `OverTemperature`, and so on. */
  faultCode: string | null;
  faultReportedAt: string | null;
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
  /**
   * MODULE 10 — has this charge been collected?
   *
   * A SEPARATE state machine from `status`. A session can be `completed` and `unpaid` at the
   * same time: the electricity flowed and the driver's wallet was short. That is a correct
   * state, not an error — you cannot un-deliver electricity.
   */
  paymentStatus: 'unpaid' | 'paid';

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
  /** The machine's own report. A plug can read `available` on a charger that is faulted. */
  chargerHardwareStatus: ChargerHardwareStatus;
  chargerFaultCode: string | null;
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

/* -------------------------------------------------------------------------- */
/* Module 10 — wallet & payments                                              */
/* -------------------------------------------------------------------------- */

export type WalletStatus = 'active' | 'blocked';
export type WalletTransactionType = 'recharge' | 'session_debit' | 'refund';
export type LedgerDirection = 'credit' | 'debit';
export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'refunded';
export type PaymentPurpose = 'wallet_recharge' | 'session_debit';

/** A driver's prepaid balance. Integer paise, like every other amount in the project. */
export interface Wallet {
  id: string;
  userId: string;
  balancePaise: number;
  balanceRupees: number;
  status: WalletStatus;
  createdAt: string;
  updatedAt: string;
}

/** One append-only ledger row. `balanceAfter` is what makes the history reconstructible. */
export interface WalletTransaction {
  id: string;
  type: WalletTransactionType;
  direction: LedgerDirection;
  amountPaise: number;
  amountRupees: number;
  balanceAfterPaise: number;
  balanceAfterRupees: number;
  chargingSessionId: string | null;
  description: string;
  createdAt: string;
}

/** A collection attempt — a Razorpay recharge, or an internal session debit. */
export interface PaymentTransaction {
  id: string;
  userId: string;
  purpose: PaymentPurpose;
  provider: 'razorpay' | 'internal';
  chargingSessionId: string | null;
  companyId: string | null;
  amountPaise: number;
  amountRupees: number;
  status: PaymentStatus;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  attempts: number;
  failureReason: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WalletPayload {
  wallet: Wallet;
  /** What this driver still owes for charges already delivered. */
  outstandingPaise: number;
  outstandingRupees: number;
}

/** Everything the browser needs to open Razorpay Checkout. Note: the PUBLIC key only. */
export interface RechargeOrder {
  paymentId: string;
  providerOrderId: string;
  amountPaise: number;
  keyId: string;
  /** `stub` when the backend has no Razorpay credentials configured. */
  mode: 'razorpay' | 'stub';
}

export interface RechargeOrderPayload {
  order: RechargeOrder;
}

export interface VerifyRechargePayload {
  payment: PaymentTransaction;
  wallet: Wallet;
  alreadyProcessed: boolean;
}

export interface PaymentPayload {
  payment: PaymentTransaction;
}

/* -------------------------------------------------------------------------- */
/* Module 11 — complaints                                                     */
/* -------------------------------------------------------------------------- */

export type ComplaintCategory =
  | 'charger_issue'
  | 'session_issue'
  | 'payment_issue'
  | 'station_issue'
  | 'account_issue'
  | 'other';

export type ComplaintPriority = 'low' | 'medium' | 'high';
export type ComplaintStatus = 'open' | 'in_progress' | 'resolved' | 'closed';

/**
 * A support ticket.
 *
 * The resource ids are DERIVED server-side from a single anchor (a session or a charger) — a
 * client never sends `stationId`, `connectorId` or `companyId`, which is what makes a mismatched
 * set of references impossible to express rather than merely rejected.
 *
 * `companyId: null` means platform-level — an account problem belonging to no operator, visible
 * only to super_admin.
 */
export interface Complaint {
  id: string;
  userId: string;
  companyId: string | null;
  chargingSessionId: string | null;
  chargerId: string | null;
  stationId: string | null;
  connectorId: string | null;
  category: ComplaintCategory;
  /** Immutable after creation — a ticket is an audit record. */
  subject: string;
  /** Immutable after creation. */
  description: string;
  priority: ComplaintPriority;
  status: ComplaintStatus;
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The live state of a disputed session, derived at READ time.
 *
 * Never copied onto the complaint: staff need to know whether a charge is outstanding *now*, not
 * what it was when the ticket was filed. Read-only — this module can see payment state and has
 * no authority over it.
 */
export interface DisputedSession {
  sessionId: string;
  status: SessionStatus;
  paymentStatus: 'unpaid' | 'paid';
  energyConsumedKwh: number;
  amountPaise: number | null;
  appliedPricePerKwhPaise: number | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface ComplaintPayload {
  complaint: Complaint;
}

export interface ComplaintDetailPayload {
  complaint: Complaint;
  /** Null unless the complaint is anchored to a charging session. */
  session: DisputedSession | null;
}

/* -------------------------------------------------------------------------- */
/* Module 12 — notifications                                                  */
/* -------------------------------------------------------------------------- */

export type NotificationType =
  | 'charging_started'
  | 'charging_completed'
  | 'charging_failed'
  | 'payment_success'
  | 'payment_pending'
  | 'wallet_recharged'
  | 'complaint_updated'
  | 'complaint_created'
  | 'charger_fault';

export type NotificationReferenceType = 'charging_session' | 'complaint' | 'payment' | 'charger';

/**
 * An in-app message for exactly one person.
 *
 * `referenceType` + `referenceId` are what the UI navigates by — there is deliberately no
 * embedded copy of the session or complaint, so the page fetches fresh detail through the
 * existing scoped endpoints instead of rendering a stale snapshot.
 */
export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  referenceType: NotificationReferenceType;
  referenceId: string;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
}

export interface UnreadCountPayload {
  unreadCount: number;
}

export interface NotificationPayload {
  notification: AppNotification;
}

/* -------------------------------------------------------------------------- */
/* Module 13 — analytics                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The fleet RIGHT NOW. A snapshot, not a window — see the note on `AnalyticsOverview`.
 *
 * Charger UTILIZATION is deliberately absent. Every session in this project is started by
 * hand, so a busy-time-over-total-time figure would be computed from staged traffic and
 * would look authoritative while meaning nothing.
 */
export interface FleetSnapshot {
  stations: number;
  chargers: number;
  chargersOnline: number;
  chargersOffline: number;
  chargersByStatus: Record<ChargerStatus, number>;
  connectors: number;
  connectorsByStatus: Record<ConnectorStatus, number>;
  activeSessions: number;
}

export interface SessionTotals {
  total: number;
  byStatus: Record<SessionStatus, number>;
  energyWh: number;
  energyKwh: number;
}

export interface RevenueTotals {
  revenuePaise: number;
  revenueRupees: number;
  payments: number;
  unpaidSessions: number;
  unpaidPaise: number;
  unpaidRupees: number;
}

export interface ComplaintTotals {
  total: number;
  byStatus: Record<ComplaintStatus, number>;
  /** Outstanding right now, whatever day they were filed. Not windowed. */
  openNow: number;
}

/**
 * NOTE ON `revenue?`: the key is ABSENT for an operator, not null.
 *
 * An operator runs hardware; a company's income is not operational data. The server does not
 * merely hide it — it never runs the query. `revenue === undefined` is therefore "you may not
 * see this", which is a different statement from `revenuePaise === 0` ("nothing was earned"),
 * and the dashboard must not collapse the two into one blank card.
 */
export interface AnalyticsOverview {
  range: { from: string; to: string; days: number };
  fleet: FleetSnapshot;
  sessions: SessionTotals;
  revenue?: RevenueTotals;
  complaints: ComplaintTotals;
}

export interface DailyPoint {
  date: string;
  sessions: number;
  energyWh: number;
  energyKwh: number;
}

export interface DailyRevenuePoint {
  date: string;
  revenuePaise: number;
  revenueRupees: number;
  payments: number;
}

export interface StationBreakdown {
  stationId: string;
  name: string;
  stationCode: string;
  sessions: number;
  energyWh: number;
  energyKwh: number;
  /** Absent for an operator, for the same reason as `AnalyticsOverview.revenue`. */
  revenuePaise?: number;
  revenueRupees?: number;
}

export interface SessionSeriesPayload {
  range: { from: string; to: string };
  points: DailyPoint[];
  totals: SessionTotals;
}

export interface RevenueSeriesPayload {
  range: { from: string; to: string };
  points: DailyRevenuePoint[];
  totals: RevenueTotals;
}

export interface StationAnalyticsPayload {
  range: { from: string; to: string };
  stations: StationBreakdown[];
}

/* -------------------------------------------------------------------------- */
/* Module 14 — station map                                                    */
/* -------------------------------------------------------------------------- */

/** Availability counted from Modules 5 and 6. A request-time snapshot, not a reservation. */
export interface StationAvailability {
  chargers: number;
  chargersOnline: number;
  totalConnectors: number;
  availableConnectors: number;
}

/**
 * A staff marker, from `GET /stations/map`. Company-scoped by the backend.
 *
 * `latitude` / `longitude` are typed as `number` because the model requires them — but the
 * map still guards with `Number.isFinite` before rendering. A row written directly to the
 * database can defeat any type, and one bad coordinate would otherwise throw inside Leaflet
 * and blank the whole map.
 */
export interface MapStation extends StationAvailability {
  id: string;
  name: string;
  stationCode: string;
  address: string;
  city: string;
  state: string;
  latitude: number;
  longitude: number;
  status: StationStatus;
  companyId: string;
}

/**
 * A driver marker, from `GET /stations/public`.
 *
 * A DELIBERATELY NARROWER TYPE — not `MapStation` with fields optional. There is no
 * `companyId` or `stationCode` in this shape at all, so no component can render a company
 * identity to a driver even by accident: it would not compile.
 */
export interface PublicMapStation extends StationAvailability {
  id: string;
  name: string;
  address: string;
  city: string;
  state: string;
  latitude: number;
  longitude: number;
  status: StationStatus;
}

/** What both map endpoints return. `truncated` says the cap clipped the view. */
export interface MapStationsPayload<T> {
  stations: T[];
  truncated: boolean;
}

/** The union the map UI actually renders. Everything it uses exists on both shapes. */
export type AnyMapStation = MapStation | PublicMapStation;

/** Narrowing helper — the one place the UI is allowed to ask "is this the staff shape?". */
export function isStaffMapStation(station: AnyMapStation): station is MapStation {
  return 'companyId' in station;
}
