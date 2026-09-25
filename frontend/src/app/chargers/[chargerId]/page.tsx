'use client';

/**
 * Charger detail, including its connectors.
 *
 * Connectors live here rather than on their own route because they are never meaningful in
 * isolation — and because the nested API shape is what makes the server verify the
 * Company → Station → Charger chain on every connector call.
 *
 * The OCPP section below is READ-ONLY diagnostics plus token regeneration. It deliberately has
 * no start/stop buttons: since Module 7 a charge only starts through a driver's session (so it
 * is always billed), and staff stop a charge from its session page.
 */

import { useCallback, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { RelatedComplaints } from '@/components/RelatedComplaints';
import Link from 'next/link';

import { ChargerForm } from '@/components/ChargerForm';
import { FormField } from '@/components/FormField';
import { RequireAuth } from '@/components/RequireAuth';
import { StatusBadge } from '@/components/StatusBadge';
import { useAuth } from '@/context/AuthContext';
import { useAsyncData } from '@/hooks/useAsyncData';
import { toMessage } from '@/lib/formatApiError';
import {
  createConnector,
  getCharger,
  getChargerConnection,
  listConnectors,
  regenerateChargerToken,
  setChargerStatus,
  setConnectorStatus,
  updateCharger,
  type ChargerInput,
} from '@/services/charger.service';
import {
  CHARGER_STATUS_LABELS,
  CONNECTOR_LABELS,
  CONNECTOR_STATUS_LABELS,
  type Charger,
  type ChargerStatus,
  type Connector,
  type ConnectorStatus,
  type ConnectorType,
} from '@/types/api';
import { buttonClasses } from '@/components/ui/Button';
import { formatDateTime } from '@/lib/datetime';
import { LoadError } from '@/components/ui/LoadError';

const CHARGER_STATUSES: ChargerStatus[] = ['available', 'unavailable', 'faulted', 'maintenance'];
/**
 * Only the ADMINISTRATIVE statuses are offered for manual selection. `preparing`,
 * `charging` and `finishing` are reported by the hardware over OCPP, and letting an admin
 * set them by hand would mean the UI can lie about what the machine is physically doing.
 */
const CONNECTOR_STATUSES: ConnectorStatus[] = ['available', 'occupied', 'faulted', 'unavailable'];

function chargerTone(status: ChargerStatus) {
  if (status === 'available') return 'good' as const;
  if (status === 'faulted') return 'bad' as const;
  return 'neutral' as const;
}

function connectorTone(status: ConnectorStatus) {
  if (status === 'available') return 'good' as const;
  if (status === 'faulted') return 'bad' as const;
  if (status === 'occupied') return 'warn' as const;
  return 'neutral' as const;
}

/* ----------------------------------------------------------------- OCPP -- */

/**
 * Live connectivity, plus regenerating the charger's connection token.
 *
 * Values do NOT update by themselves — this module has no browser real-time channel, so you
 * press Refresh. Module 8 adds Socket.IO for that. The two real-time systems stay separate:
 * the charger speaks raw WebSocket/OCPP to the gateway, the browser will speak Socket.IO to
 * the backend.
 */
function OcppSection({ charger, canManage }: { charger: Charger; canManage: boolean }) {
  const searchParams = useSearchParams();
  const load = useCallback(() => getChargerConnection(charger.id), [charger.id]);
  const { state, reload } = useAsyncData(load);

  // Shown once after creation, handed over in the URL by the create page.
  const [issuedToken, setIssuedToken] = useState<string | null>(searchParams.get('newToken'));
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const connection = state.status === 'ok' ? state.data : null;

  async function issueToken() {
    setIsBusy(true);
    setError(null);
    try {
      const { authToken } = await regenerateChargerToken(charger.id);
      setIssuedToken(authToken);
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-neutral-200 bg-[var(--surface)] p-5 dark:border-neutral-800">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">OCPP connection</h2>
          <p className="mt-0.5 text-xs text-neutral-500">
            Whether the physical charger is currently talking to the gateway.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {charger.hardwareStatus !== 'operative' && (
            <StatusBadge
              tone="bad"
              label={charger.hardwareStatus === 'faulted' ? 'hardware fault' : 'self-disabled'}
            />
          )}
          <StatusBadge
            tone={charger.isOnline ? 'good' : 'neutral'}
            label={charger.isOnline ? 'online' : 'offline'}
          />
          <button
            type="button"
            onClick={() => void reload()}
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-neutral-500/10 dark:border-neutral-700"
          >
            Refresh
          </button>
        </div>
      </div>

      {/*
        THE FAULT THE MACHINE REPORTED ABOUT ITSELF — OCPP StatusNotification on connectorId 0.
        Shown as a banner rather than a badge because it explains why every connector below is
        refusing starts even while each one still reads `available`. The status dropdown above
        is untouched by it: that field is the operator's, this one is the hardware's.
      */}
      {charger.hardwareStatus !== 'operative' && (
        <div className="mt-4 rounded-lg bg-red-500/10 px-3 py-2">
          <p className="text-xs font-medium text-red-800 dark:text-red-300">
            {charger.hardwareStatus === 'faulted'
              ? 'This charger reported a hardware fault.'
              : 'This charger has taken itself out of service.'}
            {charger.faultCode ? ` Error code: ${charger.faultCode}.` : ''}
          </p>
          <p className="mt-1 text-xs text-red-700/80 dark:text-red-300/70">
            {charger.faultReportedAt
              ? `Reported ${formatDateTime(charger.faultReportedAt)}. `
              : ''}
            No session can start on any connector until the charger reports itself healthy again.
          </p>
        </div>
      )}

      {issuedToken ? (
        <div className="mt-4 rounded-lg bg-amber-500/10 px-3 py-2">
          <p className="text-xs font-medium text-amber-800 dark:text-amber-300">
            Connection token — copy it now, it cannot be shown again.
          </p>
          <code className="mt-1 block break-all font-mono text-xs">{issuedToken}</code>
          <p className="mt-2 text-xs text-amber-800 dark:text-amber-300">
            Start the simulator with{' '}
            <code className="font-mono">
              npm run dev -- --charger={charger.ocppId} --token=&lt;token&gt;
            </code>
          </p>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}

      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-neutral-500">Gateway</dt>
        <dd className="text-xs">{connection?.connected ? 'connected' : 'not connected'}</dd>
        <dt className="text-neutral-500">Last heartbeat</dt>
        <dd className="text-xs">
          {charger.lastHeartbeatAt ? formatDateTime(charger.lastHeartbeatAt) : 'never'}
        </dd>
        <dt className="text-neutral-500">Transactions</dt>
        <dd className="text-xs">
          {connection?.transactions.length
            ? connection.transactions
                .map((t) => `#${t.transactionId} on connector ${t.connectorNumber}`)
                .join(', ')
            : 'none in progress'}
        </dd>
      </dl>

      <div className="mt-4 space-y-3 border-t border-neutral-200 pt-4 dark:border-neutral-800">
        {/* Admins only — the backend refuses anyone else, so an operator saw a button that 403'd. */}
        {canManage ? (
          <button
            type="button"
            onClick={() => void issueToken()}
            disabled={isBusy}
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-neutral-500/10 disabled:opacity-50 dark:border-neutral-700"
          >
            Regenerate connection token
          </button>
        ) : null}
        <p className="text-xs text-neutral-500">
          Charges are started by drivers from their app, so every charge has a session and a
          bill. To stop a charge in progress, open it from{' '}
          <Link href="/sessions" className="underline underline-offset-2">
            Charging sessions
          </Link>{' '}
          and press Stop.
        </p>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------- connectors -- */

function ConnectorSection({ chargerId, canManage }: { chargerId: string; canManage: boolean }) {
  const load = useCallback(() => listConnectors(chargerId), [chargerId]);
  const { state, reload } = useAsyncData(load);

  const [isAdding, setIsAdding] = useState(false);
  const [form, setForm] = useState({ connectorNumber: '', connectorType: 'CCS2' as ConnectorType, powerKw: '' });
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  async function handleAdd(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsBusy(true);
    setError(null);
    try {
      await createConnector(chargerId, {
        connectorNumber: Number(form.connectorNumber),
        connectorType: form.connectorType,
        powerKw: Number(form.powerKw),
      });
      setForm({ connectorNumber: '', connectorType: 'CCS2', powerKw: '' });
      setIsAdding(false);
      await reload();
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setIsBusy(false);
    }
  }

  async function changeStatus(connector: Connector, status: ConnectorStatus) {
    setError(null);
    try {
      await setConnectorStatus(chargerId, connector.id, status);
      await reload();
    } catch (caught) {
      setError(toMessage(caught));
    }
  }

  return (
    <section className="rounded-xl border border-neutral-200 bg-[var(--surface)] p-5 dark:border-neutral-800">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Connectors</h2>
          <p className="mt-0.5 text-xs text-neutral-500">
            The individual plugs on this machine. One car occupies one connector.
          </p>
        </div>
        {canManage && !isAdding ? (
          <button type="button" onClick={() => setIsAdding(true)}
            className={buttonClasses('secondary')}>
            Add connector
          </button>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}

      {isAdding ? (
        <form onSubmit={handleAdd} className="mt-4 space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800" noValidate>
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label="Number" name="connectorNumber" type="number" required
              hint="1–8. Used by OCPP." value={form.connectorNumber}
              onChange={(e) => setForm((p) => ({ ...p, connectorNumber: e.target.value }))} />
            <div className="space-y-1.5">
              <label htmlFor="connectorType" className="block text-sm font-medium">Type</label>
              <select id="connectorType" value={form.connectorType}
                onChange={(e) => setForm((p) => ({ ...p, connectorType: e.target.value as ConnectorType }))}
                className="w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700">
                {(Object.keys(CONNECTOR_LABELS) as ConnectorType[]).map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
            </div>
            <FormField label="Power (kW)" name="connectorPowerKw" type="number" step="any" required
              value={form.powerKw} onChange={(e) => setForm((p) => ({ ...p, powerKw: e.target.value }))} />
          </div>
          <div className="flex gap-3">
            <button type="submit" disabled={isBusy}
              className={buttonClasses('primary', 'md')}>
              {isBusy ? 'Adding…' : 'Add connector'}
            </button>
            <button type="button" onClick={() => { setIsAdding(false); setError(null); }}
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium dark:border-neutral-700">
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {state.status === 'loading' ? (
        <p className="mt-4 text-sm text-neutral-500">Loading connectors&hellip;</p>
      ) : state.status === 'error' ? (
        <p className="mt-4 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          {state.error.message}
        </p>
      ) : state.data.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No connectors yet. A charger needs at least one to be usable.
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {state.data.map((connector) => (
            <li key={connector.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  Connector {connector.connectorNumber}
                  <span className="ml-2 font-normal text-neutral-500">
                    {connector.connectorType} · {connector.powerKw} kW
                  </span>
                </p>
                {connector.errorCode ? (
                  <p className="mt-0.5 font-mono text-xs text-red-600 dark:text-red-400">
                    {connector.errorCode}
                  </p>
                ) : null}
              </div>

              <div className="flex items-center gap-2">
                <StatusBadge tone={connectorTone(connector.status)} label={CONNECTOR_STATUS_LABELS[connector.status]} />
                {canManage ? (
                  <select
                    value={connector.status} aria-label={`Status for connector ${connector.connectorNumber}`}
                    onChange={(e) => void changeStatus(connector, e.target.value as ConnectorStatus)}
                    className="rounded-lg border border-neutral-300 px-2 py-1 text-xs outline-none focus:border-neutral-500 dark:border-neutral-700"
                  >
                    {CONNECTOR_STATUSES.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 text-xs text-neutral-500">
        The charger reports these statuses itself over OCPP. A manual change here only lasts
        until the charger next reports its real status.
      </p>
    </section>
  );
}

/* --------------------------------------------------------------- charger -- */

function ChargerDetails({ charger, onChanged }: { charger: Charger; onChanged: (c: Charger) => void }) {
  const { user } = useAuth();
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const canManage = user?.role === 'super_admin' || user?.role === 'cpo_admin';

  async function changeStatus(status: ChargerStatus) {
    setIsBusy(true);
    setError(null);
    try {
      onChanged(await setChargerStatus(charger.id, status));
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleUpdate(input: ChargerInput) {
    // `stationId` is deliberately not sent: a charger cannot be moved between sites, and the
    // API rejects it in an update with a 422.
    onChanged(
      await updateCharger(charger.id, {
        name: input.name,
        chargerCode: input.chargerCode,
        ocppId: input.ocppId,
        manufacturer: input.manufacturer,
        model: input.model,
        chargerType: input.chargerType,
        powerKw: input.powerKw,
        ...(input.firmwareVersion ? { firmwareVersion: input.firmwareVersion } : {}),
      }),
    );
    setIsEditing(false);
  }

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-widest text-neutral-500">
            Charger
          </p>
          <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight">{charger.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusBadge tone={chargerTone(charger.status)} label={charger.status} />
            <StatusBadge tone="neutral" label={charger.chargerCode} />
            <StatusBadge tone="neutral" label={`${charger.chargerType} ${charger.powerKw} kW`} />
          </div>
        </div>

        {canManage ? (
          <div className="flex flex-wrap items-center gap-2">
            {!isEditing ? (
              <button type="button" onClick={() => setIsEditing(true)}
                className={buttonClasses('secondary')}>
                Edit
              </button>
            ) : null}
            <select
              value={charger.status} disabled={isBusy} aria-label="Charger status"
              onChange={(e) => void changeStatus(e.target.value as ChargerStatus)}
              className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm outline-none focus:border-neutral-500 disabled:opacity-50 dark:border-neutral-700"
            >
              {CHARGER_STATUSES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        ) : null}
      </header>

      {error ? (
        <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}

      <section className="rounded-xl border border-neutral-200 bg-[var(--surface)] p-5 dark:border-neutral-800">
        {isEditing ? (
          <ChargerForm
            initial={charger}
            submitLabel="Save changes"
            onSubmit={handleUpdate}
            onCancel={() => setIsEditing(false)}
          />
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-neutral-500">Status</dt>
            <dd className="text-xs">{CHARGER_STATUS_LABELS[charger.status]}</dd>

            <dt className="text-neutral-500">OCPP identifier</dt>
            <dd className="font-mono text-xs">{charger.ocppId}</dd>

            <dt className="text-neutral-500">Manufacturer</dt>
            <dd className="text-xs">{charger.manufacturer} {charger.model}</dd>

            <dt className="text-neutral-500">Type / power</dt>
            <dd className="text-xs">{charger.chargerType} · {charger.powerKw} kW max</dd>

            <dt className="text-neutral-500">Firmware</dt>
            <dd className="font-mono text-xs">{charger.firmwareVersion ?? '—'}</dd>

            <dt className="text-neutral-500">Station</dt>
            <dd className="text-xs">
              <Link href={`/stations/${charger.stationId}`} className="underline underline-offset-4">
                View station
              </Link>
            </dd>

            <dt className="text-neutral-500">Added</dt>
            <dd className="text-xs">{formatDateTime(charger.createdAt)}</dd>
          </dl>
        )}
      </section>

      <OcppSection charger={charger} canManage={canManage} />

      <ConnectorSection chargerId={charger.id} canManage={canManage} />
    </>
  );
}

function ChargerDetailContent() {
  const params = useParams<{ chargerId: string }>();
  const chargerId = params.chargerId;

  const load = useCallback(() => getCharger(chargerId), [chargerId]);
  const { state, setData } = useAsyncData(load);

  return (
    <main className="page page-detail">
      {state.status === 'loading' ? (
        <p className="text-sm text-neutral-500">Loading charger&hellip;</p>
      ) : state.status === 'error' ? (
        <LoadError error={state.error} noun="charger" backHref="/chargers" backLabel="Back to chargers" />
      ) : (
        <>
          <ChargerDetails charger={state.data} onChanged={setData} />
          <RelatedComplaints filter={{ chargerId: state.data.id }} label="charger" />
        </>
      )}

      <Link href="/chargers" className="text-sm text-neutral-500 underline underline-offset-4">
        Back to chargers
      </Link>
    </main>
  );
}

export default function ChargerDetailPage() {
  return (
    <RequireAuth roles={['super_admin', 'cpo_admin', 'operator']}>
      <ChargerDetailContent />
    </RequireAuth>
  );
}
