'use client';

/**
 * Create / edit a tariff.
 *
 * The price field is in RUPEES, because that is what a human types. It is sent as rupees and
 * converted to integer paise on the server — one conversion, in one place, rounded rather than
 * truncated. Nothing in this component performs money arithmetic.
 */

import { useState } from 'react';

import { FormField } from '@/components/FormField';
import { toMessage } from '@/lib/formatApiError';
import type { TariffInput } from '@/services/tariff.service';
import type { Tariff } from '@/types/api';

export function TariffForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: Tariff;
  submitLabel: string;
  onSubmit: (input: TariffInput) => Promise<void>;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  // Held as a STRING so a half-typed "12." does not become NaN mid-keystroke.
  const [price, setPrice] = useState(
    initial ? String(initial.pricePerKwhRupees) : '',
  );
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setIsSaving(true);
    setError(null);

    try {
      await onSubmit({ name: name.trim(), pricePerKwh: Number(price) });
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4">
      <FormField
        label="Name"
        name="name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        hint="For your own reference, e.g. “Standard DC”."
        required
      />

      <FormField
        label="Price per kWh (₹)"
        name="pricePerKwh"
        type="number"
        step="0.01"
        min="0.01"
        value={price}
        onChange={(event) => setPrice(event.target.value)}
        hint="What a driver pays for one kilowatt-hour. Stored to the paise."
        required
      />

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={isSaving}
          className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-contrast)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-60"
        >
          {isSaving ? 'Saving…' : submitLabel}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium transition-colors hover:bg-neutral-500/10 dark:border-neutral-700"
          >
            Cancel
          </button>
        )}
      </div>

      {!initial && (
        <p className="text-xs text-neutral-500">
          New tariffs start inactive. Activating one replaces whichever tariff is currently in
          force.
        </p>
      )}
    </form>
  );
}
