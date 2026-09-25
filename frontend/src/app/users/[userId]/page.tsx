'use client';

import { useCallback, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

import { FormField } from '@/components/FormField';
import { RequireAuth } from '@/components/RequireAuth';
import { StatusBadge } from '@/components/StatusBadge';
import { useAuth } from '@/context/AuthContext';
import { useAsyncData } from '@/hooks/useAsyncData';
import { toMessage } from '@/lib/formatApiError';
import { getUser, setUserStatus, updateUser } from '@/services/user.service';
import { ROLE_LABELS, type User } from '@/types/api';
import { buttonClasses } from '@/components/ui/Button';
import { formatDateTime } from '@/lib/datetime';
import { LoadError } from '@/components/ui/LoadError';

function UserDetails({ user, onChanged }: { user: User; onChanged: (user: User) => void }) {
  const { user: me } = useAuth();
  const [isEditing, setIsEditing] = useState(false);
  const [form, setForm] = useState({ name: user.name, phone: user.phone ?? '' });
  const [actionError, setActionError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const isSelf = me?.id === user.id;

  async function toggleStatus() {
    setIsBusy(true);
    setActionError(null);
    try {
      onChanged(await setUserStatus(user.id, user.status === 'active' ? 'suspended' : 'active'));
    } catch (caught) {
      setActionError(toMessage(caught));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsBusy(true);
    setActionError(null);
    try {
      onChanged(
        await updateUser(user.id, {
          name: form.name.trim(),
          ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
        }),
      );
      setIsEditing(false);
    } catch (caught) {
      setActionError(toMessage(caught));
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-widest text-neutral-500">
            User
          </p>
          <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight">{user.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusBadge tone="neutral" label={ROLE_LABELS[user.role]} />
            <StatusBadge tone={user.status === 'active' ? 'good' : 'bad'} label={user.status} />
          </div>
        </div>

        <div className="flex gap-2">
          {!isEditing ? (
            <button
              type="button" onClick={() => setIsEditing(true)}
              className={buttonClasses('secondary')}
            >
              Edit
            </button>
          ) : null}
          {/* Suspending yourself would lock you out instantly — the API refuses it too. */}
          {!isSelf ? (
            <button
              type="button" onClick={() => void toggleStatus()} disabled={isBusy}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 ${
                user.status === 'active' ? 'bg-red-600' : 'bg-emerald-600'
              }`}
            >
              {isBusy ? 'Working…' : user.status === 'active' ? 'Suspend' : 'Activate'}
            </button>
          ) : null}
        </div>
      </header>

      {actionError ? (
        <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          {actionError}
        </p>
      ) : null}

      {isSelf ? (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          This is your own account. You cannot change your own status.
        </p>
      ) : null}

      <section className="rounded-xl border border-neutral-200 bg-[var(--surface)] p-5 dark:border-neutral-800">
        {isEditing ? (
          <form onSubmit={handleSave} className="space-y-4" noValidate>
            <p className="text-xs text-neutral-500">
              Only name and phone can be edited. Role, company and email are not changeable here —
              the API rejects them.
            </p>
            <FormField
              label="Full name" name="name" required value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
            />
            <FormField
              label="Phone" name="phone" type="tel" value={form.phone}
              onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))}
            />
            <div className="flex gap-3">
              <button
                type="submit" disabled={isBusy}
                className={buttonClasses('primary', 'md')}
              >
                {isBusy ? 'Saving…' : 'Save changes'}
              </button>
              <button
                type="button" onClick={() => setIsEditing(false)}
                className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium dark:border-neutral-700"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-neutral-500">Email</dt>
            <dd className="font-mono text-xs">{user.email}</dd>
            <dt className="text-neutral-500">Phone</dt>
            <dd className="font-mono text-xs">{user.phone ?? '—'}</dd>
            <dt className="text-neutral-500">Role</dt>
            <dd className="font-mono text-xs">{user.role}</dd>
            <dt className="text-neutral-500">Company</dt>
            <dd className="font-mono text-xs">
              {user.companyId ?? (user.role === 'driver' ? 'none (drivers belong to no company)' : 'none')}
            </dd>
            <dt className="text-neutral-500">Last login</dt>
            <dd className="text-xs">
              {user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'never'}
            </dd>
            <dt className="text-neutral-500">Joined</dt>
            <dd className="text-xs">{formatDateTime(user.createdAt)}</dd>
          </dl>
        )}
      </section>
    </>
  );
}

function UserDetailContent() {
  const params = useParams<{ userId: string }>();
  const userId = params.userId;

  const load = useCallback(() => getUser(userId), [userId]);
  const { state, setData } = useAsyncData(load);

  return (
    <main className="page page-detail">
      {state.status === 'loading' ? (
        <p className="text-sm text-neutral-500">Loading user&hellip;</p>
      ) : state.status === 'error' ? (
        <LoadError error={state.error} noun="user" backHref="/users" backLabel="Back to users" />
      ) : (
        <UserDetails user={state.data} onChanged={setData} />
      )}

      <Link href="/users" className="text-sm text-neutral-500 underline underline-offset-4">
        Back to users
      </Link>
    </main>
  );
}

export default function UserDetailPage() {
  return (
    <RequireAuth roles={['super_admin', 'cpo_admin']}>
      <UserDetailContent />
    </RequireAuth>
  );
}
