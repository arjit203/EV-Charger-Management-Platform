/**
 * Tariff business logic.
 *
 * Company scoping is unchanged from Module 2: the `companyId` used for authorisation comes from
 * the verified actor, never from the request. A cpo_admin creating a tariff does not get to say
 * which company it belongs to — the server copies it from their own account.
 */

import mongoose, { Types } from 'mongoose';

import { Tariff, toPublicTariff, type PublicTariff, type TariffDocument } from '../models/tariff.model';
import { Company } from '../models/company.model';
import { ROLES } from '../constants/roles';
import type { TariffStatus } from '../constants/tariff';
import { ApiError } from '../utils/ApiError';
import { applyCompanyScope, resolveCompanyScope } from '../utils/companyScope';
import { logger } from '../utils/logger';
import { describeCompany } from '../utils/logLabels';
import { formatPaise } from '../utils/money';
import type { Paginated } from '../types/pagination';
import type { AuthUser } from '../types/express';
import type { CreateTariffInput, ListTariffsQuery, UpdateTariffInput } from '../validators/tariff.validator';

const SCOPE = 'tariff';
const DUPLICATE_KEY = 11000;

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(error) && (error as { code?: number }).code === DUPLICATE_KEY;
}

/** 403 for company-scoped callers even on ids that do not exist, so ids cannot be probed. */
function notFoundOrForbidden(actor: AuthUser): ApiError {
  return actor.role === ROLES.SUPER_ADMIN
    ? ApiError.notFound('Tariff not found.')
    : ApiError.forbidden('You can only access tariffs belonging to your own company.');
}

/**
 * Which company a new tariff belongs to.
 *
 * super_admin must say (they have no company of their own); everyone else gets their own, and
 * supplying one is a visible 422 rather than a silent strip — see the note below.
 */
async function resolveTargetCompany(actor: AuthUser, requested: string | undefined): Promise<Types.ObjectId> {
  if (actor.role === ROLES.SUPER_ADMIN) {
    if (!requested) throw ApiError.validation('companyId is required when creating a tariff as a platform admin.');

    const company = await Company.findById(requested).select('_id');
    if (!company) throw ApiError.notFound('Company not found.');

    return company._id;
  }

  /*
   * A company-scoped caller supplying `companyId` is REJECTED, not ignored.
   *
   * Ignoring it would be safe — their company comes from their verified account either way —
   * but it would also be silent. The `.strict()` convention since Module 2 exists so that an
   * attempt to write into another company shows up as a 422 in the logs rather than as a
   * successful-looking 201. Zod cannot enforce this alone because the field's legality depends
   * on the caller's role, which the schema cannot see.
   */
  if (requested) {
    throw ApiError.validation(
      'companyId cannot be set: a tariff always belongs to your own company.',
      { field: 'companyId' },
    );
  }

  const scope = resolveCompanyScope(actor); // throws 403 if a scoped role has no company
  return new Types.ObjectId(scope.companyId as string);
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

export async function createTariff(actor: AuthUser, input: CreateTariffInput): Promise<PublicTariff> {
  const companyId = await resolveTargetCompany(actor, input.companyId);

  // Created inactive. Activation is a separate, deliberate act because it changes what every
  // future charge at this company costs.
  const tariff = await Tariff.create({
    companyId,
    name: input.name,
    pricePerKwhPaise: input.pricePerKwhPaise,
    status: 'inactive',
    createdBy: new Types.ObjectId(actor.id),
  });

  logger.info(
    SCOPE,
    `${actor.email} created tariff "${tariff.name}" (${formatPaise(tariff.pricePerKwhPaise)}/kWh, not active yet) ` +
      `for ${await describeCompany(companyId)}`,
  );

  return toPublicTariff(tariff);
}

async function assertTariffInScope(actor: AuthUser, tariffId: string): Promise<TariffDocument> {
  const tariff = await Tariff.findOne(applyCompanyScope(actor, { _id: tariffId }));
  if (!tariff) throw notFoundOrForbidden(actor);
  return tariff;
}

/**
 * Edit a tariff, including one that is currently active.
 *
 * Editing an active rate is ALLOWED and safe, which is worth stating because it looks dangerous.
 * Sessions already running snapshotted their rate at start (see `appliedPricePerKwhPaise`), so
 * an edit cannot reprice a charge in progress. It only changes what the NEXT session costs.
 */
export async function updateTariff(
  actor: AuthUser,
  tariffId: string,
  input: UpdateTariffInput,
): Promise<PublicTariff> {
  const tariff = await assertTariffInScope(actor, tariffId);

  tariff.set(input);
  await tariff.save();

  return toPublicTariff(tariff);
}

/**
 * Activate or deactivate.
 *
 * ACTIVATION IS A SWAP, AND THE ORDER MATTERS. The incumbent is deactivated first, then the new
 * one activated — the reverse order would momentarily leave two active tariffs, which the
 * partial unique index refuses outright.
 *
 * Both writes run in a transaction so the company can never be left with zero tariffs because
 * the second write failed. MongoDB transactions need a replica set; Atlas provides one. If the
 * deployment cannot support them the operation FAILS rather than silently half-applying.
 */
export async function setTariffStatus(
  actor: AuthUser,
  tariffId: string,
  status: TariffStatus,
): Promise<PublicTariff> {
  const tariff = await assertTariffInScope(actor, tariffId);

  if (tariff.status === status) return toPublicTariff(tariff);

  if (status === 'inactive') {
    /*
     * MODULE 10 (D13) — REFUSE to leave a company with no price at all.
     *
     * Module 9 only warned about this in the UI. That was defensible while a missing tariff
     * merely blocked new sessions; it stopped being defensible once money depends on it. With
     * Module 10 the blast radius is wider: every future charge at this company stops, AND any
     * session still awaiting settlement has no rate to be collected against.
     *
     * Note what this does NOT block: the activate-a-replacement SWAP. That path deactivates the
     * incumbent inside `withTransaction` below, never through here, so changing your rates is
     * unaffected. Only a bare deactivation that would leave zero active tariffs is refused.
     */
    const otherActive = await Tariff.countDocuments({
      companyId: tariff.companyId,
      status: 'active',
      _id: { $ne: tariff._id },
    });

    if (otherActive === 0) {
      throw ApiError.conflict(
        'This is your only active tariff. Activate a replacement instead of deactivating it — ' +
          'without a price, drivers cannot charge at your stations.',
        { tariffId: String(tariff._id) },
      );
    }

    tariff.status = 'inactive';
    await tariff.save();
    return toPublicTariff(tariff);
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await Tariff.updateOne(
        { companyId: tariff.companyId, status: 'active' },
        { $set: { status: 'inactive' } },
        { session },
      );

      await Tariff.updateOne({ _id: tariff._id }, { $set: { status: 'active' } }, { session });
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      // The index caught a concurrent activation. Two admins pressed the button at once.
      throw ApiError.conflict('Another tariff was activated at the same moment. Please retry.');
    }
    throw error;
  } finally {
    await session.endSession();
  }

  const updated = await Tariff.findById(tariff._id);
  if (!updated) throw ApiError.notFound('Tariff not found.');

  logger.info(
    SCOPE,
    `${actor.email} made tariff "${updated.name}" (${formatPaise(updated.pricePerKwhPaise)}/kWh) the active ` +
      `price for ${await describeCompany(updated.companyId)} — new sessions will use it`,
  );

  return toPublicTariff(updated);
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export async function listTariffs(
  actor: AuthUser,
  query: ListTariffsQuery,
): Promise<Paginated<PublicTariff>> {
  const filter: Record<string, unknown> = {};

  if (query.status) filter.status = query.status;

  // Honoured for super_admin only; everyone else is already pinned by the scope below.
  if (query.companyId && actor.role === ROLES.SUPER_ADMIN) {
    filter.companyId = new Types.ObjectId(query.companyId);
  }

  const scoped = applyCompanyScope(actor, filter);

  const page = query.page ?? 1;
  const limit = query.limit ?? 20;

  const [items, total] = await Promise.all([
    Tariff.find(scoped).sort({ status: 1, updatedAt: -1 }).skip((page - 1) * limit).limit(limit),
    Tariff.countDocuments(scoped),
  ]);

  return {
    items: items.map(toPublicTariff),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

export async function getTariffById(actor: AuthUser, tariffId: string): Promise<PublicTariff> {
  return toPublicTariff(await assertTariffInScope(actor, tariffId));
}

/* -------------------------------------------------------------------------- */
/* Resolution — used by Module 7's session start                              */
/* -------------------------------------------------------------------------- */

/**
 * The tariff in force for a company right now, or null.
 *
 * NOT actor-scoped: the caller is the session service acting on behalf of a DRIVER, who belongs
 * to no company and is charging at someone else's station. Applying company scoping here would
 * make it impossible for anyone to charge anywhere.
 *
 * Deterministic by construction — the partial unique index guarantees at most one row can match.
 */
export async function findActiveTariffForCompany(
  companyId: Types.ObjectId | string,
): Promise<TariffDocument | null> {
  return Tariff.findOne({ companyId, status: 'active' });
}
