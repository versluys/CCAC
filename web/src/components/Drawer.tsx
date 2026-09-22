/**
 * Candidate detail drawer: facts, capacity evidence, availability fields,
 * notes timeline, contacts, status control (PRD §10).
 *
 * The ordering is deliberate. What we know from data comes first and is
 * labelled as measured; what we estimated comes next and is labelled as
 * estimated; what a person has to find out comes last, as empty fields
 * waiting for a phone call. Nothing here lets the tool imply it knows a seat
 * count it has not been told.
 */

import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Candidate, Contact, Note, Status, Tenancy, Overlap, CapacityBand } from '../types';
import { CAPACITY_LABEL, STATUS_COLOR, STATUS_LABEL, STATUS_ORDER } from '../types';

interface Props {
  id: string;
  onClose: () => void;
  onChanged: (c: Candidate) => void;
  notify: (msg: string, bad?: boolean) => void;
}

const NOTE_KINDS = ['note', 'call', 'email', 'visit', 'research'] as const;
const TENANCIES: Tenancy[] = ['unknown', 'sole', 'shared', 'either', 'no'];
const OVERLAPS: Overlap[] = ['unknown', 'yes', 'no'];
const CAPACITIES: CapacityBand[] = ['unknown', 'likely_200+', 'possible', 'unlikely'];

const CAPACITY_TOOLTIP =
  'Estimated from building footprint and parking, never measured. ' +
  'A 200-seat sanctuary needs roughly 3,000-4,000 sq ft of seating (7 sq ft per ' +
  'occupant for unfixed chairs; pews and aisles run higher). With narthex, ' +
  'restrooms and a fellowship space the whole building usually exceeds 6,000 sq ft. ' +
  'Local codes want about 1 stall per 3-4 seats, so 50-70 stalls, roughly ' +
  '1,500-2,100 sq m of lot. Confirm seats by phone or visit.';

function fmt(n: number | null | undefined, digits = 0, suffix = ''): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: digits }) + suffix;
}

export default function Drawer({ id, onClose, onChanged, notify }: Props) {
  const [data, setData] = useState<{ candidate: Candidate; notes: Note[]; contacts: Contact[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [noteKind, setNoteKind] = useState<(typeof NOTE_KINDS)[number]>('note');
  const [showContact, setShowContact] = useState(false);

  useEffect(() => {
    let live = true;
    setData(null);
    api
      .candidate(id)
      .then((d) => live && setData(d))
      .catch((e) => notify(String(e.message), true));
    return () => {
      live = false;
    };
  }, [id, notify]);

  async function patch(fields: Record<string, unknown>) {
    if (!data) return;
    setSaving(true);
    try {
      const { candidate } = await api.patchCandidate(id, fields);
      setData({ ...data, candidate });
      onChanged(candidate);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setSaving(false);
    }
  }

  async function submitNote() {
    const body = noteText.trim();
    if (!body || !data) return;
    setSaving(true);
    try {
      const { note } = await api.addNote(id, body, noteKind);
      setData({ ...data, notes: [note, ...data.notes] });
      setNoteText('');
      notify('Note saved');
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setSaving(false);
    }
  }

  if (!data) {
    return (
      <aside className="drawer">
        <div className="drawer-head">
          <h2>Loading…</h2>
          <button className="x" onClick={onClose} aria-label="Close">✕</button>
        </div>
      </aside>
    );
  }

  const c = data.candidate;
  const leaseYears = c.lease_term_months ? c.lease_term_months / 12 : null;

  return (
    <aside className="drawer" role="dialog" aria-label={c.name}>
      <div className="drawer-head">
        <div>
          <h2>{c.name}</h2>
          <div className="tiny">
            {c.denomination ?? 'denomination unrecorded'} · {c.address ?? 'no address on file'}
          </div>
        </div>
        <button className="x" onClick={onClose} aria-label="Close">✕</button>
      </div>

      <div className="drawer-body">
        {c.transfer_overlap === 'yes' && (
          <div className="caveat">
            <strong>Coordinate with the rector before any contact.</strong> Households at
            Christ's Chapel transferred from this congregation. Outreach here is the
            rector's to make, not a cold call.
            {c.transfer_overlap_note ? <div className="tiny" style={{ marginTop: 6 }}>{c.transfer_overlap_note}</div> : null}
          </div>
        )}

        <section>
          <h3>Status</h3>
          <select
            value={c.status}
            disabled={saving}
            onChange={(e) => patch({ status: e.target.value as Status })}
            style={{ borderLeft: `4px solid ${STATUS_COLOR[c.status]}` }}
          >
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>{STATUS_LABEL[s]}</option>
            ))}
          </select>
          <div className="tiny" style={{ marginTop: 6 }}>
            Fit score {c.fit_score} · last touched{' '}
            {c.updated_at ? `${new Date(c.updated_at).toLocaleDateString()} by ${c.updated_by}` : 'never'}
          </div>
        </section>

        <section>
          <h3>Measured from map data</h3>
          <dl className="facts">
            <dt>Footprint</dt><dd>{fmt(c.footprint_ft2, 0, ' sq ft')}</dd>
            <dt>Parking</dt><dd>{fmt(c.parking_m2, 0, ' sq m')}{c.parking_spaces_est ? ` (~${c.parking_spaces_est} stalls)` : ''}</dd>
            <dt>Distance</dt><dd>{fmt(c.distance_mi_from_center, 1, ' mi from centre')}</dd>
            <dt>Drive</dt><dd>{c.drive_min_from_center ? fmt(c.drive_min_from_center, 0, ' min') : 'not routed yet'}</dd>
            <dt>Within 20 min</dt><dd>{c.share_hh_within_20min != null ? `${Math.round(c.share_hh_within_20min * 100)}% of households` : '—'}</dd>
            <dt>Source</dt><dd className="mono">{c.source}</dd>
          </dl>
          {!c.footprint_ft2 && (
            <div className="tiny" style={{ marginTop: 6 }}>
              No building polygon is mapped in OpenStreetMap. That is a coverage gap,
              not a small building.
            </div>
          )}
        </section>

        <section>
          <h3>
            Capacity <span className="badge estimate" title={CAPACITY_TOOLTIP}>estimate ⓘ</span>
          </h3>
          <div className="field-grid">
            <div>
              <label htmlFor="cap-band">Estimated band</label>
              <select id="cap-band" value={c.capacity_est} disabled={saving}
                onChange={(e) => patch({ capacity_est: e.target.value })}>
                {CAPACITIES.map((b) => <option key={b} value={b}>{CAPACITY_LABEL[b]}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="cap-seats">Seats, once confirmed</label>
              <input id="cap-seats" type="number" min={0} inputMode="numeric"
                defaultValue={c.capacity_confirmed ?? ''} disabled={saving}
                placeholder="phone or visit"
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  const n = v === '' ? null : Number(v);
                  if (n !== c.capacity_confirmed) patch({ capacity_confirmed: n });
                }} />
            </div>
          </div>
          <div className="tiny" style={{ marginTop: 6 }}>
            Screen band is 150–250 seats; 175–225 scores highest. Basis in use:{' '}
            <strong>{c.seats_basis}</strong>.
          </div>
        </section>

        <section>
          <h3>Growth against this building</h3>
          <dl className="facts">
            <dt>Conservative 8%</dt><dd>{c.years_to_80pct.conservative == null ? '—' : `${c.years_to_80pct.conservative} yrs to 80% full`}</dd>
            <dt>Base 12%</dt><dd>{c.years_to_80pct.base == null ? '—' : `${c.years_to_80pct.base} yrs to 80% full`}</dd>
            <dt>Surge 20%</dt><dd>{c.years_to_80pct.surge == null ? '—' : `${c.years_to_80pct.surge} yrs to 80% full`}</dd>
          </dl>
          {c.outgrows_lease && (
            <div className="caveat" style={{ marginTop: 8 }}>
              Base-case growth fills this building to 80% in {c.years_to_80pct.base} years,
              inside the {leaseYears?.toFixed(1)}-year lease term on file. The parish would
              be looking again before the lease ends.
            </div>
          )}
          {c.years_to_80pct.base == null && (
            <div className="tiny">No seat figure to project against yet.</div>
          )}
        </section>

        <section>
          <h3>Tenancy and lease</h3>
          <div className="field-grid">
            <div>
              <label htmlFor="ten">Tenancy possible</label>
              <select id="ten" value={c.tenancy_possible} disabled={saving}
                onChange={(e) => patch({ tenancy_possible: e.target.value })}>
                {TENANCIES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="term">Lease term (months)</label>
              <input id="term" type="number" min={0} inputMode="numeric" defaultValue={c.lease_term_months ?? ''}
                disabled={saving}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  const n = v === '' ? null : Number(v);
                  if (n !== c.lease_term_months) patch({ lease_term_months: n });
                }} />
            </div>
            <div className="full">
              <label htmlFor="exp">Expansion rights</label>
              <input id="exp" defaultValue={c.expansion_rights ?? ''} disabled={saving}
                placeholder="fellowship hall, second service slot, office"
                onBlur={(e) => e.target.value !== (c.expansion_rights ?? '') && patch({ expansion_rights: e.target.value })} />
            </div>
            <div className="row full">
              <label style={{ margin: 0 }}>
                <input type="checkbox" style={{ width: 18, height: 18, marginRight: 6 }}
                  defaultChecked={!!c.renewal_option} disabled={saving}
                  onChange={(e) => patch({ renewal_option: e.target.checked })} />
                Renewal option
              </label>
            </div>
          </div>
        </section>

        <section>
          <h3>Availability evidence</h3>
          <div className="field-grid">
            <div className="row full">
              <label style={{ margin: 0 }}>
                <input type="checkbox" style={{ width: 18, height: 18, marginRight: 6 }}
                  defaultChecked={!!c.listed_for_lease} disabled={saving}
                  onChange={(e) => patch({ listed_for_lease: e.target.checked })} />
                Listed for lease or sale
              </label>
              <label style={{ margin: 0 }}>
                <input type="checkbox" style={{ width: 18, height: 18, marginRight: 6 }}
                  defaultChecked={!!c.shared_use_precedent} disabled={saving}
                  onChange={(e) => patch({ shared_use_precedent: e.target.checked })} />
                Already hosts another congregation
              </label>
            </div>
            <div className="full">
              <label htmlFor="listing">Listing URL (LoopNet, Crexi, broker)</label>
              <input id="listing" type="url" defaultValue={c.listing_url ?? ''} disabled={saving}
                placeholder="https://"
                onBlur={(e) => e.target.value !== (c.listing_url ?? '') && patch({ listing_url: e.target.value })} />
            </div>
            <div className="full">
              <label htmlFor="decline">Congregation closed, merged or in decline</label>
              <input id="decline" defaultValue={c.congregation_decline ?? ''} disabled={saving}
                placeholder="news item, denominational record"
                onBlur={(e) => e.target.value !== (c.congregation_decline ?? '') && patch({ congregation_decline: e.target.value })} />
            </div>
            <div className="full">
              <label htmlFor="sched">Service schedule (open Sunday slots)</label>
              <input id="sched" defaultValue={c.service_schedule ?? ''} disabled={saving}
                placeholder="e.g. 9am only, sanctuary free after 11"
                onBlur={(e) => e.target.value !== (c.service_schedule ?? '') && patch({ service_schedule: e.target.value })} />
            </div>
            <div className="full">
              <label htmlFor="dm">Decision maker</label>
              <input id="dm" defaultValue={c.decision_maker ?? ''} disabled={saving}
                placeholder="pastor, board, diocese, presbytery, district"
                onBlur={(e) => e.target.value !== (c.decision_maker ?? '') && patch({ decision_maker: e.target.value })} />
            </div>
            <div className="full">
              <label htmlFor="dn">Denomination and relationship considerations</label>
              <textarea id="dn" defaultValue={c.denomination_notes ?? ''} disabled={saving}
                onBlur={(e) => e.target.value !== (c.denomination_notes ?? '') && patch({ denomination_notes: e.target.value })} />
            </div>
            <div>
              <label htmlFor="ov">Transfer-source overlap</label>
              <select id="ov" value={c.transfer_overlap} disabled={saving}
                onChange={(e) => patch({ transfer_overlap: e.target.value })}>
                {OVERLAPS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="ovn">Overlap note</label>
              <input id="ovn" defaultValue={c.transfer_overlap_note ?? ''} disabled={saving}
                onBlur={(e) => e.target.value !== (c.transfer_overlap_note ?? '') && patch({ transfer_overlap_note: e.target.value })} />
            </div>
          </div>
        </section>

        <section>
          <h3>Why this score</h3>
          {c.score_breakdown.map((comp) => (
            <div className="score-row" key={comp.label}>
              <span>{comp.label}</span>
              <span>{comp.points.toFixed(1)} / {comp.weight}</span>
              <div className="bar"><i style={{ width: `${Math.round(comp.fraction * 100)}%` }} /></div>
              <span className="why">{comp.why}</span>
            </div>
          ))}
          <div className="tiny" style={{ marginTop: 8 }}>
            A sorting aid, not a decision. Weights are editable in Settings.
          </div>
        </section>

        <section>
          <h3>Notes</h3>
          <div className="row" style={{ marginBottom: 6 }}>
            <select value={noteKind} onChange={(e) => setNoteKind(e.target.value as typeof noteKind)}
              style={{ width: 'auto', flex: '0 0 auto' }}>
              {NOTE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <span className="spacer" />
            <button className="primary" onClick={submitNote} disabled={saving || !noteText.trim()}>Save note</button>
          </div>
          <textarea value={noteText} onChange={(e) => setNoteText(e.target.value)}
            placeholder="What happened, who said it, what comes next." disabled={saving} />
          <div style={{ marginTop: 12 }}>
            {data.notes.length === 0 && <div className="tiny">No notes yet.</div>}
            {data.notes.map((n) => (
              <div className="note" key={n.id}>
                <div className="meta">
                  {n.kind} · {new Date(n.created_at).toLocaleString()} · {n.author_email}
                </div>
                <div className="body">{n.body}</div>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h3>Church contacts</h3>
          <div className="tiny" style={{ marginBottom: 8 }}>
            Church-side people only. Parishioner and donor details never go in this tool.
          </div>
          {data.contacts.map((ct) => (
            <div className="note" key={ct.id}>
              <div className="body">{ct.name ?? '(no name)'}{ct.role ? ` — ${ct.role}` : ''}</div>
              <div className="meta">{[ct.email, ct.phone].filter(Boolean).join(' · ') || 'no contact details'}</div>
            </div>
          ))}
          {showContact ? (
            <ContactForm
              disabled={saving}
              onCancel={() => setShowContact(false)}
              onSave={async (contact) => {
                try {
                  const { contact: saved } = await api.addContact(id, contact);
                  setData({ ...data, contacts: [...data.contacts, saved] });
                  setShowContact(false);
                  notify('Contact added');
                } catch (e) {
                  notify((e as Error).message, true);
                }
              }}
            />
          ) : (
            <button onClick={() => setShowContact(true)}>Add a contact</button>
          )}
        </section>

        <section>
          <h3>Links</h3>
          <div className="row">
            {c.website && <a href={c.website} target="_blank" rel="noreferrer noopener">Website</a>}
            {c.phone && <a href={`tel:${c.phone}`}>{c.phone}</a>}
            <a href={`https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lon}`}
               target="_blank" rel="noreferrer noopener">Directions</a>
            {c.id.startsWith('osm:') && (
              <a href={`https://www.openstreetmap.org/${c.id.slice(4)}`} target="_blank" rel="noreferrer noopener">
                OpenStreetMap
              </a>
            )}
          </div>
        </section>
      </div>
    </aside>
  );
}

function ContactForm({
  onSave, onCancel, disabled,
}: {
  onSave: (c: Record<string, string>) => void;
  onCancel: () => void;
  disabled: boolean;
}) {
  const [f, setF] = useState({ name: '', role: '', email: '', phone: '' });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF({ ...f, [k]: e.target.value });
  return (
    <div className="field-grid" style={{ marginTop: 8 }}>
      <div><label htmlFor="cn">Name</label><input id="cn" value={f.name} onChange={set('name')} /></div>
      <div><label htmlFor="cr">Role</label><input id="cr" value={f.role} onChange={set('role')} placeholder="pastor, board chair" /></div>
      <div><label htmlFor="ce">Email</label><input id="ce" type="email" value={f.email} onChange={set('email')} /></div>
      <div><label htmlFor="cp">Phone</label><input id="cp" type="tel" value={f.phone} onChange={set('phone')} /></div>
      <div className="row full">
        <button className="primary" disabled={disabled || !(f.name || f.email || f.phone)}
          onClick={() => onSave(f)}>Save contact</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
