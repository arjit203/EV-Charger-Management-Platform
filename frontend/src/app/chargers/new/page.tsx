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
    const { charger, authToken } = await createCharger(input);
    // The OCPP token is returned exactly once. Carry it in the URL so the detail page can
    // show it immediately — after this it can only be regenerated, never retrieved.
    router.replace(`/chargers/${charger.id}?newToken=${encodeURIComponent(authToken)}`);
  }

  return (
    <main className="page page-form">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Add charger</h1>
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
