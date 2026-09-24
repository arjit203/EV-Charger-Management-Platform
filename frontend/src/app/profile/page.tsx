'use client';

/**
 * Your own profile — available to every role.
 *
 * Reads from `AuthContext`, which already holds the result of `/auth/me`; there is no
 * `GET /users/me`, because that would be a second endpoint returning identical data.
 *
 * Only name and phone are editable. Role, company, status and email are rejected by the
 * API with a 422 — a driver cannot promote themselves or move into a company.
 */

import { useState } from 'react';
import Link from 'next/link';

import { FormField } from '@/components/FormField';
import { RequireAuth } from '@/components/RequireAuth';
import { StatusBadge } from '@/components/StatusBadge';
import { useAuth } from '@/context/AuthContext';
import { extractFieldErrors, toMessage } from '@/lib/formatApiError';
import { updateMyProfile } from '@/services/user.service';
import { ROLE_LABELS } from '@/types/api';
import { buttonClasses } from '@/components/ui/Button';

function ProfileContent() {
  const { user, updateCurrentUser } = useAuth();

  const [form, setForm] = useState({ name: user?.name ?? '', phone: user?.phone ?? '' });
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!user) return null; // RequireAuth guarantees this

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setFieldErrors({});
    setSaved(false);

    try {
      const updated = await updateMyProfile({
        name: form.name.trim(),
        ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
      });
      updateCurrentUser(updated);
      setSaved(true);
    } catch (caught) {
      setFieldErrors(Object.fromEntries(extractFieldErrors(caught).map((f) => [f.field, f.message])));
      setError(toMessage(caught));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-6 py-16">
      <header>
        <p className="text-xs font-medium uppercase tracking-widest text-neutral-500">
          EV-CMS
        </p>
        <h1 className="mt-1 text-2xl font-semibold">My profile</h1>
      </header>

      <section className="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone="neutral" label={ROLE_LABELS[user.role]} />
          <StatusBadge tone={user.status === 'active' ? 'good' : 'bad'} label={user.status} />
        </div>

        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-neutral-500">Email</dt>
          <dd className="font-mono text-xs">{user.email}</dd>
          <dt className="text-neutral-500">Member since</dt>
          <dd className="text-xs">{new Date(user.createdAt).toLocaleDateString()}</dd>
        </dl>

        <p className="mt-3 text-xs text-neutral-500">
          Email, role and company are not editable here. Contact an administrator if they need
          to change.
        </p>
      </section>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        {error ? (
          <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        ) : null}
        {saved ? (
          <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
            Profile updated.
          </p>
        ) : null}

        <FormField
          label="Full name" name="name" required value={form.name} error={fieldErrors.name}
          onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
        />
        <FormField
          label="Phone" name="phone" type="tel" hint="Optional." value={form.phone} error={fieldErrors.phone}
          onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))}
        />

        <button
          type="submit" disabled={isSubmitting}
          className={buttonClasses('primary', 'md')}
        >
          {isSubmitting ? 'Saving…' : 'Save changes'}
        </button>
      </form>

      <Link href="/dashboard" className="text-sm text-neutral-500 underline underline-offset-4">
        Back to dashboard
      </Link>
    </main>
  );
}

export default function ProfilePage() {
  return (
    <RequireAuth>
      <ProfileContent />
    </RequireAuth>
  );
}
