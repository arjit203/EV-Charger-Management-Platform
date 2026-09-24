/**
 * Human-readable labels for log lines — sessions, chargers, users, companies.
 *
 * A raw ObjectId tells an operator nothing — "Session 6ab2f0a4… failed" forces a database
 * lookup just to learn WHERE it happened. These helpers put the things a person recognises
 * first (charger OCPP id, connector number, driver email) and keep the ObjectId at the end in
 * brackets, because it is still the only key that finds exactly one record.
 *
 * Only for logs. The lookups cost two small queries, which is fine for the rare lifecycle
 * events that use it and would not be fine on a hot path like MeterValues. A failed lookup
 * falls back to the bare id — a log line must never be the thing that throws.
 */

import type { Types } from 'mongoose';
import { Charger } from '../models/charger.model';
import { Company } from '../models/company.model';
import { User } from '../models/user.model';

interface SessionLike {
  _id: Types.ObjectId | string;
  chargerId: Types.ObjectId | string;
  userId: Types.ObjectId | string;
  connectorNumber: number;
}

export async function describeChargerId(chargerId: Types.ObjectId | string): Promise<string> {
  try {
    const charger = await Charger.findById(chargerId).select('ocppId').lean();
    return charger ? charger.ocppId : `charger ${String(chargerId)}`;
  } catch {
    return `charger ${String(chargerId)}`;
  }
}

/** e.g. `rahul@demo.in`. */
export async function describeUser(userId: Types.ObjectId | string): Promise<string> {
  try {
    const user = await User.findById(userId).select('email').lean();
    return user ? user.email : `user ${String(userId)}`;
  } catch {
    return `user ${String(userId)}`;
  }
}

/** e.g. `"GreenCharge Delhi"`. */
export async function describeCompany(companyId: Types.ObjectId | string): Promise<string> {
  try {
    const company = await Company.findById(companyId).select('name').lean();
    return company ? `"${company.name}"` : `company ${String(companyId)}`;
  } catch {
    return `company ${String(companyId)}`;
  }
}

/** e.g. `CHG-DEL-001 connector 1 (driver rahul@demo.in)` */
export async function describeSession(session: SessionLike): Promise<string> {
  try {
    const [charger, driver] = await Promise.all([
      describeChargerId(session.chargerId),
      describeUser(session.userId),
    ]);
    return `${charger} connector ${session.connectorNumber} (driver ${driver})`;
  } catch {
    return `connector ${session.connectorNumber}`;
  }
}

/** Trailing lookup key, e.g. `[session 6ab2f0a40796bd5f6d55aca4]`. */
export function sessionRef(session: { _id: Types.ObjectId | string }): string {
  return `[session ${String(session._id)}]`;
}
