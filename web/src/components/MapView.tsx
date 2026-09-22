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

// Straight-line rings standing in for drive-time isochrones. Labelled as
// estimates in the legend, because at 27 mph a ring is not an isochrone and
// pretending otherwise would be the single most misleading thing this map
// could do.
const PROXY_MPH = 27;

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

    const hhFeatures: GeoJSON.Feature[] = households
      .filter((h) => h.lat != null && h.lon != null)
      .map((h) => ({
        type: 'Feature',
        properties: { id: h.id, zip: h.zip, outlier: h.outlier, corrected: h.corrected, kind: 'donor' },
        geometry: { type: 'Point', coordinates: [h.lon!, h.lat!] },
      }));
    const attFeatures: GeoJSON.Feature[] = attenders
      .filter((a) => a.lat != null && a.lon != null)
      .map((a) => ({
        type: 'Feature',
        properties: { id: a.id, zip: a.zip, outlier: 0, weight: a.household_size, kind: 'attender' },
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
      features: center ? [circle(center.lat, center.lon, 20)] : [],
    });

    ensureSource('isochrones', {
      type: 'FeatureCollection',
      features: center
        ? [10, 15, 20].map((min) => ({
            ...circle(center.lat, center.lon, (PROXY_MPH * min) / 60),
            properties: { minutes: min },
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

    add({
      id: 'hh-heat', type: 'heatmap', source: 'households',
      filter: ['==', ['get', 'outlier'], 0],
      paint: {
        'heatmap-weight': ['coalesce', ['get', 'weight'], 1],
        'heatmap-intensity': 0.9,
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 8, 18, 13, 42],
        'heatmap-opacity': 0.55,
        'heatmap-color': [
          'interpolate', ['linear'], ['heatmap-density'],
          0, 'rgba(0,0,0,0)', 0.2, 'rgba(120,180,210,0.5)', 0.5, 'rgba(60,140,180,0.7)', 1, 'rgba(20,90,130,0.85)',
        ],
      },
    });

    add({
      id: 'hh-points', type: 'circle', source: 'households',
      paint: {
        'circle-radius': ['case', ['==', ['get', 'kind'], 'attender'], 5, 4],
        'circle-color': [
          'case',
          ['==', ['get', 'outlier'], 1], '#a84d4d',
          ['==', ['get', 'kind'], 'attender'], '#2f8f5b',
          '#1f6f8f',
        ],
        'circle-opacity': 0.75,
        'circle-stroke-width': ['case', ['==', ['get', 'corrected'], 1], 2, 1],
        'circle-stroke-color': ['case', ['==', ['get', 'corrected'], 1], '#c08a2e', '#ffffff'],
      },
    });

    add({
      id: 'iso-fill', type: 'line', source: 'isochrones',
      paint: {
        'line-color': '#1f6f8f',
        'line-width': 1,
        'line-dasharray': [3, 3],
        'line-opacity': 0.6,
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
  }, [ready, households, attenders, centroids, candidates, center]);

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
