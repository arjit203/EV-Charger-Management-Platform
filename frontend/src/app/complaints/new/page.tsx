'use client';

/**
 * Report a problem.
 *
 * The anchor arrives in the URL — `?sessionId=…` from a session page, or `?chargerId=…` — which
 * is how a dispute actually starts in practice. The form never collects a station, connector or
 * company: those are derived server-side from whichever anchor is present, which is what makes a
 * mismatched set of references impossible to submit.
 */

import { useCallback, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';

import { RequireAuth } from '@/components/RequireAuth';
import { FormField } from '@/components/FormField';
import { CATEGORY_LABELS } from '@/components/ComplaintSummary';
import { useAsyncData } from '@/hooks/useAsyncData';
import { toMessage } from '@/lib/formatApiError';
import { formatPaise } from '@/lib/money';
import { createComplaint } from '@/services/complaint.service';
import { getSession } from '@/services/session.service';
import type { ComplaintCategory, ComplaintPriority } from '@/types/api';

const CATEGORIES = Object.keys(CATEGORY_LABELS) as ComplaintCategory[];
const PRIORITIES: ComplaintPriority[] = ['low', 'medium', 'high'];

function NewComplaintContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const sessionId = searchParams.get('sessionId') ?? '';
  const chargerId = searchParams.get('chargerId') ?? '';

  // Load the anchored session purely to SHOW the driver what they are reporting about. The
  // server re-resolves it from the id anyway — this is confirmation, not input.
  const load = useCallback(
    async () => (sessionId ? await getSession(sessionId) : null),
    [sessionId],
  );
  const { state } = useAsyncData(load);

  const [category, setCategory] = useState<ComplaintCategory>(
    sessionId ? 'session_issue' : chargerId ? 'charger_issue' : 'other',
  );
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<ComplaintPriority>('medium');
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setIsSaving(true);
    setError(null);

    try {
      const complaint = await createComplaint({
        category,
        subject: subject.trim(),
        description: description.trim(),
        priority,
        // At most one anchor. Sending both is a 422.
        ...(sessionId ? { chargingSessionId: sessionId } : chargerId ? { chargerId } : {}),
      });
      router.push(`/complaints/${complaint.id}`);
    } catch (caught) {
      setError(toMessage(caught));
      setIsSaving(false);
    }
  }

  return (
    <main className="mx-auto max-w-lg px-6 py-12">
      <h1 className="text-2xl font-semibold">Report a problem</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Tell us what happened. The station operator will see it and respond.
      </p>

      {state.status === 'ok' && state.data && (
        <div className="mt-6 rounded-xl bg-neutral-500/5 p-4 text-sm">
          <p className="text-xs uppercase tracking-wide text-neutral-500">About this charge</p>
          <p className="mt-1 tabular-nums">
            {state.data.energyConsumedKwh} kWh
            {state.data.amountPaise !== null && <> · {formatPaise(state.data.amountPaise)}</>}
            {' · '}
            {state.data.paymentStatus}
          </p>
        </div>
      )}

      <form onSubmit={(event) => void submit(event)} className="mt-8 space-y-4">
        <label className="block text-sm">
          <span className="block font-medium">
            What kind of problem?<span className="ml-0.5 text-red-500">*</span>
          </span>
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value as ComplaintCategory)}
            className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700"
          >
            {CATEGORIES.map((option) => (
              <option key={option} value={option}>
                {CATEGORY_LABELS[option]}
              </option>
            ))}
          </select>
        </label>

        <FormField
          label="Short title"
          name="subject"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          hint="For example: Charger stopped during charging"
          required
        />

        <label className="block text-sm">
          <span className="block font-medium">
            What happened?<span className="ml-0.5 text-red-500">*</span>
          </span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={5}
            className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700"
            required
          />
          <span className="mt-1 block text-xs text-neutral-500">
            You will not be able to edit this afterwards — it becomes part of the record.
          </span>
        </label>

        <label className="block text-sm">
          <span className="block font-medium">How urgent is it?</span>
          <select
            value={priority}
            onChange={(event) => setPriority(event.target.value as ComplaintPriority)}
            className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700"
          >
            {PRIORITIES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={isSaving}
          className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-60"
        >
          {isSaving ? 'Sending…' : 'Submit'}
        </button>
      </form>

      <Link
        href="/complaints"
        className="mt-8 inline-block text-sm text-neutral-500 underline underline-offset-4"
      >
        My complaints
      </Link>
    </main>
  );
}

export default function NewComplaintPage() {
  return (
    <RequireAuth roles={['driver']}>
      <NewComplaintContent />
    </RequireAuth>
  );
}
