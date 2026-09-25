'use client';

/**
 * Shared create/edit form for a company.
 *
 * Note there is no `status` control here. Status is changed only through the dedicated
 * activate/suspend action, mirroring the backend where the general update schema rejects a
 * `status` field outright — so a stale form value can never suspend a company by accident.
 */

import { useState } from 'react';

import { FormField } from '@/components/FormField';
import { extractFieldErrors, toMessage } from '@/lib/formatApiError';
import type { CompanyInput } from '@/services/company.service';
import { COMPANY_TYPE_LABELS, type Company, type CompanyType } from '@/types/api';
import { buttonClasses } from '@/components/ui/Button';

const TYPES = Object.keys(COMPANY_TYPE_LABELS) as CompanyType[];

interface CompanyFormProps {
  initial?: Company;
  submitLabel: string;
  onSubmit: (input: CompanyInput) => Promise<void>;
  onCancel?: () => void;
}

export function CompanyForm({ initial, submitLabel, onSubmit, onCancel }: CompanyFormProps) {
  const [form, setForm] = useState({
    name: initial?.name ?? '',
    legalName: initial?.legalName ?? '',
    type: initial?.type ?? ('CPO' as CompanyType),
    contactEmail: initial?.contactEmail ?? '',
    contactPhone: initial?.contactPhone ?? '',
    line1: initial?.address?.line1 ?? '',
    city: initial?.address?.city ?? '',
    state: initial?.address?.state ?? '',
    country: initial?.address?.country ?? '',
    postalCode: initial?.address?.postalCode ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  function update(field: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((prev) => ({ ...prev, [field]: e.target.value }));
  }

  /** Omit empty optional fields entirely — "" would fail the backend's min-length rules. */
  function buildInput(): CompanyInput {
    const address: Record<string, string> = {};
    for (const key of ['line1', 'city', 'state', 'country', 'postalCode'] as const) {
      if (form[key].trim()) address[key] = form[key].trim();
    }

    return {
      name: form.name.trim(),
      type: form.type,
      ...(form.legalName.trim() ? { legalName: form.legalName.trim() } : {}),
      ...(form.contactEmail.trim() ? { contactEmail: form.contactEmail.trim() } : {}),
      ...(form.contactPhone.trim() ? { contactPhone: form.contactPhone.trim() } : {}),
      ...(Object.keys(address).length ? { address } : {}),
    };
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setFieldErrors({});

    try {
      await onSubmit(buildInput());
    } catch (caught) {
      const fields = extractFieldErrors(caught);
      // Backend paths look like "address.city"; show them on the matching input.
      setFieldErrors(
        Object.fromEntries(fields.map((f) => [f.field.replace('address.', ''), f.message])),
      );
      setError(toMessage(caught));
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5" noValidate>
      {error ? (
        <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}

      <div className="space-y-4">
        <FormField
          label="Company name" name="name" required
          value={form.name} error={fieldErrors.name} onChange={update('name')}
        />
        <FormField
          label="Legal / registered name" name="legalName" hint="Optional."
          value={form.legalName} error={fieldErrors.legalName} onChange={update('legalName')}
        />

        <div className="space-y-1.5">
          <label htmlFor="type" className="block text-sm font-medium">Type</label>
          <select
            id="type" name="type" value={form.type}
            onChange={(e) => setForm((prev) => ({ ...prev, type: e.target.value as CompanyType }))}
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500 focus:ring-2 focus:ring-neutral-900/20 dark:border-neutral-700 dark:focus:ring-white/20"
          >
            {TYPES.map((type) => (
              <option key={type} value={type}>{COMPANY_TYPE_LABELS[type]}</option>
            ))}
          </select>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Contact email" name="contactEmail" type="email" hint="Optional."
            value={form.contactEmail} error={fieldErrors.contactEmail} onChange={update('contactEmail')}
          />
          <FormField
            label="Contact phone" name="contactPhone" type="tel" hint="Optional."
            value={form.contactPhone} error={fieldErrors.contactPhone} onChange={update('contactPhone')}
          />
        </div>
      </div>

      <fieldset className="space-y-4 rounded-xl border border-neutral-200 bg-[var(--surface)] p-4 dark:border-neutral-800">
        <legend className="px-1 text-xs font-medium uppercase tracking-widest text-neutral-500">
          Address
        </legend>
        <FormField label="Street" name="line1" value={form.line1} error={fieldErrors.line1} onChange={update('line1')} />
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="City" name="city" value={form.city} error={fieldErrors.city} onChange={update('city')} />
          <FormField label="State" name="state" value={form.state} error={fieldErrors.state} onChange={update('state')} />
          <FormField label="Country" name="country" value={form.country} error={fieldErrors.country} onChange={update('country')} />
          <FormField label="Postal code" name="postalCode" value={form.postalCode} error={fieldErrors.postalCode} onChange={update('postalCode')} />
        </div>
      </fieldset>

      <div className="flex items-center gap-3">
        <button
          type="submit" disabled={isSubmitting}
          className={buttonClasses('primary', 'md')}
        >
          {isSubmitting ? 'Saving…' : submitLabel}
        </button>
        {onCancel ? (
          <button
            type="button" onClick={onCancel}
            className="rounded-lg border border-neutral-300 px-4 py-2.5 text-sm font-medium transition-colors hover:bg-neutral-500/10 dark:border-neutral-700"
          >
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}
