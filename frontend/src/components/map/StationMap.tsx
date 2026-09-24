'use client';

/**
 * The Leaflet map. THE ONLY FILE IN THE PROJECT THAT IMPORTS LEAFLET.
 *
 * It must never be imported directly by a page. `app/map/page.tsx` loads it through
 * `next/dynamic` with `ssr: false`, because Leaflet touches `window` at MODULE LOAD time —
 * a plain `'use client'` is not enough, since client components are still prerendered on the
 * server during `next build`. Importing this file normally breaks the build, not just the
 * browser.
 *
 * Two Leaflet-specific decisions worth knowing about:
 *
 * 1. MARKERS ARE `divIcon`, NOT THE DEFAULT IMAGE ICON. Leaflet's default marker resolves
 *    its own PNG paths at runtime, which every bundler breaks; the usual fix is a webpack
 *    shim that rewrites `L.Icon.Default`. A `divIcon` is plain HTML, so there is no asset to
 *    resolve and nothing to shim — and it can be coloured by station status for free.
 *
 * 2. THE TILES ARE OPENSTREETMAP, AND THE ATTRIBUTION IS RENDERED. That is a licence
 *    condition, not decoration. OSM also needs no API key, no billing account and no usage
 *    quota, which is what makes this project runnable by anyone who clones it — a Google
 *    Maps key would not be.
 */

import { useEffect, useMemo, useRef } from 'react';
import { MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';

import 'leaflet/dist/leaflet.css';

import type { AnyMapStation } from '@/types/api';
import { hasUsableCoordinates } from './coordinates';
import { isStaffMapStation } from '@/types/api';

/**
 * Geographic centre of India, used ONLY when there is not a single station with usable
 * coordinates. Not a hardcoded operating city — it is the "we have nothing to show you"
 * fallback, and it is paired with an empty-state message rather than standing alone.
 */
const NEUTRAL_CENTRE: [number, number] = [22.5937, 78.9629];
const NEUTRAL_ZOOM = 4;
const SINGLE_STATION_ZOOM = 14;


/** Marker colour follows station status, so the map is readable without opening anything. */
function markerColour(station: AnyMapStation, isSelected: boolean): string {
  if (isSelected) return '#2563eb'; // blue-600
  if (station.status !== 'active') return '#a3a3a3'; // neutral-400
  return station.availableConnectors > 0 ? '#059669' : '#d97706'; // emerald-600 / amber-600
}

function buildIcon(station: AnyMapStation, isSelected: boolean): L.DivIcon {
  const colour = markerColour(station, isSelected);
  const size = isSelected ? 30 : 22;

  /*
   * `data-station-id` and the label are not decoration. Leaflet renders markers as bare
   * divs with no accessible name, so a screen reader announces "button" and nothing else;
   * the label fixes that, and the id gives the browser walkthrough a stable way to click
   * one specific marker instead of guessing at an index.
   */
  return L.divIcon({
    className: '', // Leaflet's own class adds a white box we do not want.
    html: `<span
      data-station-id="${station.id}"
      aria-label="${station.name.replace(/"/g, '&quot;')}"
      title="${station.name.replace(/"/g, '&quot;')}"
      style="
      display:block;width:${size}px;height:${size}px;border-radius:9999px;
      background:${colour};border:3px solid #fff;
      box-shadow:0 1px 4px rgba(0,0,0,.45);
    "></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -(size / 2)],
  });
}

/**
 * Fit the view to the markers, and pan to whichever station is selected.
 *
 * A child component rather than logic in the parent, because `useMap()` only works inside
 * `MapContainer`. Both effects are keyed on values that change rarely — the bounds on the
 * set of station ids, not on the array identity, so a re-render that produces an equal list
 * does NOT yank the map back and interrupt someone mid-pan.
 */
function MapController({
  stations,
  selectedId,
  userLocation,
}: {
  stations: AnyMapStation[];
  selectedId: string | null;
  userLocation: UserLocation | null;
}) {
  const map = useMap();

  // A stable key for "the same set of stations", so panning is not undone by a re-render.
  const stationKey =
    stations.map((station) => station.id).join(',') +
    (userLocation ? `@${userLocation.lat},${userLocation.lng}` : '');
  const hasFitted = useRef('');

  useEffect(() => {
    if (hasFitted.current === stationKey) return;

    // Near me: frame the driver AND the stations around them, so "where am I relative to
    // these" is answered at a glance. With nothing nearby, just centre on the driver.
    if (userLocation) {
      hasFitted.current = stationKey;
      const points: [number, number][] = [
        [userLocation.lat, userLocation.lng],
        ...stations.map((station): [number, number] => [station.latitude, station.longitude]),
      ];
      if (points.length === 1) {
        map.setView(points[0], 13);
      } else {
        map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 15 });
      }
      return;
    }

    if (stations.length === 0) return;
    hasFitted.current = stationKey;

    if (stations.length === 1) {
      map.setView([stations[0].latitude, stations[0].longitude], SINGLE_STATION_ZOOM);
      return;
    }

    // `fitBounds` rather than a chosen zoom level: a hardcoded zoom only ever looks right
    // in one city, and this data is spread across Delhi NCR today and anywhere tomorrow.
    map.fitBounds(
      L.latLngBounds(stations.map((station) => [station.latitude, station.longitude])),
      { padding: [40, 40], maxZoom: 15 },
    );
  }, [map, stations, stationKey, userLocation]);

  useEffect(() => {
    if (!selectedId) return;
    const station = stations.find((candidate) => candidate.id === selectedId);
    if (!station) return;

    // `flyTo` keeps the current zoom if it is already close enough, so selecting from the
    // list nudges the map rather than jumping it to a fixed scale.
    map.flyTo([station.latitude, station.longitude], Math.max(map.getZoom(), 13), {
      duration: 0.6,
    });
  }, [map, selectedId, stations]);

  return null;
}

export interface UserLocation {
  lat: number;
  lng: number;
}

/** The driver's own position — a distinct blue dot with a halo, like every maps app. */
const USER_ICON = L.divIcon({
  className: '',
  html: `<span aria-label="Your location" title="Your location" style="
    display:block;width:18px;height:18px;border-radius:9999px;background:#2563eb;
    border:3px solid #fff;box-shadow:0 0 0 6px rgba(37,99,235,.25),0 1px 4px rgba(0,0,0,.45);
  "></span>`,
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

export interface StationMapProps {
  stations: AnyMapStation[];
  selectedId: string | null;
  onSelect: (stationId: string) => void;
  /** Set when the driver used "near me". Never sent anywhere except the one search. */
  userLocation?: UserLocation | null;
}

export default function StationMap({
  stations,
  selectedId,
  onSelect,
  userLocation = null,
}: StationMapProps) {
  /*
   * Filtered ONCE here, and memoised on the station list. Everything below this line can
   * assume a usable latitude/longitude, so there is no per-marker defensive check scattered
   * through the render.
   */
  const placeable = useMemo(() => stations.filter(hasUsableCoordinates), [stations]);

  return (
    <MapContainer
      center={NEUTRAL_CENTRE}
      zoom={NEUTRAL_ZOOM}
      scrollWheelZoom
      className="h-full w-full"
      /* Leaflet paints its own grey background; matching it stops a flash while tiles load. */
      style={{ background: '#e5e7eb' }}
    >
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        maxZoom={19}
      />

      <MapController stations={placeable} selectedId={selectedId} userLocation={userLocation} />

      {userLocation && (
        <Marker position={[userLocation.lat, userLocation.lng]} icon={USER_ICON} interactive={false} />
      )}

      {placeable.map((station) => (
        <Marker
          key={station.id}
          position={[station.latitude, station.longitude]}
          icon={buildIcon(station, station.id === selectedId)}
          eventHandlers={{ click: () => onSelect(station.id) }}
        >
          <Popup>
            <div className="min-w-[11rem] space-y-1 text-neutral-900">
              <p className="text-sm font-semibold">{station.name}</p>
              <p className="text-xs text-neutral-600">
                {station.address}, {station.city}
              </p>
              <p className="text-xs">
                Status: <span className="font-medium">{station.status}</span>
              </p>
              <p className="text-xs">
                {station.totalConnectors === 0 ? (
                  <span className="text-neutral-500">No connectors installed</span>
                ) : (
                  <>
                    <span className="font-medium">{station.availableConnectors}</span> of{' '}
                    {station.totalConnectors} connectors available
                  </>
                )}
              </p>
              {/*
                * The ONLY place the staff shape is treated differently. `isStaffMapStation`
                * narrows the union, so the driver payload — which has no `stationCode` field
                * at all — cannot reach this branch, and a mistake here would not compile.
                */}
              {isStaffMapStation(station) && (
                <p className="text-[11px] text-neutral-500">{station.stationCode}</p>
              )}
            </div>
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
