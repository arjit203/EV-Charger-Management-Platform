'use client';

/**
 * Create/edit form for a driver's vehicle.
 *
 * There is deliberately no owner field. Ownership comes from the authenticated request on
 * the server, and the API rejects a `userId`/`ownerId` in the body with 422 — so there is
 * nothing here for the client to set, correctly or otherwise.
 */

import { useState } from 'react';

import { FormField } from '@/components/FormField';
import { extractFieldErrors, toMessage } from '@/lib/formatApiError';
import type { VehicleInput } from '@/services/vehicle.service';
import { CONNECTOR_LABELS, type ConnectorType, type Vehicle } from '@/types/api';

const CONNECTORS = Object.keys(CONNECTOR_LABELS) as ConnectorType[];

interface VehicleFormProps {
  initial?: Vehicle;
  submitLabel: string;
  onSubmit: (input: VehicleInput) => Promise<void>;
  onCancel?: () => void;
}

export function VehicleForm({ initial, submitLabel, onSubmit, onCancel }: VehicleFormProps) {
  const [form, setForm] = useState({
    make: initial?.make ?? '',
    model: initial?.model ?? '',
    registrationNumber: initial?.registrationNumber ?? '',
    connectorType: initial?.connectorType ?? ('CCS2' as ConnectorType),
    batteryCapacityKwh: initial?.batteryCapacityKwh ? String(initial.batteryCapacityKwh) : '',
  });
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  function update(field: 'make' | 'model' | 'registrationNumber' | 'batteryCapacityKwh') {
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
        make: form.make.trim(),
        model: form.model.trim(),
        registrationNumber: form.registrationNumber.trim().toUpperCase(),
        connectorType: form.connectorType,
        // Omit rather than send "" — an empty string fails the numeric range check.
        ...(form.batteryCapacityKwh.trim()
          ? { batteryCapacityKwh: Number(form.batteryCapacityKwh) }
          : {}),
      });
    } catch (caught) {
      setFieldErrors(Object.fromEntries(extractFieldErrors(caught).map((f) => [f.field, f.message])));
      setError(toMessage(caught));
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      {error ? (
        <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Make" name="make" required placeholder="Tata" value={form.make} error={fieldErrors.make} onChange={update('make')} />
        <FormField label="Model" name="model" required placeholder="Nexon EV" value={form.model} error={fieldErrors.model} onChange={update('model')} />
      </div>

      <FormField
        label="Registration number" name="registrationNumber" required
        placeholder="DL01AB1234" hint="Stored in uppercase. Must be unique across the platform."
        value={form.registrationNumber} error={fieldErrors.registrationNumber}
        onChange={update('registrationNumber')}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="connectorType" className="block text-sm font-medium">
            Connector type<span className="ml-0.5 text-red-500">*</span>
          </label>
          <select
            id="connectorType" value={form.connectorType}
            onChange={(e) => setForm((prev) => ({ ...prev, connectorType: e.target.value as ConnectorType }))}
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700"
          >
            {CONNECTORS.map((type) => (
              <option key={type} value={type}>{CONNECTOR_LABELS[type]}</option>
            ))}
          </select>
          <p className="text-xs text-neutral-500">Determines which chargers fit this vehicle.</p>
        </div>

        <FormField
          label="Battery capacity (kWh)" name="batteryCapacityKwh" type="number" step="0.1"
          placeholder="40.5" hint="Optional. Used later to estimate charge level."
          value={form.batteryCapacityKwh} error={fieldErrors.batteryCapacityKwh}
          onChange={update('batteryCapacityKwh')}
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit" disabled={isSubmitting}
          className="rounded-lg bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
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
