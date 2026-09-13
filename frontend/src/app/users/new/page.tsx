'use client';

/**
 * Create a staff account.
 *
 * Replaces the staff form that lived on the company page in Module 2. Only `cpo_admin` and
 * `operator` can be created — drivers self-register, and there is deliberately no way for
 * an admin to create one.
 *
 * A cpo_admin sees no company selector: the server takes the company from their token and
 * refuses any attempt to name a different one.
 */

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

import { FormField } from '@/components/FormField';
import { RequireAuth } from '@/components/RequireAuth';
import { useAuth } from '@/context/AuthContext';
import { useAsyncData } from '@/hooks/useAsyncData';
import { extractFieldErrors, toMessage } from '@/lib/formatApiError';
import { listCompanies } from '@/services/company.service';
import { createStaffUser } from '@/services/user.service';

function CreateUserContent() {
  const { user } = useAuth();
  const router = useRouter();
  const isPlatformAdmin = user?.role === 'super_admin';

  const [form, setForm] = useState({
    name: '', email: '', password: '', phone: '',
    role: 'operator' as 'cpo_admin' | 'operator',
    companyId: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Only a super_admin needs to choose a company.
  const loadCompanies = useCallback(
    () => (isPlatformAdmin ? listCompanies({ status: 'active', limit: 100 }) : Promise.resolve(null)),
    [isPlatformAdmin],
  );
  const { state: companiesState } = useAsyncData(loadCompanies);

  function update(field: 'name' | 'email' | 'password' | 'phone') {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((prev) => ({ ...prev, [field]: e.target.value }));
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setFieldErrors({});

    try {
      await createStaffUser({
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
        role: form.role,
        ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
        ...(isPlatformAdmin && form.companyId ? { companyId: form.companyId } : {}),
      });
      router.replace('/users');
    } catch (caught) {
      setFieldErrors(Object.fromEntries(extractFieldErrors(caught).map((f) => [f.field, f.message])));
      setError(toMessage(caught));
      setIsSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-6 py-16">
      <header>
        <p className="text-xs font-medium uppercase tracking-widest text-neutral-500">
          EV-CMS &middot; Module 3
        </p>
        <h1 className="mt-1 text-2xl font-semibold">Add staff</h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          {isPlatformAdmin
            ? 'Creates a CPO admin or operator for the selected company.'
            : 'Creates an operator in your company. Only a platform admin can create CPO admins.'}
        </p>
      </header>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        {error ? (
          <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        ) : null}

        <FormField label="Full name" name="name" required value={form.name} error={fieldErrors.name} onChange={update('name')} />
        <FormField label="Email" name="email" type="email" required value={form.email} error={fieldErrors.email} onChange={update('email')} />
        <FormField label="Password" name="password" type="password" required hint="At least 8 characters." value={form.password} error={fieldErrors.password} onChange={update('password')} />
        <FormField label="Phone" name="phone" type="tel" hint="Optional." value={form.phone} error={fieldErrors.phone} onChange={update('phone')} />

        <div className="space-y-1.5">
          <label htmlFor="role" className="block text-sm font-medium">Role</label>
          <select
            id="role" value={form.role}
            onChange={(e) => setForm((prev) => ({ ...prev, role: e.target.value as 'cpo_admin' | 'operator' }))}
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700"
          >
            <option value="operator">Operator</option>
            {isPlatformAdmin ? <option value="cpo_admin">CPO Admin</option> : null}
          </select>
        </div>

        {isPlatformAdmin ? (
          <div className="space-y-1.5">
            <label htmlFor="companyId" className="block text-sm font-medium">
              Company<span className="ml-0.5 text-red-500">*</span>
            </label>
            <select
              id="companyId" value={form.companyId} required
              onChange={(e) => setForm((prev) => ({ ...prev, companyId: e.target.value }))}
              className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700"
            >
              <option value="">Select a company…</option>
              {companiesState.status === 'ok' && companiesState.data
                ? companiesState.data.items.map((company) => (
                    <option key={company.id} value={company.id}>{company.name}</option>
                  ))
                : null}
            </select>
            {fieldErrors.companyId ? (
              <p className="text-xs text-red-600 dark:text-red-400">{fieldErrors.companyId}</p>
            ) : null}
          </div>
        ) : null}

        <div className="flex items-center gap-3">
          <button
            type="submit" disabled={isSubmitting}
            className="rounded-lg bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {isSubmitting ? 'Creating…' : 'Create account'}
          </button>
          <Link href="/users" className="text-sm text-neutral-500 underline underline-offset-4">
            Cancel
          </Link>
        </div>
      </form>
    </main>
  );
}

export default function CreateUserPage() {
  return (
    <RequireAuth roles={['super_admin', 'cpo_admin']}>
      <CreateUserContent />
    </RequireAuth>
  );
}
