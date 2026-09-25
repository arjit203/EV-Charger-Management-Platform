'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';

import { RequireAuth } from '@/components/RequireAuth';
import { StationForm } from '@/components/StationForm';
import { useAuth } from '@/context/AuthContext';
import { createStation, type StationInput } from '@/services/station.service';

function CreateStationContent() {
  const { user } = useAuth();
  const router = useRouter();
  const isPlatformAdmin = user?.role === 'super_admin';

  async function handleSubmit(input: StationInput) {
    const station = await createStation(input);
    router.replace(`/stations/${station.id}`);
  }

  return (
    <main className="page page-form">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">New station</h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          {isPlatformAdmin
            ? 'A site belonging to the company you select.'
            : 'A site belonging to your company. Stations start active.'}
        </p>
      </header>

      <StationForm
        submitLabel="Create station"
        showCompanySelector={isPlatformAdmin}
        onSubmit={handleSubmit}
        onCancel={() => router.push('/stations')}
      />

      <Link href="/stations" className="text-sm text-neutral-500 underline underline-offset-4">
        Back to stations
      </Link>
    </main>
  );
}

export default function CreateStationPage() {
  return (
    <RequireAuth roles={['super_admin', 'cpo_admin']}>
      <CreateStationContent />
    </RequireAuth>
  );
}
