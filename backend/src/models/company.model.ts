/**
 * Company — the owner of everything physical and financial in the CPMS.
 *
 * From Module 4 onward, Station -> Charger -> Connector -> ChargingSession all trace back
 * to exactly one Company. That is what makes "whose revenue is this?" and "who may suspend
 * this charger?" answerable questions.
 *
 * MVP scope, locked: identity, contact, address, type and status. Deliberately NOT here —
 * SaaS licensing, deal management, subscription billing, per-charger license cost, SaaS fee
 * percentages, payout configuration. Those belong to a software vendor selling to CPOs, not
 * to a CPO running its own network.
 */

import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

import {
  COMPANY_STATUSES,
  COMPANY_TYPES,
  type CompanyStatus,
  type CompanyType,
} from '../constants/company';

export interface ICompanyAddress {
  line1?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
}

export interface ICompany {
  name: string;
  legalName?: string;
  type: CompanyType;
  contactEmail?: string;
  contactPhone?: string;
  address?: ICompanyAddress;
  status: CompanyStatus;
  /** Which super_admin created this company. Cheap audit trail. */
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export type CompanyModel = Model<ICompany>;

const addressSchema = new Schema<ICompanyAddress>(
  {
    line1: { type: String, trim: true, maxlength: 200 },
    city: { type: String, trim: true, maxlength: 100 },
    state: { type: String, trim: true, maxlength: 100 },
    country: { type: String, trim: true, maxlength: 100 },
    postalCode: { type: String, trim: true, maxlength: 20 },
  },
  { _id: false },
);

const companySchema = new Schema<ICompany, CompanyModel>(
  {
    name: {
      type: String,
      required: true,
      unique: true, // creates the index — do not also set `index: true`
      trim: true,
      minlength: 2,
      maxlength: 120,
    },

    legalName: { type: String, trim: true, maxlength: 200 },

    type: { type: String, enum: COMPANY_TYPES, required: true, default: 'CPO', index: true },

    contactEmail: { type: String, trim: true, lowercase: true, maxlength: 254 },
    contactPhone: { type: String, trim: true, maxlength: 20 },

    address: { type: addressSchema, default: undefined },

    status: { type: String, enum: COMPANY_STATUSES, required: true, default: 'active', index: true },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

// Supports the filtered list view (?type=CPO&status=active) on the admin screen.
companySchema.index({ type: 1, status: 1 });

export const Company = model<ICompany, CompanyModel>('Company', companySchema);

export type CompanyDocument = HydratedDocument<ICompany>;

/**
 * The company shape the API may return — an explicit allow-list, for the same reason
 * `toPublicUser` is one: anything added to the schema later is private by default rather
 * than leaking automatically.
 */
export interface PublicCompany {
  id: string;
  name: string;
  legalName: string | null;
  type: CompanyType;
  contactEmail: string | null;
  contactPhone: string | null;
  address: Required<ICompanyAddress> | null;
  status: CompanyStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export function toPublicCompany(company: CompanyDocument): PublicCompany {
  return {
    id: String(company._id),
    name: company.name,
    legalName: company.legalName ?? null,
    type: company.type,
    contactEmail: company.contactEmail ?? null,
    contactPhone: company.contactPhone ?? null,
    address: company.address
      ? {
          line1: company.address.line1 ?? '',
          city: company.address.city ?? '',
          state: company.address.state ?? '',
          country: company.address.country ?? '',
          postalCode: company.address.postalCode ?? '',
        }
      : null,
    status: company.status,
    createdBy: String(company.createdBy),
    createdAt: company.createdAt.toISOString(),
    updatedAt: company.updatedAt.toISOString(),
  };
}
