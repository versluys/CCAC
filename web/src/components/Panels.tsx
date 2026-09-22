/** Data quality and settings panels (PRD 7.4a, 7.6, §10). */

import { Fragment, useEffect, useState } from 'react';
import { api } from '../api';
import type { Centroid, DataQuality, Growth, Weights } from '../types';

export function DataQualityPanel({
  quality, centroids, chosen, privacyNote,
}: {
  quality: DataQuality | null;
  centroids: Centroid[];
  chosen: Centroid | null;
  privacyNote: string;
}) {
  if (!quality) return <div className="empty">Loading…</div>;
  const t = quality.totals ?? {};
  const placed = t.placed ?? 0;
  const total = t.households ?? 0;

  return (
    <div className="panel-wrap">
      <div className="caveat">
        <strong>Read this before quoting any number on this page.</strong>
        <ul>
          {quality.caveats.map((c) => <li key={c}>{c}</li>)}
        </ul>
      </div>

      <div className="panel">
        <h2>Household placement</h2>
        <dl className="facts">
          <dt>Donor rows on file</dt><dd>{total}</dd>
          <dt>Placed on the map</dt><dd>{placed} ({total ? Math.round((placed / total) * 100) : 0}%)</dd>
          <dt>Could not be placed</dt><dd>{t.unplaced ?? 0} — no address in the giving record</dd>
          <dt>Flagged as outliers</dt><dd>{t.outliers ?? 0} — out of state, or far from the core</dd>
          <dt>Parish-corrected addresses</dt><dd>{t.corrected ?? 0}</dd>
          <dt>Attender ZIP cards</dt><dd>{t.attenders ?? 0}</dd>
        </dl>
        {(t.attenders ?? 0) === 0 && (
          <div className="tiny" style={{ marginTop: 8 }}>
            No attender ZIP card has been collected yet. Until one is, the centre is
            derived from the giving record alone, which leans toward longer-tenured
            members and under-weights the recent transfer growth.
          </div>
        )}
      </div>

      <div className="panel">
        <h2>Geocode match quality</h2>
        <table>
          <thead><tr><th>Quality</th><th className="num">Households</th><th>What it means</th></tr></thead>
          <tbody>
            {Object.entries(quality.match_quality).map(([k, v]) => (
              <tr key={k}>
                <td className="mono">{k}</td>
                <td className="num">{v}</td>
                <td className="tiny">
                  {k === 'exact' && 'Address matched a rooftop or parcel.'}
                  {k === 'interpolated' && 'Position estimated along a street segment.'}
                  {k === 'zip-only' && 'Placed at the ZIP centroid — the right ZIP, not the right house.'}
                  {k === 'zip-only-coarse' && 'Placed at a coarse published ZIP point, outside California.'}
                  {k === 'failed' && 'Could not be placed at all.'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h2>Centroid methods</h2>
        <table>
          <thead><tr><th>Method</th><th>Position</th><th className="num">Points</th><th>Note</th></tr></thead>
          <tbody>
            {centroids.map((c) => (
              <tr key={c.method} style={{ fontWeight: c.method === chosen?.method ? 600 : 400 }}>
                <td className="mono">{c.method}{c.method === chosen?.method ? ' ★' : ''}</td>
                <td className="mono">{c.lat.toFixed(4)}, {c.lon.toFixed(4)}</td>
                <td className="num">{c.n ?? '—'}</td>
                <td className="tiny">{c.note ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!centroids.some((c) => c.method === 'drive_time_median') && (
          <div className="tiny" style={{ marginTop: 8 }}>
            The drive-time median is missing. It needs a routing service, so run{' '}
            <code>scripts/centroid.py</code> from a machine that can reach OSRM and re-seed.
            Until then the geometric median stands in, and the drive-band figures on this
            site are straight-line estimates rather than routed drive times.
          </div>
        )}
      </div>

      <div className="panel">
        <h2>Candidate capacity bands</h2>
        <dl className="facts">
          {Object.entries(quality.capacity_bands).map(([k, v]) => (
            <Fragment key={k}><dt className="mono">{k}</dt><dd>{v}</dd></Fragment>
          ))}
        </dl>
        <div className="tiny" style={{ marginTop: 8 }}>{privacyNote}</div>
      </div>
    </div>
  );
}

export function SettingsPanel({ notify }: { notify: (m: string, bad?: boolean) => void }) {
  const [weights, setWeights] = useState<Weights | null>(null);
  const [growth, setGrowth] = useState<Growth | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.settings()
      .then((s) => { setWeights(s.weights); setGrowth(s.growth); })
      .catch((e) => notify(e.message, true));
  }, [notify]);

  if (!weights || !growth) return <div className="empty">Loading…</div>;
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);

  return (
    <div className="panel-wrap">
      <div className="panel">
        <h2>Scoring weights</h2>
        <p className="muted">
          The score sorts the list; it does not decide anything. Every candidate's drawer
          shows how its score was built, component by component.
        </p>
        {(Object.keys(weights) as (keyof Weights)[]).map((k) => (
          <div key={k} style={{ marginBottom: 10 }}>
            <label htmlFor={k}>{k.replace(/_/g, ' ')} — {weights[k]}</label>
            <input id={k} type="range" min={0} max={100} value={weights[k]}
              style={{ padding: 0 }}
              onChange={(e) => setWeights({ ...weights, [k]: Number(e.target.value) })} />
          </div>
        ))}
        <div className="row">
          <span className="tiny">Total {sum}{sum !== 100 ? ' (normalised to 100 when scoring)' : ''}</span>
          <span className="spacer" />
          <button className="primary" disabled={busy || sum === 0}
            onClick={async () => {
              setBusy(true);
              try { await api.putWeights(weights); notify('Weights saved'); }
              catch (e) { notify((e as Error).message, true); }
              finally { setBusy(false); }
            }}>Save weights</button>
        </div>
      </div>

      <div className="panel">
        <h2>Growth scenarios</h2>
        <p className="muted">
          Years to 80% full: n = ln(0.8 × seats / ASA) / ln(1 + g). A candidate whose
          base-case figure is shorter than its lease term gets flagged.
        </p>
        <div className="field-grid">
          <div>
            <label htmlFor="asa">Current ASA</label>
            <input id="asa" type="number" min={1} value={growth.asa_current}
              onChange={(e) => setGrowth({ ...growth, asa_current: Number(e.target.value) })} />
          </div>
          <div>
            <label htmlFor="fill">Target fill</label>
            <input id="fill" type="number" step={0.05} min={0.1} max={1} value={growth.target_fill}
              onChange={(e) => setGrowth({ ...growth, target_fill: Number(e.target.value) })} />
          </div>
          {(['conservative', 'base', 'surge'] as const).map((k) => (
            <div key={k}>
              <label htmlFor={k}>{k} annual growth</label>
              <input id={k} type="number" step={0.01} min={0} max={2} value={growth.rates[k]}
                onChange={(e) => setGrowth({ ...growth, rates: { ...growth.rates, [k]: Number(e.target.value) } })} />
            </div>
          ))}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <span className="spacer" />
          <button className="primary" disabled={busy}
            onClick={async () => {
              setBusy(true);
              try { await api.putGrowth(growth); notify('Growth scenarios saved'); }
              catch (e) { notify((e as Error).message, true); }
              finally { setBusy(false); }
            }}>Save scenarios</button>
        </div>
      </div>

      <div className="panel">
        <h2>Export</h2>
        <p className="muted">Candidate list for a vestry packet. Opens cleanly in Excel.</p>
        <a href="/api/export.csv"><button>Download candidates CSV</button></a>
      </div>
    </div>
  );
}
