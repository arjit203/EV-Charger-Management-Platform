'use client';

/**
 * Shared list filters.
 *
 * AC/DC and the plug standard are TWO filters on purpose, mirroring the two fields behind them
 * (the charger's power type and the connector's plug — OCPI keeps them apart the same way). One
 * combined "charger type" list would have to invent pairs like "DC · CCS2" and still could not
 * express a DC charger's Type 2 socket.
 *
 * The company filter only exists for the platform admin. Everyone else is pinned to their own
 * company by the server, so offering them the choice would be offering nothing.
 */

import { useCallback } from 'react';

import { useAuth } from '@/context/AuthContext';
import { useAsyncData } from '@/hooks/useAsyncData';
import { listCompanies } from '@/services/company.service';
import type { ChargerType, ConnectorType } from '@/types/api';

export const FILTER_SELECT_CLASS =
  'max-w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700';

/** Short plug names for a filter — the long CONNECTOR_LABELS are for forms. */
export const PLUG_LABELS: Record<ConnectorType, string> = {
  CCS2: 'CCS2',
  CHAdeMO: 'CHAdeMO',
  Type2: 'Type 2',
  GBT: 'GB/T',
};

export function PowerTypeFilter({
  value,
  onChange,
}: {
  value: ChargerType | '';
  onChange: (value: ChargerType | '') => void;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value as ChargerType | '')}
      aria-label="Filter by AC or DC"
      className={FILTER_SELECT_CLASS}
    >
      <option value="">AC &amp; DC</option>
      <option value="AC">AC only</option>
      <option value="DC">DC only</option>
    </select>
  );
}

export function PlugTypeFilter({
  value,
  onChange,
}: {
  value: ConnectorType | '';
  onChange: (value: ConnectorType | '') => void;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value as ConnectorType | '')}
      aria-label="Filter by plug type"
      className={FILTER_SELECT_CLASS}
    >
      <option value="">All plugs</option>
      {(Object.keys(PLUG_LABELS) as ConnectorType[]).map((plug) => (
        <option key={plug} value={plug}>
          {PLUG_LABELS[plug]}
        </option>
      ))}
    </select>
  );
}

function CompanyOptions({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const load = useCallback(() => listCompanies({ limit: 100 }), []);
  const { state } = useAsyncData(load);

  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-label="Filter by company"
      disabled={state.status !== 'ok'}
      className={FILTER_SELECT_CLASS}
    >
      <option value="">All companies</option>
      {state.status === 'ok' &&
        state.data.items.map((company) => (
          <option key={company.id} value={company.id}>
            {company.name}
          </option>
        ))}
    </select>
  );
}

/** Renders nothing unless the viewer is the platform admin. */
export function CompanyFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { user } = useAuth();
  if (user?.role !== 'super_admin') return null;
  return <CompanyOptions value={value} onChange={onChange} />;
}
