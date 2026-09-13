'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

import { RequireAuth } from '@/components/RequireAuth';
import { TariffForm } from '@/components/TariffForm';
import { useAuth } from '@/context/AuthContext';
import { useAsyncData } from '@/hooks/useAsyncData';
import { toMessage } from '@/lib/formatApiError';
import { listCompanies } from '@/services/company.service';
import { createTariff, type TariffInput } from '@/services/tariff.service';

function NewTariffContent() {
  const router = useRouter();
  const { user } = useAuth();
  const isPlatformAdmin = user?.role === 'super_admin';

  /*
   * Only super_admin picks a company — they have none of their own. For a cpo_admin the field
   * is not merely hidden, it is never sent: the server rejects a companyId from a scoped caller
   * with a 422, treating it as a visible escalation attempt rather than silently ignoring it.
   */
  const load = useCallback(
    async () => (isPlatformAdmin ? (await listCompanies({ limit: 100 })).items : []),
    [isPlatformAdmin],
  );
  const { state } = useAsyncData(load);

  const [companyId, setCompanyId] = useState('');

  async function submit(input: TariffInput) {
    const tariff = await createTariff(
      isPlatformAdmin ? { ...input, companyId: companyId || undefined } : input,
    );
    router.push(`/tariffs/${tariff.id}`);
  }

  return (
    <main className="mx-auto max-w-lg px-6 py-12">
      <h1 className="text-2xl font-semibold">New tariff</h1>
      <p className="mt-1 text-sm text-neutral-500">
        A price sheet for a whole company — it applies to every station that company operates.
      </p>

      <div className="mt-8 space-y-4">
        {isPlatformAdmin && state.status === 'error' && (
          <p className="rounded-lg bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-400">
            {toMessage(state.error)}
          </p>
        )}

        {isPlatformAdmin && state.status === 'ok' && (
          <label className="block text-sm">
            <span className="block font-medium">
              Company<span className="ml-0.5 text-red-500">*</span>
            </span>
            <select
              value={companyId}
              onChange={(event) => setCompanyId(event.target.value)}
              className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700"
            >
              <option value="">Select a company…</option>
              {state.data.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-neutral-500">
              Which operator&apos;s price sheet this is.
            </span>
          </label>
        )}

        <TariffForm
          submitLabel="Create tariff"
          onSubmit={submit}
          onCancel={() => router.back()}
        />
      </div>

      <Link
        href="/tariffs"
        className="mt-8 inline-block text-sm text-neutral-500 underline underline-offset-4"
      >
        All tariffs
      </Link>
    </main>
  );
}

export default function NewTariffPage() {
  return (
    <RequireAuth roles={['super_admin', 'cpo_admin']}>
      <NewTariffContent />
    </RequireAuth>
  );
}
