'use client';

/**
 * Shared create/edit form for a station.
 *
 * No status control here — status is changed only through the dedicated buttons on the
 * detail page, mirroring the backend where the update schema rejects a `status` field. Same
 * for `companyId`: a station can never change owner through an edit form.
 *
 * The company selector appears only for a super_admin. For a cpo_admin the backend takes
 * the company from their token and refuses any other value.
 */

import { useCallback, useState } from 'react';

import { FormField } from '@/components/FormField';
import { useAsyncData } from '@/hooks/useAsyncData';
import { extractFieldErrors, toMessage } from '@/lib/formatApiError';
import { listCompanies } from '@/services/company.service';
import type { StationInput } from '@/services/station.service';
import type { Station } from '@/types/api';

interface StationFormProps {
  initial?: Station;
  submitLabel: string;
  /** super_admin must choose a company; hidden for everyone else. */
  showCompanySelector?: boolean;
  onSubmit: (input: StationInput) => Promise<void>;
  onCancel?: () => void;
}

export function StationForm({
  initial,
  submitLabel,
  showCompanySelector = false,
  onSubmit,
  onCancel,
}: StationFormProps) {
  const [form, setForm] = useState({
    name: initial?.name ?? '',
    stationCode: initial?.stationCode ?? '',
    address: initial?.address ?? '',
    city: initial?.city ?? '',
    state: initial?.state ?? '',
    country: initial?.country ?? 'India',
    postalCode: initial?.postalCode ?? '',
    latitude: initial ? String(initial.latitude) : '',
    longitude: initial ? String(initial.longitude) : '',
    contactPhone: initial?.contactPhone ?? '',
    openingHours: initial?.openingHours ?? '',
    companyId: initial?.companyId ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const loadCompanies = useCallback(
    () => (showCompanySelector ? listCompanies({ status: 'active', limit: 100 }) : Promise.resolve(null)),
    [showCompanySelector],
  );
  const { state: companiesState } = useAsyncData(loadCompanies);

  function update(field: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((prev) => ({ ...prev, [field]: e.target.value }));
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setFieldErrors({});

    try {
      await onSubmit({
        name: form.name.trim(),
        stationCode: form.stationCode.trim().toUpperCase(),
        address: form.address.trim(),
        city: form.city.trim(),
        state: form.state.trim(),
        country: form.country.trim(),
        latitude: Number(form.latitude),
        longitude: Number(form.longitude),
        // Omit optional fields when blank — "" would fail the min-length rules.
        ...(form.postalCode.trim() ? { postalCode: form.postalCode.trim() } : {}),
        ...(form.contactPhone.trim() ? { contactPhone: form.contactPhone.trim() } : {}),
        ...(form.openingHours.trim() ? { openingHours: form.openingHours.trim() } : {}),
        ...(showCompanySelector && form.companyId ? { companyId: form.companyId } : {}),
      });
    } catch (caught) {
      setFieldErrors(Object.fromEntries(extractFieldErrors(caught).map((f) => [f.field, f.message])));
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

      {showCompanySelector ? (
        <div className="space-y-1.5">
          <label htmlFor="companyId" className="block text-sm font-medium">
            Company<span className="ml-0.5 text-red-500">*</span>
          </label>
          <select
            id="companyId" value={form.companyId} required disabled={Boolean(initial)}
            onChange={(e) => setForm((prev) => ({ ...prev, companyId: e.target.value }))}
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500 disabled:opacity-60 dark:border-neutral-700"
          >
            <option value="">Select a company…</option>
            {companiesState.status === 'ok' && companiesState.data
              ? companiesState.data.items.map((company) => (
                  <option key={company.id} value={company.id}>{company.name}</option>
                ))
              : null}
          </select>
          <p className="text-xs text-neutral-500">
            {initial ? 'A station cannot be moved to another company.' : 'Which CPO owns this site.'}
          </p>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Station name" name="name" required placeholder="Connaught Place"
          value={form.name} error={fieldErrors.name} onChange={update('name')} />
        <FormField label="Station code" name="stationCode" required placeholder="DEL-CP-01"
          hint="Unique within your company. Used by field staff."
          value={form.stationCode} error={fieldErrors.stationCode} onChange={update('stationCode')} />
      </div>

      <fieldset className="space-y-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <legend className="px-1 text-xs font-medium uppercase tracking-widest text-neutral-500">
          Location
        </legend>

        <FormField label="Address" name="address" required placeholder="1 Connaught Place"
          value={form.address} error={fieldErrors.address} onChange={update('address')} />

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="City" name="city" required value={form.city} error={fieldErrors.city} onChange={update('city')} />
          <FormField label="State" name="state" required value={form.state} error={fieldErrors.state} onChange={update('state')} />
          <FormField label="Country" name="country" required value={form.country} error={fieldErrors.country} onChange={update('country')} />
          <FormField label="Postal code" name="postalCode" hint="Optional."
            value={form.postalCode} error={fieldErrors.postalCode} onChange={update('postalCode')} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Latitude" name="latitude" type="number" step="any" required
            placeholder="28.6315" hint="Between -90 and 90."
            value={form.latitude} error={fieldErrors.latitude} onChange={update('latitude')} />
          <FormField label="Longitude" name="longitude" type="number" step="any" required
            placeholder="77.2167" hint="Between -180 and 180."
            value={form.longitude} error={fieldErrors.longitude} onChange={update('longitude')} />
        </div>
        <p className="text-xs text-neutral-500">
          Coordinates are stored now so the charging-station map can place this site later.
        </p>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Site contact phone" name="contactPhone" type="tel" hint="Optional."
          value={form.contactPhone} error={fieldErrors.contactPhone} onChange={update('contactPhone')} />
        <FormField label="Opening hours" name="openingHours" placeholder="24x7" hint="Optional. Free text."
          value={form.openingHours} error={fieldErrors.openingHours} onChange={update('openingHours')} />
      </div>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={isSubmitting}
          className="rounded-lg bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 dark:bg-white dark:text-neutral-900">
          {isSubmitting ? 'Saving…' : submitLabel}
        </button>
        {onCancel ? (
          <button type="button" onClick={onCancel}
            className="rounded-lg border border-neutral-300 px-4 py-2.5 text-sm font-medium transition-colors hover:bg-neutral-500/10 dark:border-neutral-700">
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}
