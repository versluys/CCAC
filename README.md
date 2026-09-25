# Christ's Chapel Site Finder

A working tool for the Christ's Chapel (REC) site committee. It answers three
questions in order, and is honest about which of them it can actually answer:

1. **Where does the congregation live?** — from the parish giving record, which
   is a *proxy* for the congregation, not the congregation.
2. **Which churches sit within 20 miles of that centre?** — from OpenStreetMap,
   whose coverage of churches is incomplete.
3. **Which of those could seat about 200 and might lease to us?** — capacity is
   *estimated* from building footprint and parking. Nothing in any dataset
   knows how many people fit in a room, and nothing here pretends otherwise.

It then serves as the outreach pipeline: candidate status, notes, contacts and
site visits, behind Google Workspace login.

---

## What this tool does not know

Worth stating before anything else, because the numbers look more confident
than they are:

- **30 of 73 donor rows have no address at all** and cannot be placed. The map
  shows 43 dots. The congregation is 90–100 people. Those are different numbers
  measuring different things.
- **Some addressed donors are supporters, not attenders.** Out-of-state
  households are excluded from every centroid calculation for exactly this
  reason. They still appear on the map, flagged, so the exclusion is visible
  rather than silent.
- **The giving record under-represents recent transfers.** Attendance grew from
  under 70 to 90–100 in twelve months, mostly by transfer, and recent arrivals
  are the least likely to have complete donor records. The centre therefore
  leans toward longer-tenured members. The attender ZIP card
  (`private/attender_zips.csv`) exists to correct this; until one is collected,
  the Data Quality panel says so on every visit.
- **Capacity bands are estimates.** `likely_200+` means the building footprint
  and parking lot are consistent with 200 seats. It does not mean 200 seats.
  Only a phone call or a walk-through produces a seat count.
- **`unknown` capacity means unmapped, not small.** OSM building polygons are
  frequently missing. `unknown` candidates are never dropped from the list.

---

## Where the data lives (privacy)

Donors gave their contact details to the parish for giving records. Publishing
them more widely than necessary breaks that trust. The repository is built so
that doing the wrong thing takes deliberate effort.

| Location | Contents | Committed? |
|---|---|---|
| `private/` | The donor `.xlsx`; `households_geocoded.csv` (street addresses); `attender_zips.csv`; `address_overrides.csv` (keyed on donor names) | **Never.** Gitignored. |
| `data/` — outputs | `households_anon.json`, `centroids.json`, `churches.json`, `candidate_drive.json`, `examples.json`, `isochrones.json`, `data_quality.json`. Anonymous: `{id, lat, lon, zip, flags}` with coordinates rounded to 3 decimals (~110 m). | **No.** Regenerated per run. |
| `data/` — reference | `zip_centroids.csv` (published Census/USPS geography) and `OVERRIDES_TEMPLATE.csv`. | Yes |
| Cloudflare D1 | The same anonymous household points, plus candidates, notes and **church-side** contacts | Cloud |
| Anywhere | Donor names, emails, phone numbers, street addresses, giving amounts | **Nowhere but `private/`** |

`scripts/check_pii.py` is the enforcement. It fails the build if any published
file contains an email, a phone number, a street address, or any donor surname
read from the private workbook — and it checks that git is not tracking
anything under `private/`. Run it before every commit:

```bash
.venv/bin/python scripts/check_pii.py
```

Geocoding sends **address strings only**, never a name attached to one
(requirement R-P2). The Worker has no route that returns household data beyond
the anonymous point set, because no such column exists in the database.

### Correcting a wrong address

The giving record is a billing record, not a residence register. Some addresses
are stale. Corrections go in `private/address_overrides.csv` (gitignored,
template at `data/OVERRIDES_TEMPLATE.csv`), keyed on donor name:

```csv
match_name,override_zip,note
Jane Smith,92501,"Confirmed by the treasurer, 2026-09-22."
```

`ingest.py` applies the correction *before* the address is used for anything.
The published record is flagged `corrected` without saying who was corrected.

---

## Layout

```
private/     gitignored: the xlsx, geocoded CSV, attender cards, overrides
data/        pipeline outputs (gitignored) + public ZIP reference table (tracked)
scripts/     ingest.py, centroid.py, churches.py, seed_d1.py, check_pii.py
worker/      Cloudflare Worker: API, Access JWT verification, D1 schema
web/         React + Vite + MapLibre dashboard
```

---

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -r scripts/requirements.txt

cd worker && npm install && cd ..
cd web    && npm install && cd ..
```

Put the donor workbook in `private/`. It is gitignored.

---

### Why the pipeline's output is not committed

`data/*.json` is regenerated by every run, so tracking it would dirty the working
tree each time and make `git pull` conflict. The real reason is worse than the
nuisance: those files are machine-specific. A run on a network that can reach
OSRM produces routed drive times; a run on one that cannot produces straight-line
estimates. Committing them lets a pull quietly replace somebody's measured
numbers with somebody else's approximations — version control corrupting the data
it exists to protect. Regenerate them instead; that is what the scripts are for.

## Before you run anything

```bash
scripts/run_pipeline.sh --help     # the whole pipeline, from any directory
.venv/bin/python scripts/preflight.py
```

`run_pipeline.sh` finds its own repo root, so it works from anywhere, uses the
project virtualenv, and stops at the first failing stage rather than carrying on
with stale data. A half-run pipeline is worse than one that never started: the
dashboard still shows numbers, quietly left over from the previous attempt.

Every check in it exists because something actually went wrong during the build:
running from the wrong directory, an Overpass cache left over from a different
search radius, a stage recomputed after the stage that depends on it, a seed file
older than the data, examples still in the list, drive times that are really
straight-line estimates. FAIL means a number in the dashboard will be wrong;
WARN means it will be right but weaker than it could be. Run it again afterwards
to catch the staleness checks.

## Running the pipeline

**Network note:** phases 2–3 need the public Census, OSRM and Overpass APIs.
Run them from an ordinary network connection; a locked-down environment will
block them, and each script says so plainly rather than producing a quiet
half-answer.

```bash
# 1. Ingest and geocode. Prints a match-quality table.
.venv/bin/python scripts/ingest.py
.venv/bin/python scripts/check_pii.py          # acceptance gate

# --zip-only places every household at its ZIP centroid and contacts no
# geocoder at all. Use it when no address may leave the machine.
.venv/bin/python scripts/ingest.py --zip-only

# 2. Centroids: naive mean, trimmed mean, geometric median, drive-time median.
.venv/bin/python scripts/centroid.py

# 3. Churches within the search radius (40 mi), with footprint and parking.
.venv/bin/python scripts/churches.py
.venv/bin/python scripts/churches.py --google-places    # needs CCAC_GOOGLE_KEY

# 3a. Optional: 15 clearly fictional example candidates, to try the tool out.
.venv/bin/python scripts/make_examples.py
.venv/bin/python scripts/make_examples.py --clear     # remove them again

# 4. Route every candidate to every household. Do not skip this: see below.
.venv/bin/python scripts/drive_matrix.py

# 5. Optional: reachable-area polygons for the map, 15/30/45/60 min.
.venv/bin/python scripts/isochrones.py
.venv/bin/python scripts/isochrones.py --candidate "Grace"   # around one church

# 6. Generate the D1 seed.
.venv/bin/python scripts/seed_d1.py > worker/seed.sql
```

Re-seeding is **non-destructive to human work**: it refreshes discovered
geometry but leaves status, notes, contacts and every hand-entered research
field exactly as the committee left them.

### Adding candidates by hand

Discovery finds buildings that happen to be mapped. The building the parish
eventually leases is more likely to be one somebody heard about, so manual entry
is a first-class path, not a fallback. In the dashboard, **+ Add candidate**
takes:

- an address, geocoded through the Census geocoder;
- coordinates typed directly, or a click on the map;
- a pasted list, one per line — `Name, address` or `Name, lat, lon`, with an
  optional listing URL anywhere on the line. Tabs work, so a spreadsheet column
  pastes straight in, and a row carrying a URL is marked as listed.

Anything that cannot be placed is reported rather than dropped.

**On listing sites.** LoopNet and Crexi have no public API, and scraping them
breaches their terms, so this tool does not. Get the listings the way a tenant
legitimately does — a saved search, an email alert, or a broker's list — and
paste them in. The table then filters to **Listed only**, which is the right
working set: screening four thousand buildings in the hope that a few are free
is the wrong way round.

### The fictional examples

`make_examples.py` writes 15 candidates named after places in Narnia. That is
deliberate. A realistic set of plausible Riverside church names with real
addresses would be indistinguishable from genuine leads, and someone would
eventually phone one or put it in a vestry packet. Fiction that announces itself
cannot do that. While any are present the dashboard shows a banner, and
`--clear` removes them.

### Why `drive_matrix.py` is not optional

`fit_score` gives its heaviest weight, 35 of 100 points, to the share of
households within a 20-minute drive. Nothing in OpenStreetMap knows that, so
until a candidate has been routed it scores **zero** on the factor that matters
most. The dashboard routes a candidate when someone opens it, which serves the
handful under active consideration and does nothing for ranking thousands — and
the ranking is what decides which candidates anyone ever opens. Skip this step
and the sort order buries good buildings.

One OSRM request carries many origins against the same destinations, so with a
few dozen households roughly fifty candidates fit per request. A few thousand
candidates cost a couple of minutes, once, cached.

At a 40-mile radius, distance is also the wrong filter. A church 38 miles out
along the 91 can be a shorter Sunday drive than one 22 miles away over the
hills. Filter the table on drive time, not miles.

### Which centre to use

`centroid.py` computes four, because a single centroid is a weak answer:

| Method | What it answers |
|---|---|
| `mean_all` | Naive centre. Dragged by every distant household. |
| `mean_trimmed` | Centre of the core, outliers dropped. |
| `geometric_median` | Minimises total straight-line distance. Robust. |
| `drive_time_median` | Minimises total **drive minutes**. The default when available. |

Drive time is the one that matters: families decide by Sunday drive, and the
I-15 / I-215 / SR-91 / SR-60 network distorts straight lines badly. When OSRM
is unreachable the script falls back to the geometric median **and says so**,
rather than passing a straight-line answer off as a drive-time one. The
dashboard carries the same warning wherever drive figures appear.

---

## Deploying

```bash
cd worker
npx wrangler d1 create ccac-sitefinder     # paste the id into wrangler.toml
npm run db:schema
npm run db:seed

cd ../web && npm run build                  # the Worker serves web/dist
cd ../worker && npm run deploy
```

Then in Cloudflare Zero Trust:

1. Add **Google Workspace** as an identity provider.
2. Create an **Access application** for the Worker's hostname.
3. Policy: allow the Christ's Chapel Workspace domain, ideally narrowed to a
   group such as `site-committee@`.
4. Copy the application's **AUD tag** and your team domain into
   `worker/wrangler.toml`.
5. Optionally set `ALLOWED_EMAIL_DOMAINS` as a second gate, so a
   mis-configured Access policy cannot silently open parish research to the
   internet.

The Worker **verifies the Access JWT itself** against the team's JWKS —
signature, audience, issuer and expiry. The presence of the
`Cf-Access-Jwt-Assertion` header proves nothing; anyone can set a header. A
token minted for a *different* Access application is signed by the same team
key and is rejected on the audience check.

### When the schema changes

`schema.sql` uses `CREATE TABLE IF NOT EXISTS`, which cannot add a column to a
table that already exists. A database created before a schema change keeps its
old shape, and the seed then fails on the missing column.

Locally that is harmless to fix, because everything except hand-entered notes,
status changes and contacts is regenerated from `seed.sql`:

```bash
scripts/run_pipeline.sh --keep-discovery --serve --reset-db
```

On a deployed D1 it is not harmless: the committee's research lives there. Add
the column with `ALTER TABLE` rather than recreating the database:

```bash
cd worker
npx wrangler d1 execute ccac-sitefinder --remote \
  --command "ALTER TABLE candidates ADD COLUMN is_example INTEGER DEFAULT 0"
```

### Local development

```bash
cd worker && npm run db:schema:local && npm run db:seed:local && npm run dev
cd web && npm run dev          # proxies /api to the Worker on :8787
```

`ACCESS_DEV_EMAIL` stands in for a signed-in user, and is honoured **only**
when `ENVIRONMENT` is exactly `development`. Never set that on a deployed
Worker.

---

## Tests

```bash
cd worker && npm test          # 44 tests
```

They cover the things that would be quietly catastrophic if wrong: forged
signatures, payloads tampered with after signing, `alg=none`, tokens from
another Access application or another team, expired tokens, the domain
allow-list, that every route including the app shell refuses an
unauthenticated request, and that scoring stays inside 0–100 however the
weights are edited.

---

## Scoring

`fit_score` is **a sorting aid, not a decision**. Weights are editable in
Settings and stored in D1:

| Factor | Default weight |
|---|---|
| Drive-time share of households within 20 min | 35 |
| Capacity estimate band | 25 |
| Availability evidence | 25 |
| Tenancy type possible (sole > shared) | 15 |

Every candidate's drawer shows each component, its contribution and the reason
behind it, so a number nobody can explain never drives a vote. `unknown`
capacity deliberately scores at the midpoint rather than zero: an unmapped
building is an absence of evidence, and ranking it below a building known to be
too small would bury exactly the candidates that most need a phone call.

**Growth check.** Years to 80% full is `n = ln(0.8 × seats / ASA) / ln(1 + g)`
under conservative (8%), base (12%) and surge (20%) growth. A candidate whose
base-case figure is shorter than its lease term is flagged: the parish would be
looking for a building again before the lease ended.

**Transfer-source overlap.** Where households at Christ's Chapel came from a
congregation, that candidate shows a caution badge. Outreach there is the
rector's to make, not a cold call.

---

## Open questions for the vestry

1. Workspace domain, and the Google group that should have access.
2. Confirm the ASA baseline and which growth scenario to plan against.
3. Budget ceiling for monthly lease; has the vestry authorised outreach?
4. Denominational boundaries in both directions — bodies the parish will not
   rent from, and bodies that will not rent to an REC/ACNA congregation.
5. Approval to use the Google Places API to fill OSM gaps (small cost).
6. Collect the attender ZIP card, so the centre stops depending on the giving
   record alone.
