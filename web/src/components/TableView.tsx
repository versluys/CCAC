/** Sortable, filterable candidate table with bulk status change (PRD §10). */

import { useMemo, useState } from 'react';
import type { Candidate, CapacityBand, Status } from '../types';
import { CAPACITY_LABEL, STATUS_COLOR, STATUS_LABEL, STATUS_ORDER } from '../types';

type SortKey = 'name' | 'fit_score' | 'capacity_est' | 'distance_mi_from_center' | 'status' | 'capacity_confirmed';

interface Props {
  candidates: Candidate[];
  onSelect: (id: string) => void;
  onBulkStatus: (ids: string[], status: Status) => void;
  busy: boolean;
}

const CAP_RANK: Record<CapacityBand, number> = { 'likely_200+': 3, possible: 2, unknown: 1, unlikely: 0 };

export default function TableView({ candidates, onSelect, onBulkStatus, busy }: Props) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'fit_score', dir: -1 });
  const [fStatus, setFStatus] = useState('');
  const [fCapacity, setFCapacity] = useState('');
  const [fTenancy, setFTenancy] = useState('');
  const [maxMiles, setMaxMiles] = useState('');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<Status>('shortlisted');

  const rows = useMemo(() => {
    const limit = Number(maxMiles);
    const needle = q.trim().toLowerCase();
    const out = candidates.filter((c) => {
      if (fStatus && c.status !== fStatus) return false;
      if (fCapacity && c.capacity_est !== fCapacity) return false;
      if (fTenancy && c.tenancy_possible !== fTenancy) return false;
      if (Number.isFinite(limit) && maxMiles && (c.distance_mi_from_center ?? Infinity) > limit) return false;
      if (needle && !`${c.name} ${c.denomination ?? ''} ${c.address ?? ''}`.toLowerCase().includes(needle)) return false;
      return true;
    });
    const val = (c: Candidate) => {
      switch (sort.key) {
        case 'name': return c.name.toLowerCase();
        case 'capacity_est': return CAP_RANK[c.capacity_est] ?? 0;
        case 'status': return STATUS_ORDER.indexOf(c.status);
        case 'capacity_confirmed': return c.capacity_confirmed ?? -1;
        case 'distance_mi_from_center': return c.distance_mi_from_center ?? Infinity;
        default: return c.fit_score;
      }
    };
    return out.sort((a, b) => {
      const x = val(a), y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [candidates, sort, fStatus, fCapacity, fTenancy, maxMiles, q]);

  const head = (key: SortKey, label: string, cls = '') => (
    <th className={cls} onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === -1 ? 1 : -1 }))}
        aria-sort={sort.key === key ? (sort.dir === -1 ? 'descending' : 'ascending') : 'none'}>
      {label}{sort.key === key ? (sort.dir === -1 ? ' ↓' : ' ↑') : ''}
    </th>
  );

  const allPicked = rows.length > 0 && rows.every((r) => picked.has(r.id));

  return (
    <div className="table-wrap">
      <div className="filters">
        <div>
          <label htmlFor="q">Search</label>
          <input id="q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="name, denomination, address" />
        </div>
        <div>
          <label htmlFor="fs">Status</label>
          <select id="fs" value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
            <option value="">all</option>
            {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="fc">Capacity band</label>
          <select id="fc" value={fCapacity} onChange={(e) => setFCapacity(e.target.value)}>
            <option value="">all</option>
            {(Object.keys(CAPACITY_LABEL) as CapacityBand[]).map((b) => (
              <option key={b} value={b}>{CAPACITY_LABEL[b]}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="ft">Tenancy</label>
          <select id="ft" value={fTenancy} onChange={(e) => setFTenancy(e.target.value)}>
            <option value="">all</option>
            {['sole', 'shared', 'either', 'no', 'unknown'].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="fm">Max miles from centre</label>
          <input id="fm" type="number" min={0} inputMode="decimal" value={maxMiles}
            onChange={(e) => setMaxMiles(e.target.value)} placeholder="20" />
        </div>
      </div>

      {picked.size > 0 && (
        <div className="row" style={{ marginBottom: 10 }}>
          <strong>{picked.size} selected</strong>
          <select value={bulk} onChange={(e) => setBulk(e.target.value as Status)} style={{ width: 'auto' }}>
            {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
          <button className="primary" disabled={busy}
            onClick={() => { onBulkStatus([...picked], bulk); setPicked(new Set()); }}>
            Apply to {picked.size}
          </button>
          <button onClick={() => setPicked(new Set())}>Clear</button>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="empty">
          No candidates match. {candidates.length === 0 && (
            <>Run <code>scripts/churches.py</code> to discover churches, or add one by hand from the map.</>
          )}
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th style={{ width: 30 }}>
                <input type="checkbox" aria-label="Select all" checked={allPicked}
                  style={{ width: 18, height: 18, minHeight: 0 }}
                  onChange={(e) => setPicked(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} />
              </th>
              {head('name', 'Church')}
              {head('status', 'Status')}
              {head('fit_score', 'Score', 'num')}
              {head('capacity_est', 'Capacity (est.)')}
              {head('capacity_confirmed', 'Seats', 'num')}
              {head('distance_mi_from_center', 'Miles', 'num')}
              <th>Tenancy</th>
              <th className="num">Yrs to 80%</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" aria-label={`Select ${c.name}`} checked={picked.has(c.id)}
                    style={{ width: 18, height: 18, minHeight: 0 }}
                    onChange={(e) => {
                      const next = new Set(picked);
                      e.target.checked ? next.add(c.id) : next.delete(c.id);
                      setPicked(next);
                    }} />
                </td>
                <td onClick={() => onSelect(c.id)} style={{ cursor: 'pointer' }}>
                  <strong>{c.name}</strong>
                  {c.transfer_overlap === 'yes' && <> <span className="badge caution">rector first</span></>}
                  <div className="tiny">{c.denomination ?? '—'}</div>
                </td>
                <td onClick={() => onSelect(c.id)} style={{ cursor: 'pointer' }}>
                  <span className="dot" style={{ background: STATUS_COLOR[c.status] }} /> {STATUS_LABEL[c.status]}
                </td>
                <td className="num" onClick={() => onSelect(c.id)}>{c.fit_score}</td>
                <td onClick={() => onSelect(c.id)}>
                  {CAPACITY_LABEL[c.capacity_est]}
                  {!c.capacity_confirmed && <span className="tiny"> est.</span>}
                </td>
                <td className="num" onClick={() => onSelect(c.id)}>{c.capacity_confirmed ?? '—'}</td>
                <td className="num" onClick={() => onSelect(c.id)}>{c.distance_mi_from_center?.toFixed(1) ?? '—'}</td>
                <td onClick={() => onSelect(c.id)}>{c.tenancy_possible}</td>
                <td className="num" onClick={() => onSelect(c.id)}>
                  {c.years_to_80pct_base ?? '—'}
                  {c.outgrows_lease && <span className="badge caution"> short</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="tiny" style={{ marginTop: 10 }}>
        Capacity columns marked "est." come from building footprint and parking, not a seat count.
      </div>
    </div>
  );
}
