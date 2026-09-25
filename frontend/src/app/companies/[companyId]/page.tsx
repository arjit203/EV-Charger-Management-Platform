'use client';

/**
 * Company detail — super_admin.
 *
 * Also reachable by a cpo_admin/operator for their OWN company (the backend allows it and
 * returns 403 for anyone else's), which is why the guard here lists all three roles rather
 * than super_admin alone. The server decides; this page just renders what it gets back.
 */

import { useCallback, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

import { CompanyForm } from '@/components/CompanyForm';
import { FormField } from '@/components/FormField';
import { RequireAuth } from '@/components/RequireAuth';
import { StatusBadge } from '@/components/StatusBadge';
import { useAuth } from '@/context/AuthContext';
import { useAsyncData } from '@/hooks/useAsyncData';
import { extractFieldErrors, toMessage } from '@/lib/formatApiError';
import {
  getCompany,
  setCompanyStatus,
  updateCompany,
  type CompanyInput,
} from '@/services/company.service';
import { createStaffUser } from '@/services/user.service';
import { COMPANY_TYPE_LABELS, ROLE_LABELS, type Company } from '@/types/api';
import { buttonClasses } from '@/components/ui/Button';
import { formatDateTime } from '@/lib/datetime';
import { LoadError } from '@/components/ui/LoadError';

/* ------------------------------------------------------------------ staff -- */

function AddStaffForm({ companyId, onCreated }: { companyId: string; onCreated: () => void }) {
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'operator' as 'cpo_admin' | 'operator' });
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function update(field: 'name' | 'email' | 'password') {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((prev) => ({ ...prev, [field]: e.target.value }));
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setFieldErrors({});
    setCreated(null);

    try {
      // Module 3: staff creation moved to POST /users. The company is still explicit,
      // because a super_admin may create staff for any company.
      const user = await createStaffUser({
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
        role: form.role,
        companyId,
      });
      setCreated(`${user.email} created as ${ROLE_LABELS[user.role]}`);
      setForm({ name: '', email: '', password: '', role: 'operator' });
      onCreated();
    } catch (caught) {
      setFieldErrors(Object.fromEntries(extractFieldErrors(caught).map((f) => [f.field, f.message])));
      setError(toMessage(caught));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <p className="text-xs text-neutral-500">
        Creates a company-scoped account. Only <code className="font-mono">cpo_admin</code> and{' '}
        <code className="font-mono">operator</code> can be created here — the API rejects any other
        role. Drivers self-register and are never created by an admin.
      </p>

      {error ? (
        <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">{error}</p>
      ) : null}
      {created ? (
        <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">{created}</p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Full name" name="staffName" required value={form.name} error={fieldErrors.name} onChange={update('name')} />
        <FormField label="Email" name="staffEmail" type="email" required value={form.email} error={fieldErrors.email} onChange={update('email')} />
        <FormField label="Password" name="staffPassword" type="password" required hint="At least 8 characters." value={form.password} error={fieldErrors.password} onChange={update('password')} />
        <div className="space-y-1.5">
          <label htmlFor="staffRole" className="block text-sm font-medium">Role</label>
          <select
            id="staffRole" value={form.role}
            onChange={(e) => setForm((prev) => ({ ...prev, role: e.target.value as 'cpo_admin' | 'operator' }))}
            className="w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700"
          >
            <option value="operator">Operator</option>
            <option value="cpo_admin">CPO Admin</option>
          </select>
        </div>
      </div>

      <button
        type="submit" disabled={isSubmitting}
        className={buttonClasses('primary', 'md')}
      >
        {isSubmitting ? 'Creating…' : 'Add staff member'}
      </button>
    </form>
  );
}

/* ----------------------------------------------------------------- detail -- */

function CompanyDetails({ company, canManage, onChanged }: {
  company: Company;
  canManage: boolean;
  onChanged: (company: Company) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [showStaff, setShowStaff] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isToggling, setIsToggling] = useState(false);

  async function toggleStatus() {
    setIsToggling(true);
    setActionError(null);
    try {
      onChanged(await setCompanyStatus(company.id, company.status === 'active' ? 'suspended' : 'active'));
    } catch (caught) {
      setActionError(toMessage(caught));
    } finally {
      setIsToggling(false);
    }
  }

  async function handleUpdate(input: CompanyInput) {
    onChanged(await updateCompany(company.id, input));
    setIsEditing(false);
  }

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-widest text-neutral-500">
            Company
          </p>
          <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight">{company.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusBadge tone={company.status === 'active' ? 'good' : 'bad'} label={company.status} />
            <StatusBadge tone="neutral" label={company.type} />
          </div>
        </div>

        {canManage ? (
          <div className="flex gap-2">
            {!isEditing ? (
              <button
                type="button" onClick={() => setIsEditing(true)}
                className={buttonClasses('secondary')}
              >
                Edit
              </button>
            ) : null}
            <button
              type="button" onClick={() => void toggleStatus()} disabled={isToggling}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 ${
                company.status === 'active' ? 'bg-red-600' : 'bg-emerald-600'
              }`}
            >
              {isToggling ? 'Working…' : company.status === 'active' ? 'Suspend' : 'Activate'}
            </button>
          </div>
        ) : null}
      </header>

      {actionError ? (
        <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">{actionError}</p>
      ) : null}

      {company.status === 'suspended' ? (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          While suspended, this company&apos;s staff can still sign in, but every company-scoped
          request is refused with <code className="font-mono">COMPANY_SUSPENDED</code>. Enforcement is
          live — existing tokens stop working immediately.
        </p>
      ) : null}

      <section className="rounded-xl border border-neutral-200 bg-[var(--surface)] p-5 dark:border-neutral-800">
        {isEditing ? (
          <CompanyForm
            initial={company}
            submitLabel="Save changes"
            onSubmit={handleUpdate}
            onCancel={() => setIsEditing(false)}
          />
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-neutral-500">Legal name</dt>
            <dd>{company.legalName ?? '—'}</dd>
            <dt className="text-neutral-500">Type</dt>
            <dd className="text-xs">{COMPANY_TYPE_LABELS[company.type]}</dd>
            <dt className="text-neutral-500">Email</dt>
            <dd className="font-mono text-xs">{company.contactEmail ?? '—'}</dd>
            <dt className="text-neutral-500">Phone</dt>
            <dd className="font-mono text-xs">{company.contactPhone ?? '—'}</dd>
            <dt className="text-neutral-500">Address</dt>
            <dd className="text-xs">
              {company.address
                ? [company.address.line1, company.address.city, company.address.state, company.address.postalCode, company.address.country]
                    .filter(Boolean).join(', ')
                : '—'}
            </dd>
            <dt className="text-neutral-500">Created</dt>
            <dd className="text-xs">{formatDateTime(company.createdAt)}</dd>
          </dl>
        )}
      </section>

      {canManage ? (
        <section className="rounded-xl border border-neutral-200 bg-[var(--surface)] p-5 dark:border-neutral-800">
          <button
            type="button" onClick={() => setShowStaff((v) => !v)}
            className="flex w-full items-center justify-between text-sm font-semibold"
          >
            Add a staff member
            <span className="text-neutral-400">{showStaff ? '−' : '+'}</span>
          </button>
          {showStaff ? (
            <div className="mt-4">
              <AddStaffForm companyId={company.id} onCreated={() => undefined} />
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

function CompanyDetailContent() {
  const params = useParams<{ companyId: string }>();
  const { user } = useAuth();
  const companyId = params.companyId;

  const load = useCallback(() => getCompany(companyId), [companyId]);
  const { state, setData } = useAsyncData(load);

  const canManage = user?.role === 'super_admin';

  return (
    <main className="page page-detail">
      {state.status === 'loading' ? (
        <p className="text-sm text-neutral-500">Loading company&hellip;</p>
      ) : state.status === 'error' ? (
        <LoadError error={state.error} noun="company" backHref="/companies" backLabel="Back to companies" />
      ) : (
        <CompanyDetails company={state.data} canManage={canManage} onChanged={setData} />
      )}

      {canManage && (
        <Link href="/companies" className="text-sm text-neutral-500 underline underline-offset-4">
          Back to companies
        </Link>
      )}
    </main>
  );
}

export default function CompanyDetailPage() {
  return (
    <RequireAuth roles={['super_admin', 'cpo_admin', 'operator']}>
      <CompanyDetailContent />
    </RequireAuth>
  );
}
