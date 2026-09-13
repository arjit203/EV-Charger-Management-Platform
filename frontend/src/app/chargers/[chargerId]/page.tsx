'use client';

/**
 * Charger detail, including its connectors.
 *
 * Connectors live here rather than on their own route because they are never meaningful in
 * isolation — and because the nested API shape is what makes the server verify the
 * Company → Station → Charger chain on every connector call.
 *
 * Module 6 adds the OCPP section below: live connectivity and remote start/stop. There is
 * still no live streaming or meter charting — those need Socket.IO, which is Module 8.
 */

import { useCallback, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
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
  remoteStart,
  remoteStop,
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
 * Live connectivity and the Module 6 remote commands.
 *
 * Values do NOT update by themselves — this module has no browser real-time channel, so you
 * press Refresh. Module 8 adds Socket.IO for that. The two real-time systems stay separate:
 * the charger speaks raw WebSocket/OCPP to the gateway, the browser will speak Socket.IO to
 * the backend.
 */
function OcppSection({ charger, canCommand }: { charger: Charger; canCommand: boolean }) {
  const searchParams = useSearchParams();
  const load = useCallback(() => getChargerConnection(charger.id), [charger.id]);
  const { state, reload } = useAsyncData(load);

  // Shown once after creation, handed over in the URL by the create page.
  const [issuedToken, setIssuedToken] = useState<string | null>(searchParams.get('newToken'));
  const [idTag, setIdTag] = useState('TESTTAG-0001');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const connection = state.status === 'ok' ? state.data : null;

  async function run(action: 'start' | 'stop') {
    setIsBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result =
        action === 'start' ? await remoteStart(charger.id, 1, idTag) : await remoteStop(charger.id);
      setMessage(result.accepted ? 'Charger accepted the command.' : 'Charger rejected the command.');
      await reload();
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setIsBusy(false);
    }
  }

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
    <section className="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">OCPP connection</h2>
          <p className="mt-0.5 text-xs text-neutral-500">
            Whether the physical charger is currently talking to the gateway.
          </p>
        </div>
        <div className="flex items-center gap-2">
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
      {message ? (
        <p className="mt-3 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
          {message}
        </p>
      ) : null}

      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-neutral-500">Gateway</dt>
        <dd className="text-xs">{connection?.connected ? 'connected' : 'not connected'}</dd>
        <dt className="text-neutral-500">Last heartbeat</dt>
        <dd className="text-xs">
          {charger.lastHeartbeatAt ? new Date(charger.lastHeartbeatAt).toLocaleString() : 'never'}
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

      {canCommand ? (
        <div className="mt-4 space-y-3 border-t border-neutral-200 pt-4 dark:border-neutral-800">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[12rem] flex-1">
              <FormField
                label="idTag"
                name="idTag"
                hint="Stands in for an RFID card."
                value={idTag}
                onChange={(e) => setIdTag(e.target.value)}
              />
            </div>
            <button
              type="button"
              onClick={() => void run('start')}
              disabled={isBusy || !charger.isOnline}
              className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              Remote start
            </button>
            <button
              type="button"
              onClick={() => void run('stop')}
              disabled={isBusy || !charger.isOnline}
              className="rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              Remote stop
            </button>
          </div>
          <button
            type="button"
            onClick={() => void issueToken()}
            disabled={isBusy}
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-neutral-500/10 disabled:opacity-50 dark:border-neutral-700"
          >
            Regenerate connection token
          </button>
          <p className="text-xs text-neutral-500">
            These are the Module 6 test surface. The driver-facing start/stop, which also creates a
            charging session, arrives in Module 7.
          </p>
        </div>
      ) : null}
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
    <section className="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Connectors</h2>
          <p className="mt-0.5 text-xs text-neutral-500">
            The individual plugs on this machine. One car occupies one connector.
          </p>
        </div>
        {canManage && !isAdding ? (
          <button type="button" onClick={() => setIsAdding(true)}
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-neutral-500/10 dark:border-neutral-700">
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
                className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700">
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
              className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900">
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
        Statuses are set manually here. From Module 6 the OCPP gateway will drive them from
        what the hardware actually reports.
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
  // Operators may COMMAND a charger even though they cannot reconfigure it — Module 6 is
  // where their first write lands, because operating hardware is the role's actual job.
  const canCommand = canManage || user?.role === 'operator';

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
            EV-CMS &middot; Charger
          </p>
          <h1 className="mt-1 truncate text-2xl font-semibold">{charger.name}</h1>
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
                className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-neutral-500/10 dark:border-neutral-700">
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

      <section className="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
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
            <dd className="text-xs">{new Date(charger.createdAt).toLocaleString()}</dd>
          </dl>
        )}
      </section>

      <OcppSection charger={charger} canCommand={canCommand} />

      <ConnectorSection chargerId={charger.id} canManage={canManage} />
    </>
  );
}

function ChargerDetailContent() {
  const params = useParams<{ chargerId: string }>();
  const router = useRouter();
  const chargerId = params.chargerId;

  const load = useCallback(() => getCharger(chargerId), [chargerId]);
  const { state, setData } = useAsyncData(load);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-16">
      {state.status === 'loading' ? (
        <p className="text-sm text-neutral-500">Loading charger&hellip;</p>
      ) : state.status === 'error' ? (
        <div className="space-y-3">
          <StatusBadge tone="bad" label={`HTTP ${state.error.status}`} />
          <p className="text-sm font-medium">{state.error.message}</p>
          <p className="text-xs text-neutral-500">
            A 403 here is the ownership chain working: the charger belongs to a station owned by
            another company, so it is not reachable whatever id is used.
          </p>
          <button type="button" onClick={() => router.back()}
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium dark:border-neutral-700">
            Go back
          </button>
        </div>
      ) : (
        <ChargerDetails charger={state.data} onChanged={setData} />
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
