'use client';

/**
 * Module 14 — the charging station map.
 *
 * The FIRST page in this project available to all four roles, and the first station-related
 * screen a driver has ever had.
 *
 * WHICH ENDPOINT IS CALLED IS DECIDED BY ROLE — and that is a convenience, not the security
 * boundary. A driver who calls `/stations/map` directly gets 403 from the server, and that
 * is tested. Nothing on this page is load-bearing for authorisation.
 *
 *   staff   GET /stations/map      company-scoped, all statuses, carries company fields
 *   driver  GET /stations/public   every company's ACTIVE stations, company identity stripped
 *
 * SELECTION IS ONE PIECE OF STATE, owned here and read by both panes. The list and the map
 * do not each keep their own idea of what is selected — that is how they would drift.
 */

import { useCallback, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';

import { RequireAuth } from '@/components/RequireAuth';
import { StationList } from '@/components/map/StationList';
import { hasUsableCoordinates } from '@/components/map/coordinates';
import { useAuth } from '@/context/AuthContext';
import { useAsyncData } from '@/hooks/useAsyncData';
import { toMessage } from '@/lib/formatApiError';
import { getMapStations, getPublicStations, listStationCities } from '@/services/station.service';
import type { UserLocation } from '@/components/map/StationMap';
import { getActiveSession, listStationConnectors } from '@/services/session.service';
import { AlreadyCharging } from '@/components/SessionSummary';
import type { AnyMapStation, StationStatus } from '@/types/api';
import { isStaffMapStation } from '@/types/api';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';

/**
 * Leaflet reads `window` at MODULE LOAD time, so the map is loaded with `ssr: false`.
 *
 * A plain `'use client'` would not be enough — client components are still prerendered on
 * the server during `next build`, and a bare import here would fail the build rather than
 * merely misbehaving in the browser. `ssr: false` is only permitted inside a Client
 * Component, which this page is.
 */
/**
 * The plugs at the selected station. For a driver each usable one links to start a charge;
 * staff see the same list read-only, because starting a charge is a driver action (the API
 * refuses anyone else) and linking them to /charge only bounced them back to the dashboard.
 *
 * THE HOLE THIS FILLS. The map could say "3 of 6 available" but never which three, so the
 * last step of the journey had no route: a driver who had found a station still needed a
 * connector id from somewhere else. Pasting one is what the /charge box was for, and in a
 * demo that means reading a 24-character hex string aloud.
 *
 * Loaded per selection rather than folded into the map payload. The list endpoint returns
 * every station; attaching every plug to every station would multiply a list response by
 * the size of the estate to answer a question about ONE station.
 */
function StationConnectors({ stationId, canStart }: { stationId: string; canStart: boolean }) {
  // Wrapped, because an unwrapped closure is a new identity every render and refetches forever.
  // The driver's own running charge is fetched alongside: a free plug is still not startable by
  // someone who is already charging, and saying so here beats a Start link that bounces.
  const load = useCallback(async () => {
    const [connectors, active] = await Promise.all([
      listStationConnectors(stationId),
      canStart ? getActiveSession() : Promise.resolve(null),
    ]);
    return { connectors, active };
  }, [stationId, canStart]);
  const { state } = useAsyncData(load);

  if (state.status === 'loading') {
    return <p className="mt-4 text-sm text-neutral-500">Loading connectors&hellip;</p>;
  }
  if (state.status === 'error') {
    return <p className="mt-4 text-sm text-red-700 dark:text-red-400">{state.error.message}</p>;
  }
  if (state.data.connectors.length === 0) {
    return <p className="mt-4 text-sm text-neutral-500">No connectors installed here yet.</p>;
  }

  const { active } = state.data;

  return (
    <div className="mt-4">
      {active && (
        <div className="mb-4">
          <AlreadyCharging active={active} />
        </div>
      )}
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Plugs</h3>
      <ul className="mt-2 space-y-2">
        {state.data.connectors.map((c) => {
          const label = `${c.chargerName} · #${c.connectorNumber} · ${c.connectorType} · ${c.powerKw} kW`;

          /*
           * An unusable plug is still SHOWN, just not linked. Hiding it only prompts "why is
           * there nothing here?" — the reason the server already computed is the answer.
           */
          if (!c.canStart || !canStart || active) {
            return (
              <li
                key={c.connectorId}
                className={`rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-800 ${c.canStart ? '' : 'opacity-60'}`}
              >
                <p className="font-medium">{label}</p>
                <p className="mt-0.5 text-xs text-neutral-500">
                  {!c.canStart
                    ? (c.unavailableReason ?? 'Unavailable right now.')
                    : active && active.connectorId === c.connectorId
                      ? 'Your car is charging here'
                      : 'Available'}
                </p>
              </li>
            );
          }

          return (
            <li key={c.connectorId}>
              <Link
                href={`/charge?connectorId=${c.connectorId}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-neutral-200 p-3 text-sm transition-colors hover:bg-neutral-500/10 dark:border-neutral-800"
              >
                <span className="font-medium">{label}</span>
                <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                  Start a charge &rarr;
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {canStart && (
        // A driver who found a dead charger here — without ever starting a charge — can report
        // it. One link per MACHINE: the complaint is anchored to the charger, not the site.
        <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-neutral-500">
          <span>Problem with a charger?</span>
          {[...new Map(state.data.connectors.map((c) => [c.chargerId, c.chargerName])).entries()].map(
            ([chargerId, chargerName]) => (
              <Link
                key={chargerId}
                href={`/complaints/new?chargerId=${chargerId}`}
                className="underline underline-offset-4"
              >
                Report {chargerName}
              </Link>
            ),
          )}
        </p>
      )}
    </div>
  );
}

const StationMap = dynamic(() => import('@/components/map/StationMap'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center bg-neutral-200 dark:bg-neutral-900">
      <p className="text-sm text-neutral-500">Loading map&hellip;</p>
    </div>
  ),
});

const STATUS_OPTIONS: (StationStatus | '')[] = ['', 'active', 'inactive', 'suspended'];

const RADIUS_OPTIONS = [5, 10, 25, 50, 100];

/**
 * ~100 m precision. Plenty to find a charger, and it keeps an exact home address out of the
 * request — and therefore out of the server's access logs, which record every URL.
 */
function roundCoordinate(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function locationErrorMessage(error: GeolocationPositionError): string {
  if (error.code === error.PERMISSION_DENIED) {
    return 'Location permission was denied. Allow location for this site in your browser settings, or search by city instead.';
  }
  if (error.code === error.TIMEOUT) return 'Finding your location took too long. Try again.';
  return 'Your location is not available right now. Search by city instead.';
}

function StationMapPage() {
  const { user } = useAuth();
  const isDriver = user?.role === 'driver';

  const [search, setSearch] = useState('');
  const query = useDebouncedValue(search.trim());
  const [city, setCity] = useState('');
  const [status, setStatus] = useState<StationStatus | ''>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [listOpenOnMobile, setListOpenOnMobile] = useState(true);

  // "Near me" — driver only. Held in memory for this page; never saved anywhere.
  const [userLocation, setUserLocation] = useState<UserLocation | null>(null);
  const [radiusKm, setRadiusKm] = useState(25);
  const [isLocating, setIsLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);

  function findNearMe() {
    if (!('geolocation' in navigator)) {
      setLocationError('This browser cannot share its location. Search by city instead.');
      return;
    }
    setIsLocating(true);
    setLocationError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setUserLocation({
          lat: roundCoordinate(position.coords.latitude),
          lng: roundCoordinate(position.coords.longitude),
        });
        setSelectedId(null);
        setIsLocating(false);
      },
      (error) => {
        setLocationError(locationErrorMessage(error));
        setIsLocating(false);
      },
      // A cached fix up to a minute old is fine for "which charger is close".
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  }

  /*
   * SERVER-SIDE filtering, reusing the query parameters Module 4 already built. A second,
   * client-side filter would be a duplicate way to answer one question — the thing this
   * project has refused since Module 9.
   */
  const load = useCallback(async (): Promise<AnyMapStation[]> => {
    if (isDriver) {
      const result = await getPublicStations({
        search: query || undefined,
        city: city || undefined,
        ...(userLocation ? { lat: userLocation.lat, lng: userLocation.lng, radiusKm } : {}),
      });
      return result.stations;
    }

    const result = await getMapStations({
      search: query || undefined,
      city: city || undefined,
      status: status || undefined,
    });
    return result.stations;
  }, [isDriver, query, city, status, userLocation, radiusKm]);

  const { state, reload } = useAsyncData(load);

  // City options are the cities that really have stations — see listStationCities.
  const loadCities = useCallback(
    () => listStationCities(isDriver ? 'driver' : 'staff'),
    [isDriver],
  );
  const { state: citiesState } = useAsyncData(loadCities);
  const cities = citiesState.status === 'ok' ? citiesState.data : [];

  const stations = useMemo(() => (state.status === 'ok' ? state.data : []), [state]);
  const placeableCount = useMemo(
    () => stations.filter(hasUsableCoordinates).length,
    [stations],
  );

  const selected = stations.find((station) => station.id === selectedId) ?? null;

  const handleSelect = useCallback((stationId: string) => {
    setSelectedId(stationId);
    setListOpenOnMobile(true);
  }, []);

  return (
    <main className="page">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {isDriver ? 'Find a charging station' : 'Station map'}
          </h1>
          <p className="text-sm text-neutral-500">
            {isDriver
              ? 'Active stations from every operator on the platform.'
              : 'Your company’s stations, plotted from their stored coordinates.'}
          </p>
        </div>
      </header>

      {/* ----------------------------------------------------------- filters */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void reload();
        }}
        className="flex flex-wrap items-end gap-3 rounded-xl border border-neutral-200 bg-[var(--surface)] p-3 dark:border-neutral-800"
      >
        <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs text-neutral-500">
          Search
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={isDriver ? 'Name, area, city or PIN code' : 'Name, code, area, city or PIN'}
            className="rounded-lg border border-neutral-300 bg-transparent px-2.5 py-1.5 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          City
          <select
            value={city}
            onChange={(event) => setCity(event.target.value)}
            className="w-40 rounded-lg border border-neutral-300 bg-transparent px-2.5 py-1.5 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700"
          >
            <option value="">All cities</option>
            {cities.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        {/* Drivers get no status filter: the endpoint serves active stations only, and
            offering the control would imply they could ask for something else. */}
        {!isDriver && (
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Status
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as StationStatus | '')}
              className="rounded-lg border border-neutral-300 bg-transparent px-2.5 py-1.5 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700"
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option || 'any'} value={option}>
                  {option || 'Any status'}
                </option>
              ))}
            </select>
          </label>
        )}

        <button
          type="submit"
          className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm transition-colors hover:bg-neutral-500/10 dark:border-neutral-700"
        >
          Apply
        </button>

        {/*
          * NEAR ME. The browser asks the driver for permission first — nothing happens without
          * it. The position is rounded, used for this one search, and never stored.
          */}
        {isDriver && (
          <div className="flex flex-wrap items-end gap-2">
            {userLocation ? (
              <>
                <label className="flex flex-col gap-1 text-xs text-neutral-500">
                  Within
                  <select
                    value={radiusKm}
                    onChange={(event) => setRadiusKm(Number(event.target.value))}
                    className="rounded-lg border border-neutral-300 bg-transparent px-2.5 py-1.5 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700"
                  >
                    {RADIUS_OPTIONS.map((km) => (
                      <option key={km} value={km}>
                        {km} km
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => setUserLocation(null)}
                  className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm transition-colors hover:bg-neutral-500/10 dark:border-neutral-700"
                >
                  Show all stations
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={findNearMe}
                disabled={isLocating}
                className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent-contrast)] transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {isLocating ? 'Finding you…' : 'Stations near me'}
              </button>
            )}
          </div>
        )}
      </form>

      {locationError && (
        <p role="alert" className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          {locationError}
        </p>
      )}

      {state.status === 'error' && (
        <div className="rounded-lg border border-red-300 bg-red-500/5 p-4 text-sm text-red-700 dark:border-red-900 dark:text-red-400">
          <p>{toMessage(state.error)}</p>
          <button
            type="button"
            onClick={() => void reload()}
            className="mt-2 underline underline-offset-2"
          >
            Try again
          </button>
        </div>
      )}

      {state.status !== 'error' && (
        <>
          {/* A count line that tells the truth about what is and is not on the map. */}
          <p className="text-xs text-neutral-500">
            {state.status === 'loading'
              ? 'Loading stations…'
              : `${stations.length} station${stations.length === 1 ? '' : 's'}` +
                (userLocation ? ` within ${radiusKm} km, nearest first` : '') +
                (placeableCount !== stations.length
                  ? ` · ${stations.length - placeableCount} without coordinates, listed but not mapped`
                  : '')}
          </p>

          {/*
            * RESPONSIVE: below `lg` the map sits on top at a fixed height with the list
            * beneath it — the prompt's "map first". At `lg` and above they become two
            * columns with the list scrolling independently.
            */}
          <div className="grid gap-4 lg:h-[34rem] lg:grid-cols-[22rem_1fr]">
            <section className="order-2 overflow-hidden rounded-xl border border-neutral-200 bg-[var(--surface)] lg:order-1 lg:flex lg:flex-col dark:border-neutral-800">
              <button
                type="button"
                onClick={() => setListOpenOnMobile((open) => !open)}
                className="flex w-full items-center justify-between border-b border-neutral-200 px-4 py-2.5 text-left text-sm font-semibold lg:cursor-default dark:border-neutral-800"
              >
                Stations
                <span className="text-xs font-normal text-neutral-500 lg:hidden">
                  {listOpenOnMobile ? 'Hide' : 'Show'}
                </span>
              </button>

              <div
                className={`${listOpenOnMobile ? 'block' : 'hidden'} max-h-[22rem] overflow-y-auto lg:block lg:max-h-none lg:flex-1`}
              >
                {state.status === 'loading' ? (
                  <p className="p-4 text-sm text-neutral-500">Loading&hellip;</p>
                ) : (
                  <StationList
                    stations={stations}
                    selectedId={selectedId}
                    onSelect={handleSelect}
                    emptyMessage={
                      userLocation
                        ? `No stations within ${radiusKm} km. Try a wider radius.`
                        : search || city || status
                        ? 'No stations match those filters.'
                        : isDriver
                          ? 'No charging stations are available yet.'
                          : 'Your company has no stations yet.'
                    }
                  />
                )}
              </div>
            </section>

            <section className="order-1 h-[20rem] overflow-hidden rounded-xl border border-neutral-200 bg-[var(--surface)] lg:order-2 lg:h-auto dark:border-neutral-800">
              {placeableCount === 0 && state.status === 'ok' && !userLocation ? (
                <div className="flex h-full items-center justify-center bg-neutral-100 p-6 dark:bg-neutral-900">
                  <p className="max-w-xs text-center text-sm text-neutral-500">
                    {stations.length === 0
                      ? 'Nothing to plot yet. Stations will appear here once they exist.'
                      : 'None of these stations has usable coordinates, so there is nothing to plot.'}
                  </p>
                </div>
              ) : (
                <StationMap
                  stations={stations}
                  selectedId={selectedId}
                  onSelect={handleSelect}
                  userLocation={userLocation}
                />
              )}
            </section>
          </div>

          {/* --------------------------------------------------------- detail */}
          {selected && (
            <section className="rounded-xl border border-neutral-200 bg-[var(--surface)] p-4 dark:border-neutral-800">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">{selected.name}</h2>
                  {'operatorName' in selected && selected.operatorName && (
                    <p className="text-sm font-medium text-neutral-600 dark:text-neutral-300">
                      Operated by {selected.operatorName}
                    </p>
                  )}
                  <p className="text-sm text-neutral-500">
                    {selected.address}, {selected.city}, {selected.state}
                  </p>
                </div>

                {/*
                  * Staff can open the full administrative record. A driver has no such page,
                  * and `isStaffMapStation` is what keeps this branch off their screen — the
                  * driver payload has no `stationCode`, so this could not compile otherwise.
                  */}
                {isStaffMapStation(selected) && (
                  <Link
                    href={`/stations/${selected.id}`}
                    className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm transition-colors hover:bg-neutral-500/10 dark:border-neutral-700"
                  >
                    Open station
                  </Link>
                )}
              </div>

              <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <dt className="text-xs text-neutral-500">Status</dt>
                  <dd className="font-medium">{selected.status}</dd>
                </div>
                <div>
                  <dt className="text-xs text-neutral-500">Connectors available</dt>
                  <dd className="font-medium">
                    {selected.totalConnectors === 0
                      ? 'None installed'
                      : `${selected.availableConnectors} of ${selected.totalConnectors}`}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-neutral-500">Chargers</dt>
                  <dd className="font-medium">
                    {selected.chargers}
                    {selected.chargers > 0 && (
                      <span className="ml-1 text-xs font-normal text-neutral-500">
                        ({selected.chargersOnline} online)
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-neutral-500">Coordinates</dt>
                  <dd className="font-medium tabular-nums">
                    {hasUsableCoordinates(selected)
                      ? `${selected.latitude.toFixed(4)}, ${selected.longitude.toFixed(4)}`
                      : 'Not set'}
                  </dd>
                </div>
              </dl>

              {isStaffMapStation(selected) && (
                <p className="mt-3 text-xs text-neutral-500">Code: {selected.stationCode}</p>
              )}

              <StationConnectors stationId={selected.id} canStart={isDriver} />
            </section>
          )}
        </>
      )}
    </main>
  );
}

export default function MapPage() {
  /*
   * All four roles. The only page in the project with no role restriction at all — which is
   * correct, because "where can I charge?" is a question every user of a charging platform
   * has, and the backend decides what each of them actually receives.
   */
  return (
    <RequireAuth>
      <StationMapPage />
    </RequireAuth>
  );
}
