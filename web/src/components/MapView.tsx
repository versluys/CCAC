/**
 * The map is the primary view (PRD §10).
 *
 * Basemap is OpenFreeMap vector tiles: free, no key, and OpenStreetMap
 * attribution stays visible in the corner because their licence requires it
 * and because the committee should know where the data came from.
 */

import { useEffect, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MLMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Attender, Candidate, Centroid, Household, Status } from '../types';
import { STATUS_COLOR, STATUS_LABEL, STATUS_ORDER } from '../types';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const MILES_TO_M = 1609.344;

export interface Layers {
  heatmap: boolean;
  households: boolean;
  centroids: boolean;
  ring: boolean;
  isochrones: boolean;
  candidates: boolean;
}

interface Props {
  households: Household[];
  attenders: Attender[];
  centroids: Centroid[];
  candidates: Candidate[];
  center: Centroid | null;
  isochrones: GeoJSON.Feature[];
  /** Drive minutes from the selected candidate to each household, by id. */
  driveMinutes: Record<string, number | null> | null;
  /** Search radius in miles, from settings. */
  radiusMi: number;
  layers: Layers;
  onSelect: (id: string) => void;
  onPickPoint?: (lat: number, lon: number) => void;
  pickMode?: boolean;
}

function circle(lat: number, lon: number, radiusMi: number, steps = 96) {
  const coords: [number, number][] = [];
  const r = radiusMi * MILES_TO_M;
  const dLat = (r / 6378137) * (180 / Math.PI);
  const dLon = dLat / Math.cos((lat * Math.PI) / 180);
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    coords.push([lon + dLon * Math.cos(t), lat + dLat * Math.sin(t)]);
  }
  return { type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [coords] } };
}

// Fallback only. Real isochrones come from scripts/isochrones.py via
// /api/isochrones; these circles are drawn only when that has never run, and
// the panel says plainly that they are distance, not drive time. At a flat
// 27 mph a circle is not an isochrone, and passing one off as a drive time
// would be the most misleading thing this map could do.
const PROXY_MPH = 27;

// 15 / 30 / 45 / 60 minutes, near to far. Darkest band is the one that matters
// most, and each is translucent so the bands read as nested rather than
// stacked opaque shapes.
// Shared with the histogram, so one legend covers both. Values mirror the
// --drive-* tokens; MapLibre paint cannot read CSS custom properties.
export const DRIVE_COLORS = ['#103d52', '#2b7f9f', '#74bdd3', '#cbe8f2'] as const;
export const DRIVE_OVER_COLOR = '#a84d4d';

const ISO_BANDS: { minutes: number; color: string; opacity: number }[] = [
  { minutes: 15, color: DRIVE_COLORS[0], opacity: 0.30 },
  { minutes: 30, color: DRIVE_COLORS[1], opacity: 0.22 },
  { minutes: 45, color: DRIVE_COLORS[2], opacity: 0.16 },
  { minutes: 60, color: DRIVE_COLORS[3], opacity: 0.12 },
];

export default function MapView(props: Props) {
  const { households, attenders, centroids, candidates, center, layers, onSelect } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const [ready, setReady] = useState(false);
  const [styleFailed, setStyleFailed] = useState(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      center: [center?.lon ?? -117.37, center?.lat ?? 33.93],
      zoom: 9.6,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');
    map.on('load', () => setReady(true));
    map.on('error', (e) => {
      // A blocked or unreachable tile host should degrade to an empty canvas
      // with a plain explanation, not an inscrutable blank page.
      if (String(e?.error?.message ?? '').match(/style|fetch|load/i)) setStyleFailed(true);
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- sources and layers ------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const ensureSource = (id: string, data: GeoJSON.FeatureCollection) => {
      const src = map.getSource(id) as GeoJSONSource | undefined;
      if (src) src.setData(data);
      else map.addSource(id, { type: 'geojson', data });
    };

    const dm = props.driveMinutes;
    const hhFeatures: GeoJSON.Feature[] = households
      .filter((h) => h.lat != null && h.lon != null)
      .map((h) => ({
        type: 'Feature',
        properties: {
          id: h.id, zip: h.zip, outlier: h.outlier, corrected: h.corrected, kind: 'donor',
          // -1 means "not measured", which must not read as a short drive.
          drive_min: dm ? (dm[h.id] ?? -1) : -1,
        },
        geometry: { type: 'Point', coordinates: [h.lon!, h.lat!] },
      }));
    const attFeatures: GeoJSON.Feature[] = attenders
      .filter((a) => a.lat != null && a.lon != null)
      .map((a) => ({
        type: 'Feature',
        properties: {
          id: a.id, zip: a.zip, outlier: 0, weight: a.household_size, kind: 'attender',
          drive_min: dm ? (dm[a.id] ?? -1) : -1,
        },
        geometry: { type: 'Point', coordinates: [a.lon!, a.lat!] },
      }));

    ensureSource('households', { type: 'FeatureCollection', features: [...hhFeatures, ...attFeatures] });

    ensureSource('centroids', {
      type: 'FeatureCollection',
      features: centroids.map((c) => ({
        type: 'Feature',
        properties: { method: c.method, chosen: center?.method === c.method ? 1 : 0 },
        geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
      })),
    });

    ensureSource('ring', {
      type: 'FeatureCollection',
      features: center ? [circle(center.lat, center.lon, props.radiusMi)] : [],
    });

    // Real routed isochrones when the pipeline has produced them; plainly
    // labelled distance circles when it has not.
    const haveRouted = props.isochrones.length > 0;
    ensureSource('isochrones', {
      type: 'FeatureCollection',
      features: haveRouted
        ? props.isochrones
        : center
          ? ISO_BANDS.map(({ minutes }) => ({
              ...circle(center.lat, center.lon, (PROXY_MPH * minutes) / 60),
              properties: { minutes },
            }))
          : [],
    });

    ensureSource('candidates', {
      type: 'FeatureCollection',
      features: candidates.map((c) => ({
        type: 'Feature',
        properties: {
          id: c.id,
          name: c.name,
          status: c.status,
          color: STATUS_COLOR[c.status] ?? '#888',
          size: c.capacity_confirmed
            ? 10
            : c.capacity_est === 'likely_200+'
              ? 9
              : c.capacity_est === 'possible'
                ? 7
                : c.capacity_est === 'unknown'
                  ? 5.5
                  : 4.5,
        },
        geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
      })),
    });

    const add = (layer: maplibregl.LayerSpecification) => {
      if (!map.getLayer(layer.id)) map.addLayer(layer);
    };

    // Heatmap tuning for a small, clustered set. With only a few dozen points
    // spread over forty miles, a wide radius smears everything into one pale
    // blob and the Riverside cluster stops reading at all. A tighter radius
    // and higher intensity let the core show while single outlying households
    // stay visible as faint marks rather than vanishing.
    add({
      id: 'hh-heat', type: 'heatmap', source: 'households',
      filter: ['==', ['get', 'outlier'], 0],
      paint: {
        'heatmap-weight': ['coalesce', ['get', 'weight'], 1],
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 7, 1.6, 10, 2.4, 14, 3.2],
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 7, 12, 10, 22, 14, 46],
        'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0.75, 13, 0.6, 15, 0.35],
        'heatmap-color': [
          'interpolate', ['linear'], ['heatmap-density'],
          0.00, 'rgba(0,0,0,0)',
          0.12, 'rgba(173,216,230,0.45)',
          0.30, 'rgba(95,179,212,0.62)',
          0.50, 'rgba(31,111,143,0.75)',
          0.72, 'rgba(19,71,92,0.85)',
          1.00, 'rgba(10,42,56,0.92)',
        ],
      },
    });

    add({
      id: 'hh-points', type: 'circle', source: 'households',
      paint: {
        'circle-radius': ['case', ['==', ['get', 'kind'], 'attender'], 5, 4],
        // When a candidate is selected its routed drive time takes over the
        // colour, so the map answers "how far would everyone drive to THIS
        // building" directly. Otherwise households keep their identity colours.
        'circle-color': [
          'case',
          ['==', ['get', 'outlier'], 1], '#a84d4d',
          ['>=', ['get', 'drive_min'], 0],
          [
            'step', ['get', 'drive_min'],
            DRIVE_COLORS[0],
            15, DRIVE_COLORS[1],
            30, DRIVE_COLORS[2],
            45, DRIVE_COLORS[3],
            60, DRIVE_OVER_COLOR, // beyond an hour: out of reach, not just far
          ],
          ['==', ['get', 'kind'], 'attender'], '#2f8f5b',
          '#1f6f8f',
        ],
        'circle-opacity': 0.85,
        'circle-stroke-width': ['case', ['==', ['get', 'corrected'], 1], 2, 1],
        'circle-stroke-color': ['case', ['==', ['get', 'corrected'], 1], '#c08a2e', '#ffffff'],
      },
    });

    // Draw furthest band first so nearer, darker bands sit on top.
    const isoMatchColor: unknown[] = ['match', ['get', 'minutes']];
    const isoMatchOpacity: unknown[] = ['match', ['get', 'minutes']];
    for (const b of ISO_BANDS) {
      isoMatchColor.push(b.minutes, b.color);
      isoMatchOpacity.push(b.minutes, b.opacity);
    }
    isoMatchColor.push('#1f6f8f');
    isoMatchOpacity.push(0.14);

    add({
      id: 'iso-fill', type: 'fill', source: 'isochrones',
      paint: {
        'fill-color': isoMatchColor as unknown as maplibregl.ExpressionSpecification,
        'fill-opacity': isoMatchOpacity as unknown as maplibregl.ExpressionSpecification,
      },
    });
    add({
      id: 'iso-outline', type: 'line', source: 'isochrones',
      paint: {
        'line-color': isoMatchColor as unknown as maplibregl.ExpressionSpecification,
        'line-width': 1.2,
        'line-opacity': 0.75,
        // Dashes signal an estimate; routed isochrones are drawn solid.
        ...(props.isochrones.length ? {} : { 'line-dasharray': [3, 3] as [number, number] }),
      },
    });

    add({
      id: 'ring-line', type: 'line', source: 'ring',
      paint: { 'line-color': '#9a6b1f', 'line-width': 2, 'line-opacity': 0.8 },
    });

    add({
      id: 'cand-points', type: 'circle', source: 'candidates',
      paint: {
        'circle-radius': ['get', 'size'],
        'circle-color': ['get', 'color'],
        'circle-stroke-width': 1.5,
        'circle-stroke-color': '#fff',
        'circle-opacity': 0.9,
      },
    });

    add({
      id: 'centroid-points', type: 'circle', source: 'centroids',
      paint: {
        'circle-radius': ['case', ['==', ['get', 'chosen'], 1], 9, 6],
        'circle-color': ['case', ['==', ['get', 'chosen'], 1], '#9a6b1f', '#8a847a'],
        'circle-stroke-width': 2,
        'circle-stroke-color': '#fff',
      },
    });
    add({
      id: 'centroid-labels', type: 'symbol', source: 'centroids',
      layout: {
        'text-field': ['get', 'method'],
        'text-size': 10,
        'text-offset': [0, 1.4],
        'text-anchor': 'top',
      },
      paint: { 'text-color': '#5f5a52', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
    });
  }, [ready, households, attenders, centroids, candidates, center, props.isochrones, props.driveMinutes, props.radiusMi]);

  // --- layer visibility ---------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const vis: Record<string, boolean> = {
      'hh-heat': layers.heatmap,
      'hh-points': layers.households,
      'centroid-points': layers.centroids,
      'centroid-labels': layers.centroids,
      'ring-line': layers.ring,
      'iso-fill': layers.isochrones,
      'cand-points': layers.candidates,
    };
    for (const [id, on] of Object.entries(vis)) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    }
  }, [ready, layers]);

  // --- interactions -------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10 });

    const onClick = (e: maplibregl.MapMouseEvent) => {
      if (props.pickMode) {
        props.onPickPoint?.(Number(e.lngLat.lat.toFixed(5)), Number(e.lngLat.lng.toFixed(5)));
        return;
      }
      const hits = map.queryRenderedFeatures(e.point, { layers: ['cand-points'] });
      if (hits.length) onSelect(String(hits[0].properties?.id));
    };
    const onMove = (e: maplibregl.MapMouseEvent) => {
      const hits = map.queryRenderedFeatures(e.point, { layers: ['cand-points'] });
      map.getCanvas().style.cursor = props.pickMode ? 'crosshair' : hits.length ? 'pointer' : '';
      if (hits.length && !props.pickMode) {
        const p = hits[0].properties ?? {};
        popup
          .setLngLat(e.lngLat)
          .setHTML(
            `<strong>${String(p.name ?? '').replace(/[<>&]/g, '')}</strong><br><span style="font-size:11px">${
              STATUS_LABEL[p.status as Status] ?? p.status
            }</span>`,
          )
          .addTo(map);
      } else {
        popup.remove();
      }
    };
    map.on('click', onClick);
    map.on('mousemove', onMove);
    return () => {
      map.off('click', onClick);
      map.off('mousemove', onMove);
      popup.remove();
    };
  }, [ready, onSelect, props.pickMode, props.onPickPoint, props]);

  // --- recentre when the chosen centroid changes --------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !center) return;
    map.easeTo({ center: [center.lon, center.lat], duration: 600 });
  }, [ready, center]);

  return (
    <>
      <div ref={containerRef} className="map" />
      {styleFailed && (
        <div className="empty" style={{ position: 'absolute', inset: 'auto 0 50% 0' }}>
          The basemap could not load. The data layers still work, but
          tiles.openfreemap.org is unreachable from this network.
        </div>
      )}
      <div className="attribution">
        © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · tiles by OpenFreeMap
      </div>
    </>
  );
}

export function statusLegend() {
  return STATUS_ORDER.map((s) => ({ status: s, label: STATUS_LABEL[s], color: STATUS_COLOR[s] }));
}
