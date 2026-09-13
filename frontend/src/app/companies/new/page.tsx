'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';

import { CompanyForm } from '@/components/CompanyForm';
import { RequireAuth } from '@/components/RequireAuth';
import { createCompany, type CompanyInput } from '@/services/company.service';

function CreateCompanyContent() {
  const router = useRouter();

  async function handleSubmit(input: CompanyInput) {
    const company = await createCompany(input);
    router.replace(`/companies/${company.id}`);
  }

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-6 py-16">
      <header>
        <p className="text-xs font-medium uppercase tracking-widest text-neutral-500">
          EV-CMS &middot; Module 2
        </p>
        <h1 className="mt-1 text-2xl font-semibold">New company</h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          Companies start active. You can suspend one later from its detail page.
        </p>
      </header>

      <CompanyForm
        submitLabel="Create company"
        onSubmit={handleSubmit}
        onCancel={() => router.push('/companies')}
      />

      <Link href="/companies" className="text-sm text-neutral-500 underline underline-offset-4">
        Back to companies
      </Link>
    </main>
  );
}

export default function CreateCompanyPage() {
  return (
    <RequireAuth roles={['super_admin']}>
      <CreateCompanyContent />
    </RequireAuth>
  );
}
