'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';

import { ChargerForm } from '@/components/ChargerForm';
import { RequireAuth } from '@/components/RequireAuth';
import { createCharger, type ChargerInput } from '@/services/charger.service';

function CreateChargerContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const defaultStationId = searchParams.get('stationId') ?? undefined;

  async function handleSubmit(input: ChargerInput) {
    const charger = await createCharger(input);
    router.replace(`/chargers/${charger.id}`);
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-16">
      <header>
        <p className="text-xs font-medium uppercase tracking-widest text-neutral-500">
          EV-CMS &middot; Module 5
        </p>
        <h1 className="mt-1 text-2xl font-semibold">Add charger</h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          Register a charging machine at one of your stations. Add its connectors afterwards
          from the charger&apos;s page.
        </p>
      </header>

      <ChargerForm
        submitLabel="Create charger"
        defaultStationId={defaultStationId}
        onSubmit={handleSubmit}
        onCancel={() => router.push('/chargers')}
      />

      <Link href="/chargers" className="text-sm text-neutral-500 underline underline-offset-4">
        Back to chargers
      </Link>
    </main>
  );
}

export default function CreateChargerPage() {
  return (
    <RequireAuth roles={['super_admin', 'cpo_admin']}>
      <CreateChargerContent />
    </RequireAuth>
  );
}
