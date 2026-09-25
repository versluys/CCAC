/**
 * Christ's Chapel Site Finder.
 *
 * Three questions in order (PRD §1): where does the congregation live, which
 * churches sit within 20 miles of that centre, and which of those could seat
 * about 200 and might lease to us. The header keeps the first question's
 * honest answer permanently in view — how many households we could actually
 * place — so nobody mistakes 43 mapped dots for a congregation of 95.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from './api';
import MapView, { DRIVE_COLORS, type Layers } from './components/MapView';
import DriveHistogram from './components/DriveHistogram';
import AddCandidate from './components/AddCandidate';
import Drawer from './components/Drawer';
import TableView from './components/TableView';
import PipelineView from './components/PipelineView';
import { DataQualityPanel, SettingsPanel } from './components/Panels';
import type { Attender, Candidate, Centroid, DataQuality, Household, Status } from './types';
import { STATUS_COLOR, STATUS_LABEL, STATUS_ORDER } from './types';

type Tab = 'map' | 'table' | 'pipeline' | 'quality' | 'settings';

const TABS: { id: Tab; label: string }[] = [
  { id: 'map', label: 'Map' },
  { id: 'table', label: 'Table' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'quality', label: 'Data quality' },
  { id: 'settings', label: 'Settings' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('map');
  const [email, setEmail] = useState<string>('');
  const [households, setHouseholds] = useState<Household[]>([]);
  const [attenders, setAttenders] = useState<Attender[]>([]);
  const [privacyNote, setPrivacyNote] = useState('');
  const [centroids, setCentroids] = useState<Centroid[]>([]);
  const [chosenMethod, setChosenMethod] = useState<string>('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [quality, setQuality] = useState<DataQuality | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; bad: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [proxyBands, setProxyBands] = useState<Record<string, { share: number; count: number; total: number }> | null>(null);
  const [isochrones, setIsochrones] = useState<GeoJSON.Feature[]>([]);
  const [isoMeta, setIsoMeta] = useState<{ method: string | null; spacing: number | null; caveat: string } | null>(null);
  const [driveMinutes, setDriveMinutes] = useState<Record<string, number | null> | null>(null);
  const [driveInfo, setDriveInfo] = useState<{
    source: 'osrm' | 'proxy';
    bands: Record<string, { share: number; count: number }>;
    median: number | null;
    households: number;
    name: string;
  } | null>(null);
  const [drivePending, setDrivePending] = useState(false);
  const [radiusMi, setRadiusMi] = useState(40);
  const [pickMode, setPickMode] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addSeed, setAddSeed] = useState<{ lat: number; lon: number } | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [layers, setLayers] = useState<Layers>({
    heatmap: true, households: true, centroids: true, ring: true, isochrones: false, candidates: true,
  });

  const notify = useCallback((msg: string, bad = false) => {
    setToast({ msg, bad });
    window.setTimeout(() => setToast(null), bad ? 6000 : 2800);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [meRes, hhRes, cRes, candRes, dqRes] = await Promise.all([
          api.me(), api.households(), api.centroids(), api.candidates(), api.dataQuality(),
        ]);
        setEmail(meRes.email);
        setHouseholds(hhRes.households);
        setAttenders(hhRes.attenders);
        setPrivacyNote(hhRes.privacy_note);
        setCentroids(cRes.centroids);
        setChosenMethod(cRes.default_method ?? cRes.centroids[0]?.method ?? '');
        setCandidates(candRes.candidates);
        setQuality(dqRes);

        try {
          const settings = await api.settings();
          if (settings.screen?.search_radius_mi) setRadiusMi(settings.screen.search_radius_mi);
        } catch {
          /* keep the default */
        }

        // Isochrones are optional: the pipeline step that produces them needs a
        // routing service, so the map must work without them.
        try {
          const iso = await api.isochrones();
          setIsochrones(iso.features);
          setIsoMeta({
            method: iso.center?.method ?? null,
            spacing: iso.grid_spacing_km,
            caveat: iso.caveat,
          });
        } catch {
          setIsochrones([]);
        }
      } catch (e) {
        const err = e as ApiError;
        setFatal(
          err.status === 403
            ? 'Your Cloudflare Access session has lapsed or your account is not on the policy. Reload to sign in again.'
            : `Could not load: ${err.message}`,
        );
      }
    })();
  }, []);

  const center = useMemo(
    () => centroids.find((c) => c.method === chosenMethod) ?? centroids[0] ?? null,
    [centroids, chosenMethod],
  );

  // Drive bands, and where they came from.
  //
  // centroid.py routes real drive times through OSRM and stores the result
  // with each centroid. Those are the numbers the committee saw in the
  // terminal and the ones that should appear here. The Worker's own
  // /api/drive-share is a straight-line proxy at a flat 27 mph; it exists only
  // for a point the pipeline never measured, such as a candidate added by hand
  // on the map. Showing the proxy when routed figures exist would quietly
  // contradict the pipeline, which is how this looked wrong in the first place.
  const routed = useMemo(() => {
    const ds = center?.drive_stats;
    if (!ds || typeof ds.within_20min !== 'number') return null;
    const total = center?.n ?? 0;
    const bands: Record<string, { share: number; count: number; total: number }> = {};
    for (const m of [10, 15, 20, 30]) {
      const share = ds[`within_${m}min`];
      if (typeof share !== 'number') return null;
      bands[String(m)] = {
        share,
        count: ds[`within_${m}min_count`] ?? Math.round(share * total),
        total,
      };
    }
    return { bands, medianMin: ds.median_min, meanMin: ds.mean_min };
  }, [center]);

  // Only ask the Worker for a proxy when there is nothing routed to show.
  useEffect(() => {
    if (!center || routed) { setProxyBands(null); return; }
    let live = true;
    api.driveShare(center.lat, center.lon)
      .then((r) => live && setProxyBands(r.bands))
      .catch(() => live && setProxyBands(null));
    return () => { live = false; };
  }, [center, routed]);

  // The stored centroid figures are cumulative shares, not per-household
  // minutes. Differencing adjacent bands recovers the bucket counts, which is
  // all the histogram needs; each synthetic value sits inside its own bucket.
  const centroidMinutes = useMemo(() => {
    const bands = routed?.bands ?? proxyBands;
    if (!bands) return null;
    const edges = [15, 30, 45, 60];
    const total = Object.values(bands)[0]?.total ?? 0;
    if (!total) return null;
    const cum = (m: number) => bands[String(m)]?.count ?? null;
    if (edges.some((m) => cum(m) == null)) return null;
    const mins: number[] = [];
    let prev = 0;
    edges.forEach((edge, i) => {
      const n = (cum(edge) ?? 0) - prev;
      prev = cum(edge) ?? 0;
      const mid = i === 0 ? edge / 2 : (edges[i - 1] + edge) / 2;
      for (let k = 0; k < Math.max(0, n); k++) mins.push(mid);
    });
    for (let k = 0; k < Math.max(0, total - prev); k++) mins.push(edges[edges.length - 1] + 5);
    return { minutes: mins, total, source: (routed ? 'osrm' : 'proxy') as 'osrm' | 'proxy' };
  }, [routed, proxyBands]);

  const driveBands = routed?.bands ?? proxyBands;
  const driveSource: 'routed' | 'proxy' | null = routed ? 'routed' : proxyBands ? 'proxy' : null;

  // Routed drive times from the selected candidate to every household. This is
  // the question a building has to answer: if the parish moved here, how far
  // would people drive? One OSRM table request covers the whole congregation,
  // so it is computed on selection and cached server-side thereafter.
  useEffect(() => {
    if (!selected) { setDriveMinutes(null); setDriveInfo(null); return; }
    const candidate = candidates.find((c) => c.id === selected);
    let live = true;
    setDrivePending(true);
    api.candidateDrive(selected)
      .then((d) => {
        if (!live) return;
        setDriveMinutes(d.minutes);
        setDriveInfo({
          source: d.source,
          bands: d.bands,
          median: d.median_min,
          households: d.households,
          name: candidate?.name ?? 'this candidate',
        });
      })
      .catch(() => { if (live) { setDriveMinutes(null); setDriveInfo(null); } })
      .finally(() => { if (live) setDrivePending(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const replaceCandidate = useCallback((c: Candidate) => {
    setCandidates((prev) => prev.map((p) => (p.id === c.id ? c : p)));
  }, []);

  const setStatus = useCallback(async (ids: string[], status: Status) => {
    setBusy(true);
    const failures: string[] = [];
    for (const id of ids) {
      try {
        const { candidate } = await api.patchCandidate(id, { status });
        replaceCandidate(candidate);
      } catch (e) {
        failures.push(`${id}: ${(e as Error).message}`);
      }
    }
    setBusy(false);
    notify(
      failures.length
        ? `${ids.length - failures.length} of ${ids.length} updated; ${failures.length} failed`
        : `${ids.length} moved to ${STATUS_LABEL[status]}`,
      failures.length > 0,
    );
  }, [notify, replaceCandidate]);

  // Clicking the map seeds the form rather than firing a bare prompt: the
  // coordinates are the easy part, and everything else worth recording needs
  // somewhere to go.
  const addManual = useCallback((lat: number, lon: number) => {
    setPickMode(false);
    setAddSeed({ lat, lon });
    setAddOpen(true);
  }, []);

  const afterAdd = useCallback(async (ids: string[]) => {
    try {
      const fresh = await api.candidates();
      setCandidates(fresh.candidates);
      if (ids.length === 1) setSelected(ids[0]);
    } catch (e) {
      notify((e as Error).message, true);
    }
  }, [notify]);

  if (fatal) {
    return (
      <div className="empty" style={{ paddingTop: 80 }}>
        <p>{fatal}</p>
        <button className="primary" onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }

  const placed = households.filter((h) => h.lat != null).length;
  const within20 = driveBands?.['20'];
  const likely = candidates.filter((c) => c.capacity_est === 'likely_200+').length;
  const shortlisted = candidates.filter((c) => c.status === 'shortlisted').length;
  const contacted = candidates.filter((c) => c.status === 'contacted').length;

  return (
    <div className="app">
      <header className="header">
        <div className="header-top">
          <h1>Christ's Chapel Site Finder</h1>
          <span className="muted">
            {center ? `centre: ${center.method}` : 'no centre computed'}
          </span>
          <span className="who">{email}</span>
        </div>

        {candidates.some((c) => c.is_example) && (
          <div className="caveat" style={{ margin: 0, padding: '6px 10px', fontSize: 12 }}>
            <strong>{candidates.filter((c) => c.is_example).length} of these candidates are
            fictional examples</strong>, named after places in Narnia so they cannot be
            mistaken for real churches. They exist to demonstrate the tool. Remove them with{' '}
            <code>scripts/make_examples.py --clear</code>, then re-seed.
          </div>
        )}

        <div className="kpis">
          <Kpi v={`${placed} of ${households.length}`} l="Households placed"
               sub={`${households.length - placed} have no address on file`} />
          <Kpi v={within20 ? `${Math.round(within20.share * 100)}%` : '—'} l="Within 20 min of centre"
               sub={
                 within20
                   ? `${within20.count} of ${within20.total} · ${
                       driveSource === 'routed' ? 'routed drive time' : 'straight-line estimate'
                     }`
                   : 'not computed'
               } />
          <Kpi v={candidates.length} l="Candidates found"
               sub={candidates.length === 0 ? 'run churches.py' : 'within 20 miles'} />
          <Kpi v={likely} l="Likely 200+" sub="estimated, unconfirmed" />
          <Kpi v={shortlisted} l="Shortlisted" />
          <Kpi v={contacted} l="Contacted" />
        </div>

        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
          <span className="spacer" />
          <button className="primary" onClick={() => { setAddSeed(null); setAddOpen(true); }}>
            + Add candidate
          </button>
        </nav>
      </header>

      <main className="main">
        {tab === 'map' && (
          <div className="pane map-pane">
            <MapView
              households={households}
              attenders={attenders}
              centroids={centroids}
              candidates={candidates}
              center={center}
              isochrones={isochrones}
              driveMinutes={driveMinutes}
              radiusMi={radiusMi}
              layers={layers}
              onSelect={setSelected}
              pickMode={pickMode}
              onPickPoint={addManual}
            />
            <div className={`map-overlay${panelOpen ? '' : ' collapsed'}`}>
              <div className="row">
                <strong style={{ fontSize: 13 }}>Layers</strong>
                <span className="spacer" />
                <button style={{ minHeight: 28, padding: '2px 8px' }}
                  onClick={() => setPanelOpen((v) => !v)}>{panelOpen ? '−' : '+'}</button>
              </div>
              {panelOpen && (
                <>
                  {([
                    ['heatmap', 'Household heatmap'],
                    ['households', 'Household points'],
                    ['centroids', 'Centroid markers'],
                    ['ring', `${radiusMi}-mile search ring`],
                    ['isochrones', isochrones.length
                      ? 'Drive-time isochrones (15/30/45/60 min)'
                      : '15/30/45/60-min distance rings'],
                    ['candidates', 'Candidate churches'],
                  ] as [keyof Layers, string][]).map(([k, label]) => (
                    <label className="layer-row" key={k}>
                      <input type="checkbox" checked={layers[k]}
                        onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} />
                      {label}
                    </label>
                  ))}

                  <div style={{ marginTop: 10 }}>
                    <label htmlFor="cm">Search centre</label>
                    <select id="cm" value={chosenMethod} onChange={(e) => setChosenMethod(e.target.value)}>
                      {centroids.map((c) => <option key={c.method} value={c.method}>{c.method}</option>)}
                    </select>
                    {center?.note && <div className="tiny" style={{ marginTop: 4 }}>{center.note}</div>}
                  </div>

                  {driveBands && (
                    <div className="tiny" style={{ marginTop: 8 }}>
                      Households within: {[10, 15, 20, 30].map((m) => (
                        <span key={m}>{m}m {Math.round((driveBands[String(m)]?.share ?? 0) * 100)}% </span>
                      ))}
                      <div>
                        {driveSource === 'routed' ? (
                          <>
                            Routed drive times from OSRM.
                            {routed?.medianMin != null && <> Median drive {routed.medianMin} min.</>}
                          </>
                        ) : (
                          <>Straight-line estimate at 27 mph. Run centroid.py to route these properly.</>
                        )}
                      </div>
                    </div>
                  )}

                  {layers.isochrones && (
                    isochrones.length ? (
                      <div className="tiny" style={{ marginTop: 6 }}>
                        <div className="row" style={{ gap: 6, marginBottom: 4 }}>
                          {[15, 30, 45, 60].map((m, i) => (
                            <span key={m}>
                              <i className="dot" style={{ background: DRIVE_COLORS[i], borderRadius: 2 }} /> {m}m
                            </span>
                          ))}
                        </div>
                        Routed through OSRM
                        {isoMeta?.spacing ? ` on a ${isoMeta.spacing} km grid` : ''}
                        {isoMeta?.method ? ` from ${isoMeta.method}` : ''}. Edges are blocky at the
                        grid spacing on purpose. Free-flow times, so a Sunday morning is usually
                        a little quicker.
                      </div>
                    ) : (
                      <div className="caveat" style={{ marginTop: 6, fontSize: 12 }}>
                        These are circles of equal <em>distance</em>, sized at 27 mph, not
                        isochrones. A real 20-minute reach follows the 91 and the 215 and looks
                        nothing like a circle. Run <code>scripts/isochrones.py</code> and re-seed
                        to replace them with routed shapes.
                      </div>
                    )
                  )}

                  {driveMinutes && driveInfo ? (
                    <DriveHistogram
                      minutes={Object.values(driveMinutes)}
                      total={driveInfo.households}
                      source={driveInfo.source}
                      subject={driveInfo.name}
                    />
                  ) : centroidMinutes ? (
                    <DriveHistogram
                      minutes={centroidMinutes.minutes}
                      total={centroidMinutes.total}
                      source={centroidMinutes.source}
                      subject={`the ${center?.method ?? 'chosen'} centre`}
                    />
                  ) : drivePending ? (
                    <div className="tiny" style={{ marginTop: 10 }}>Routing the congregation to this candidate…</div>
                  ) : null}

                  <div className="legend">
                    {!driveInfo && <span><i className="dot" style={{ background: DRIVE_COLORS[1] }} /> donor household</span>}
                    <span><i className="dot" style={{ background: '#2f8f5b' }} /> attender card</span>
                    <span><i className="dot" style={{ background: '#a84d4d' }} /> outlier (excluded)</span>
                    {STATUS_ORDER.slice(0, 5).map((s) => (
                      <span key={s}><i className="dot" style={{ background: STATUS_COLOR[s] }} /> {STATUS_LABEL[s]}</span>
                    ))}
                  </div>

                  <button style={{ marginTop: 10, width: '100%' }} className="primary"
                    onClick={() => { setAddSeed(null); setAddOpen(true); }}>
                    Add a candidate
                  </button>
                  <button style={{ marginTop: 6, width: '100%' }} aria-pressed={pickMode}
                    onClick={() => setPickMode((v) => !v)}>
                    {pickMode ? 'Tap the map to place it…' : 'Add by clicking the map'}
                  </button>
                </>
              )}
            </div>
            {selected && (
              <Drawer id={selected} onClose={() => setSelected(null)}
                onChanged={replaceCandidate} notify={notify} />
            )}
          </div>
        )}

        {tab === 'table' && (
          <div className="pane">
            <TableView candidates={candidates} onSelect={setSelected}
              onBulkStatus={setStatus} busy={busy} />
            {selected && (
              <Drawer id={selected} onClose={() => setSelected(null)}
                onChanged={replaceCandidate} notify={notify} />
            )}
          </div>
        )}

        {tab === 'pipeline' && (
          <div className="pane">
            <PipelineView candidates={candidates} onSelect={setSelected}
              onMove={(id, s) => setStatus([id], s)} busy={busy} />
            {selected && (
              <Drawer id={selected} onClose={() => setSelected(null)}
                onChanged={replaceCandidate} notify={notify} />
            )}
          </div>
        )}

        {tab === 'quality' && (
          <div className="pane">
            <DataQualityPanel quality={quality} centroids={centroids}
              chosen={center} privacyNote={privacyNote} />
          </div>
        )}

        {tab === 'settings' && (
          <div className="pane"><SettingsPanel notify={notify} /></div>
        )}
      </main>

      {addOpen && (
        <AddCandidate
          seed={addSeed}
          notify={notify}
          onAdded={afterAdd}
          onClose={() => { setAddOpen(false); setAddSeed(null); }}
        />
      )}

      {toast && <div className={`toast${toast.bad ? ' bad' : ''}`}>{toast.msg}</div>}
    </div>
  );
}

function Kpi({ v, l, sub }: { v: string | number; l: string; sub?: string }) {
  return (
    <div className="kpi">
      <div className="v">{v}</div>
      <div className="l">{l}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}
