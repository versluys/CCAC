/**
 * Enter a candidate by hand.
 *
 * Three ways in, because the committee will have the information in whatever
 * form it arrives: an address from a listing, coordinates from a map, or a
 * pasted block from a broker's email or a saved search. Discovery finds
 * buildings that happen to be mapped; this is how a building somebody actually
 * heard about gets into the pipeline, and it is the path that matters most,
 * since a church nobody has mentioned is rarely the one that leases.
 */

import { useState } from 'react';
import { api } from '../api';
import type { CapacityBand, Tenancy } from '../types';

interface Props {
  onAdded: (ids: string[]) => void;
  onClose: () => void;
  notify: (msg: string, bad?: boolean) => void;
  /** Coordinates already picked on the map, if that is how this was opened. */
  seed?: { lat: number; lon: number } | null;
}

type Mode = 'one' | 'bulk';

const TENANCIES: Tenancy[] = ['unknown', 'sole', 'shared', 'either', 'no'];
const CAPACITIES: CapacityBand[] = ['unknown', 'likely_200+', 'possible', 'unlikely'];

export default function AddCandidate({ onAdded, onClose, notify, seed }: Props) {
  const [mode, setMode] = useState<Mode>('one');
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [lat, setLat] = useState(seed ? String(seed.lat) : '');
  const [lon, setLon] = useState(seed ? String(seed.lon) : '');
  const [denomination, setDenomination] = useState('');
  const [listingUrl, setListingUrl] = useState('');
  const [listed, setListed] = useState(false);
  const [tenancy, setTenancy] = useState<Tenancy>('unknown');
  const [capacity, setCapacity] = useState<CapacityBand>('unknown');
  const [seats, setSeats] = useState('');
  const [notes, setNotes] = useState('');
  const [matches, setMatches] = useState<{ address: string | null; lat: number; lon: number }[] | null>(null);

  const [bulk, setBulk] = useState('');
  const [bulkLog, setBulkLog] = useState<string[]>([]);

  async function lookup() {
    if (address.trim().length < 5) return;
    setBusy(true);
    setMatches(null);
    try {
      const r = await api.geocode(address.trim());
      if (r.matches.length === 0) {
        notify(r.note ?? 'No match for that address', true);
      } else {
        setMatches(r.matches as { address: string | null; lat: number; lon: number }[]);
        const first = r.matches[0];
        setLat(String(first.lat));
        setLon(String(first.lon));
      }
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  async function saveOne() {
    const la = Number(lat);
    const lo = Number(lon);
    if (!name.trim()) return notify('A name is required', true);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) {
      return notify('Look up the address, or type coordinates, or click the map', true);
    }
    setBusy(true);
    try {
      const { candidate } = await api.createCandidate({
        name: name.trim(),
        lat: la,
        lon: lo,
        address: address.trim() || null,
        denomination: denomination.trim() || null,
        listing_url: listingUrl.trim() || null,
        listed_for_lease: listed,
        tenancy_possible: tenancy,
        capacity_est: capacity,
        capacity_confirmed: seats.trim() ? Number(seats) : null,
        denomination_notes: notes.trim() || null,
      });
      notify(`Added ${candidate.name}`);
      onAdded([candidate.id]);
      onClose();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Bulk paste. One candidate per line:
   *   Name, address or "lat,lon", optional listing URL
   * Addresses are geocoded one at a time; anything that cannot be placed is
   * reported rather than dropped, so a paste never silently loses a row.
   */
  async function saveBulk() {
    const lines = bulk.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return;
    if (lines.length > 60) return notify('Paste 60 rows or fewer at a time', true);
    setBusy(true);
    const log: string[] = [];
    const added: string[] = [];

    for (const line of lines) {
      // Split on tabs first (a spreadsheet paste), then commas.
      const parts = (line.includes('\t') ? line.split('\t') : line.split(',')).map((p) => p.trim());
      const rowName = parts[0];
      if (!rowName) { log.push(`skipped (no name): ${line.slice(0, 40)}`); continue; }

      const rest = parts.slice(1).filter(Boolean);
      const url = rest.find((p) => /^https?:\/\//i.test(p));
      const locParts = rest.filter((p) => p !== url);
      const loc = locParts.join(', ');

      let la: number | null = null;
      let lo: number | null = null;
      const coordMatch = /^(-?\d+\.\d+)[,\s]+(-?\d+\.\d+)$/.exec(loc);
      if (coordMatch) {
        la = Number(coordMatch[1]);
        lo = Number(coordMatch[2]);
      } else if (loc.length >= 5) {
        try {
          const r = await api.geocode(loc);
          if (r.matches[0]) { la = r.matches[0].lat!; lo = r.matches[0].lon!; }
        } catch { /* reported below */ }
      }

      if (la == null || lo == null) {
        log.push(`could not place: ${rowName}`);
        continue;
      }
      try {
        const { candidate } = await api.createCandidate({
          name: rowName, lat: la, lon: lo,
          address: coordMatch ? null : loc || null,
          listing_url: url ?? null,
          listed_for_lease: !!url,
        });
        added.push(candidate.id);
        log.push(`added: ${rowName}`);
      } catch (e) {
        log.push(`failed: ${rowName} — ${(e as Error).message}`);
      }
      setBulkLog([...log]);
    }

    setBusy(false);
    setBulkLog(log);
    if (added.length) {
      onAdded(added);
      notify(`${added.length} of ${lines.length} added`, added.length < lines.length);
    } else {
      notify('Nothing could be added', true);
    }
  }

  return (
    <aside className="drawer" role="dialog" aria-label="Add a candidate">
      <div className="drawer-head">
        <div>
          <h2>Add a candidate</h2>
          <div className="tiny">A building somebody heard about, not one the map found.</div>
        </div>
        <button className="x" onClick={onClose} aria-label="Close">✕</button>
      </div>

      <div className="drawer-body">
        <div className="row" style={{ marginBottom: 12 }}>
          <button aria-pressed={mode === 'one'} onClick={() => setMode('one')}>One building</button>
          <button aria-pressed={mode === 'bulk'} onClick={() => setMode('bulk')}>Paste a list</button>
        </div>

        {mode === 'one' ? (
          <>
            <section>
              <div className="field-grid">
                <div className="full">
                  <label htmlFor="ac-name">Name *</label>
                  <input id="ac-name" value={name} onChange={(e) => setName(e.target.value)}
                    placeholder="the church or building" autoFocus />
                </div>
                <div className="full">
                  <label htmlFor="ac-addr">Address</label>
                  <div className="row" style={{ gap: 6 }}>
                    <input id="ac-addr" value={address} onChange={(e) => setAddress(e.target.value)}
                      placeholder="4500 Magnolia Ave, Riverside CA"
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); lookup(); } }} />
                    <button onClick={lookup} disabled={busy || address.trim().length < 5}
                      style={{ flex: '0 0 auto' }}>Look up</button>
                  </div>
                </div>
                {matches && matches.length > 1 && (
                  <div className="full">
                    <label htmlFor="ac-match">Which match?</label>
                    <select id="ac-match" onChange={(e) => {
                      const m = matches[Number(e.target.value)];
                      setLat(String(m.lat)); setLon(String(m.lon));
                      if (m.address) setAddress(m.address);
                    }}>
                      {matches.map((m, i) => (
                        <option key={i} value={i}>{m.address ?? `${m.lat}, ${m.lon}`}</option>
                      ))}
                    </select>
                  </div>
                )}
                <div>
                  <label htmlFor="ac-lat">Latitude *</label>
                  <input id="ac-lat" value={lat} onChange={(e) => setLat(e.target.value)}
                    inputMode="decimal" placeholder="33.94" />
                </div>
                <div>
                  <label htmlFor="ac-lon">Longitude *</label>
                  <input id="ac-lon" value={lon} onChange={(e) => setLon(e.target.value)}
                    inputMode="decimal" placeholder="-117.39" />
                </div>
              </div>
              <div className="tiny" style={{ marginTop: 6 }}>
                No address to hand? Close this and use “Add by clicking the map”.
              </div>
            </section>

            <section>
              <h3>What is known so far</h3>
              <div className="field-grid">
                <div>
                  <label htmlFor="ac-denom">Denomination</label>
                  <input id="ac-denom" value={denomination} onChange={(e) => setDenomination(e.target.value)} />
                </div>
                <div>
                  <label htmlFor="ac-seats">Seats, if known</label>
                  <input id="ac-seats" value={seats} onChange={(e) => setSeats(e.target.value)}
                    type="number" min={0} inputMode="numeric" placeholder="confirmed only" />
                </div>
                <div>
                  <label htmlFor="ac-cap">Capacity band</label>
                  <select id="ac-cap" value={capacity} onChange={(e) => setCapacity(e.target.value as CapacityBand)}>
                    {CAPACITIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="ac-ten">Tenancy possible</label>
                  <select id="ac-ten" value={tenancy} onChange={(e) => setTenancy(e.target.value as Tenancy)}>
                    {TENANCIES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div className="full">
                  <label htmlFor="ac-url">Listing URL</label>
                  <input id="ac-url" value={listingUrl} type="url"
                    onChange={(e) => { setListingUrl(e.target.value); if (e.target.value) setListed(true); }}
                    placeholder="https://www.loopnet.com/..." />
                </div>
                <div className="row full">
                  <label style={{ margin: 0 }}>
                    <input type="checkbox" checked={listed} onChange={(e) => setListed(e.target.checked)}
                      style={{ width: 18, height: 18, marginRight: 6 }} />
                    Listed for lease or sale
                  </label>
                </div>
                <div className="full">
                  <label htmlFor="ac-notes">Notes</label>
                  <textarea id="ac-notes" value={notes} onChange={(e) => setNotes(e.target.value)}
                    placeholder="who mentioned it, what they said, what to check" />
                </div>
              </div>
            </section>

            <div className="row">
              <button className="primary" onClick={saveOne} disabled={busy || !name.trim()}>
                {busy ? 'Saving…' : 'Add candidate'}
              </button>
              <button onClick={onClose} disabled={busy}>Cancel</button>
            </div>
          </>
        ) : (
          <>
            <section>
              <h3>One per line</h3>
              <p className="muted" style={{ fontSize: 12 }}>
                <code>Name, address</code> or <code>Name, lat, lon</code>, with an optional
                listing URL anywhere on the line. Tabs work too, so a spreadsheet column
                pastes straight in. A row carrying a URL is marked as listed.
              </p>
              <textarea value={bulk} onChange={(e) => setBulk(e.target.value)}
                style={{ minHeight: 160, fontFamily: 'var(--mono)', fontSize: 12 }}
                placeholder={
                  'First Baptist Corona, 500 S Main St, Corona CA, https://loopnet.com/x\n'
                  + 'Old Chapel on Van Buren, 33.912, -117.452\n'
                  + 'Grace Fellowship, 1234 Arlington Ave Riverside CA'
                } />
              <div className="tiny" style={{ marginTop: 6 }}>
                Addresses are geocoded one at a time, so a long list takes a moment.
                Anything that cannot be placed is reported, never dropped silently.
              </div>
            </section>

            {bulkLog.length > 0 && (
              <section>
                <h3>Result</h3>
                <div className="mono" style={{ fontSize: 11, maxHeight: 200, overflow: 'auto' }}>
                  {bulkLog.map((l, i) => (
                    <div key={i} style={{ color: l.startsWith('added') ? 'var(--good)' : 'var(--danger)' }}>
                      {l}
                    </div>
                  ))}
                </div>
              </section>
            )}

            <div className="row">
              <button className="primary" onClick={saveBulk} disabled={busy || !bulk.trim()}>
                {busy ? 'Adding…' : 'Add all'}
              </button>
              <button onClick={onClose} disabled={busy}>Close</button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
