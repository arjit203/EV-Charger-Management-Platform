'use client';

/**
 * Shared create/edit form for a charger.
 *
 * On create the station is chosen from the list the caller can actually see — which the
 * server has already scoped to their company. On edit the station is locked: a charger
 * cannot be moved between sites, and the backend rejects a `stationId` in an update.
 *
 * No status control here; status has its own buttons on the detail page.
 */

import { useCallback, useState } from 'react';

import { FormField } from '@/components/FormField';
import { useAsyncData } from '@/hooks/useAsyncData';
import { extractFieldErrors, toMessage } from '@/lib/formatApiError';
import type { ChargerInput } from '@/services/charger.service';
import { listStations } from '@/services/station.service';
import type { Charger, ChargerType } from '@/types/api';

interface ChargerFormProps {
  initial?: Charger;
  /** Preselect a station, e.g. when coming from a station's detail page. */
  defaultStationId?: string;
  submitLabel: string;
  onSubmit: (input: ChargerInput) => Promise<void>;
  onCancel?: () => void;
}

export function ChargerForm({
  initial,
  defaultStationId,
  submitLabel,
  onSubmit,
  onCancel,
}: ChargerFormProps) {
  const [form, setForm] = useState({
    stationId: initial?.stationId ?? defaultStationId ?? '',
    name: initial?.name ?? '',
    chargerCode: initial?.chargerCode ?? '',
    ocppId: initial?.ocppId ?? '',
    manufacturer: initial?.manufacturer ?? '',
    model: initial?.model ?? '',
    chargerType: initial?.chargerType ?? ('DC' as ChargerType),
    powerKw: initial ? String(initial.powerKw) : '',
    firmwareVersion: initial?.firmwareVersion ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isEdit = Boolean(initial);

  // Only the stations this caller may use — the server scopes the list by company.
  const loadStations = useCallback(() => listStations({ limit: 100 }), []);
  const { state: stationsState } = useAsyncData(loadStations);

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
        stationId: form.stationId,
        name: form.name.trim(),
        chargerCode: form.chargerCode.trim().toUpperCase(),
        ocppId: form.ocppId.trim(),
        manufacturer: form.manufacturer.trim(),
        model: form.model.trim(),
        chargerType: form.chargerType,
        powerKw: Number(form.powerKw),
        ...(form.firmwareVersion.trim() ? { firmwareVersion: form.firmwareVersion.trim() } : {}),
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

      <div className="space-y-1.5">
        <label htmlFor="stationId" className="block text-sm font-medium">
          Station<span className="ml-0.5 text-red-500">*</span>
        </label>
        <select
          id="stationId" value={form.stationId} required disabled={isEdit}
          onChange={(e) => setForm((prev) => ({ ...prev, stationId: e.target.value }))}
          className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500 disabled:opacity-60 dark:border-neutral-700"
        >
          <option value="">Select a station…</option>
          {stationsState.status === 'ok'
            ? stationsState.data.items.map((station) => (
                <option key={station.id} value={station.id}>
                  {station.name} ({station.stationCode})
                </option>
              ))
            : null}
        </select>
        <p className="text-xs text-neutral-500">
          {isEdit
            ? 'A charger cannot be moved to another station.'
            : 'The site where this hardware is installed.'}
        </p>
        {fieldErrors.stationId ? (
          <p className="text-xs text-red-600 dark:text-red-400">{fieldErrors.stationId}</p>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Charger name" name="name" required placeholder="Fast Charger 1"
          value={form.name} error={fieldErrors.name} onChange={update('name')} />
        <FormField label="Charger code" name="chargerCode" required placeholder="01"
          hint="Unique at this station — site signage."
          value={form.chargerCode} error={fieldErrors.chargerCode} onChange={update('chargerCode')} />
      </div>

      <FormField
        label="OCPP identifier" name="ocppId" required placeholder="DELTA-SN-004512"
        hint="Unique across the whole platform. The charger announces this when it connects."
        value={form.ocppId} error={fieldErrors.ocppId} onChange={update('ocppId')}
      />

      <fieldset className="space-y-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <legend className="px-1 text-xs font-medium uppercase tracking-widest text-neutral-500">
          Hardware
        </legend>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Manufacturer" name="manufacturer" required placeholder="Delta"
            value={form.manufacturer} error={fieldErrors.manufacturer} onChange={update('manufacturer')} />
          <FormField label="Model" name="model" required placeholder="DC Wallbox 60"
            value={form.model} error={fieldErrors.model} onChange={update('model')} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="chargerType" className="block text-sm font-medium">
              Type<span className="ml-0.5 text-red-500">*</span>
            </label>
            <select
              id="chargerType" value={form.chargerType}
              onChange={(e) => setForm((prev) => ({ ...prev, chargerType: e.target.value as ChargerType }))}
              className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700"
            >
              <option value="DC">DC — fast charging</option>
              <option value="AC">AC — slower, via the car&apos;s onboard charger</option>
            </select>
          </div>

          <FormField label="Max power (kW)" name="powerKw" type="number" step="any" required
            placeholder="60" hint="1 to 1000."
            value={form.powerKw} error={fieldErrors.powerKw} onChange={update('powerKw')} />
        </div>

        <FormField label="Firmware version" name="firmwareVersion" placeholder="1.4.2"
          hint="Optional. Recorded for asset tracking only."
          value={form.firmwareVersion} error={fieldErrors.firmwareVersion} onChange={update('firmwareVersion')} />
      </fieldset>

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
