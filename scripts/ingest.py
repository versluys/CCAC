#!/usr/bin/env python3
"""Phase 1 — ingest donor addresses and attender ZIPs, geocode, anonymise.

    .venv/bin/python scripts/ingest.py \
        --xlsx private/Christ_s_Chapel_Reformed_Episcopal_Church_Donor_Contact_List.xlsx

Privacy (PRD §4):
  R-P1  the .xlsx and private/households_geocoded.csv stay in private/ (gitignored)
  R-P2  only address strings are sent to a geocoder, never names
  R-P3  data/households_anon.json carries {id, lat, lon, zip, flags} only,
        lat/lon rounded to 3 decimals
Run scripts/check_pii.py afterwards; it is the acceptance test for this phase.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import pathlib
import re
import sys

import pandas as pd
import requests

from common import (
    DATA,
    PRIVATE,
    ROOT,
    USER_AGENT,
    RateLimiter,
    haversine_mi,
    load_zip_table,
    median,
    normalize_address,
    print_table,
    round_coord,
    write_json,
)

CENSUS_BATCH_URL = (
    "https://geocoding.geo.census.gov/geocoder/locations/addressbatch"
)
CENSUS_BENCHMARK = "Public_AR_Current"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
# Distance beyond which a point is treated as a remote supporter rather than a
# plausible Sunday commuter (PRD 7.2 trimmed-mean rule).
OUTLIER_MI = 60.0


# --------------------------------------------------------------------------
# geocoding
# --------------------------------------------------------------------------
def census_batch_geocode(records: list[dict], session: requests.Session) -> dict:
    """Geocode via the Census batch endpoint. Returns {id: result}.

    Only street/city/state/zip are transmitted (R-P2). The Census batch API
    accepts at most 10,000 rows per file; we chunk at 1,000 to keep each
    request small and the failure blast radius narrow.
    """
    out: dict[str, dict] = {}
    chunk_size = 1000
    for start in range(0, len(records), chunk_size):
        chunk = records[start : start + chunk_size]
        buf = io.StringIO()
        w = csv.writer(buf)
        for r in chunk:
            w.writerow(
                [r["id"], r.get("street") or "", r.get("city") or "",
                 r.get("state") or "", r.get("zip") or ""]
            )
        files = {"addressFile": ("addresses.csv", buf.getvalue(), "text/csv")}
        data = {"benchmark": CENSUS_BENCHMARK}
        print(f"  census batch: {len(chunk)} addresses ...", flush=True)
        try:
            resp = session.post(CENSUS_BATCH_URL, files=files, data=data, timeout=300)
            resp.raise_for_status()
        except requests.RequestException as exc:
            print(f"  ! census batch failed ({exc}); those rows fall through", file=sys.stderr)
            continue
        for row in csv.reader(io.StringIO(resp.text)):
            # id, input, match, exact/non-exact, matched address, "lon,lat", tigerline, side
            if len(row) < 3:
                continue
            rid, status = row[0], row[2]
            if status != "Match" or len(row) < 6:
                continue
            try:
                lon, lat = (float(v) for v in row[5].split(","))
            except (ValueError, IndexError):
                continue
            out[rid] = {
                "lat": lat,
                "lon": lon,
                "match_quality": "exact" if row[3] == "Exact" else "interpolated",
                "geocoder": "census",
            }
    return out


def nominatim_geocode(rec: dict, session: requests.Session, limiter: RateLimiter) -> dict | None:
    """Single-address fallback. 1 req/s with a descriptive UA, per OSM policy."""
    params = {
        "format": "jsonv2",
        "limit": 1,
        "countrycodes": "us",
        "street": " ".join(x for x in [rec.get("street")] if x) or "",
        "city": rec.get("city") or "",
        "state": rec.get("state") or "",
        "postalcode": rec.get("zip") or "",
    }
    params = {k: v for k, v in params.items() if v != ""}
    limiter.wait()
    try:
        resp = session.get(
            NOMINATIM_URL, params=params, timeout=30, headers={"User-Agent": USER_AGENT}
        )
        resp.raise_for_status()
        hits = resp.json()
    except (requests.RequestException, ValueError) as exc:
        print(f"  ! nominatim error for {rec['id']}: {exc}", file=sys.stderr)
        return None
    if not hits:
        return None
    h = hits[0]
    return {
        "lat": float(h["lat"]),
        "lon": float(h["lon"]),
        "match_quality": "interpolated",
        "geocoder": "nominatim",
    }


# --------------------------------------------------------------------------
# ZIP-centroid placement
# --------------------------------------------------------------------------
def zip_place(zipcode: str | None) -> dict | None:
    """Place a household at its ZIP centroid.

    Used as the last rung of the geocoding cascade, and as the only rung when
    --zip-only is set (or when the Census geocoder is unreachable, as it is
    from a locked-down network). CA ZIPs resolve to Census ZCTA interior
    points; everything else resolves to a coarser published centroid, and is
    labelled as such so the dashboard does not overstate its precision.
    """
    if not zipcode:
        return None
    ref = load_zip_table().get(str(zipcode).zfill(5))
    if not ref:
        return None
    coarse = ref.get("precision") != "zcta"
    return {
        "lat": ref["lat"],
        "lon": ref["lon"],
        "match_quality": "zip-only-coarse" if coarse else "zip-only",
        "geocoder": "zcta" if not coarse else "zip-table",
    }


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------
WORKBOOK_PATTERNS = ("*.xlsx", "*.xls", "*.xlsm")


def resolve_workbook(given: str) -> pathlib.Path:
    """Find the donor workbook, rather than insisting on one exact filename.

    The default path is what the PRD names, but the file arrives from
    QuickBooks with whatever name the export gave it. If the default is not
    there, look for a single workbook in private/ and use it. Two workbooks is
    ambiguous and worth stopping for; none is worth a clear message.
    """
    path = pathlib.Path(given)
    if not path.is_absolute():
        path = ROOT / path
    if path.exists():
        return path

    found: list[pathlib.Path] = []
    for pattern in WORKBOOK_PATTERNS:
        # Excel leaves ~$lock files behind; they are not the workbook.
        found += [p for p in PRIVATE.glob(pattern) if not p.name.startswith(("~$", "."))]
    found = sorted(set(found))

    if len(found) == 1:
        print(f"Using the workbook found in private/: {found[0].name}")
        return found[0]
    if len(found) > 1:
        names = "\n  ".join(p.name for p in found)
        raise SystemExit(
            f"! private/ holds more than one workbook, so which one to read is ambiguous:\n  {names}\n"
            f"  Pass one explicitly:  --xlsx private/<name>"
        )
    raise SystemExit(
        f"! no donor workbook found.\n"
        f"  Looked for: {path}\n"
        f"  and for {', '.join(WORKBOOK_PATTERNS)} in {PRIVATE}\n"
        f"  Put the export in private/ (it is gitignored) or pass --xlsx <path>."
    )


def read_workbook(path: pathlib.Path, sheet, header_row: int):
    """Read the workbook, naming the missing dependency when one is missing.

    A legacy .xls needs xlrd rather than openpyxl, and pandas' own error for
    that is easy to misread as the file being corrupt.
    """
    try:
        return pd.read_excel(path, sheet_name=sheet, header=header_row)
    except ImportError as exc:
        engine = "xlrd" if path.suffix.lower() == ".xls" else "openpyxl"
        raise SystemExit(
            f"! reading {path.name} needs the '{engine}' package: {exc}\n"
            f"  .venv/bin/pip install {engine}"
        ) from exc
    except ValueError as exc:
        # Wrong sheet name is the common case and says so unhelpfully.
        try:
            sheets = pd.ExcelFile(path).sheet_names
        except Exception:
            raise SystemExit(f"! could not read {path.name}: {exc}") from exc
        raise SystemExit(
            f"! could not read sheet {sheet!r} from {path.name}: {exc}\n"
            f"  Sheets present: {sheets}\n"
            f"  Pass the right one with --sheet"
        ) from exc


def load_overrides(path) -> list[dict]:
    """Parish-confirmed address corrections.

    The source workbook is a giving record, not a residence register, so some
    billing addresses are stale or belong to a relative in another county.
    Corrections key on donor name, which is PII, so this file lives in
    private/ and is gitignored (R-P1). Only the resulting ZIP ever reaches
    data/, and the published record is flagged 'corrected' without saying who.
    """
    rows: list[dict] = []
    try:
        with open(path, newline="") as fh:
            for row in csv.DictReader(fh):
                name = (row.get("match_name") or "").strip()
                zipc = re.sub(r"\D", "", str(row.get("override_zip") or ""))[:5]
                if not name or len(zipc) != 5:
                    continue
                rows.append({"match_name": name.lower(), "zip": zipc,
                             "note": (row.get("note") or "").strip()})
    except FileNotFoundError:
        return []
    return rows


def stable_id(prefix: str, *parts: str) -> str:
    h = hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()[:12]
    return f"{prefix}:{h}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument(
        "--xlsx",
        default=str(PRIVATE / "Christ_s_Chapel_Reformed_Episcopal_Church_Donor_Contact_List.xlsx"),
        help="donor export; must live under private/",
    )
    ap.add_argument("--sheet", default="Sheet1")
    ap.add_argument("--header-row", type=int, default=3, help="0-indexed header row (PRD: row 4)")
    ap.add_argument(
        "--attenders",
        default=str(PRIVATE / "attender_zips.csv"),
        help="zip,household_size,joined_within_12mo (Y/N); optional",
    )
    ap.add_argument(
        "--overrides",
        default=str(PRIVATE / "address_overrides.csv"),
        help="parish-confirmed address corrections; stays in private/ (optional)",
    )
    ap.add_argument("--offline", action="store_true", help="skip all network calls")
    ap.add_argument(
        "--zip-only",
        action="store_true",
        help="place every household at its ZIP centroid; no address string leaves the machine",
    )
    ap.add_argument("--no-nominatim", action="store_true", help="Census only, no fallback")
    args = ap.parse_args()

    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    limiter = RateLimiter(1.05)

    households: list[dict] = []
    total_rows = 0

    # ---------------- donors ----------------
    xlsx = resolve_workbook(args.xlsx)
    df = read_workbook(xlsx, args.sheet, args.header_row)

    df.columns = [str(c).strip() for c in df.columns]
    bill_col = next((c for c in df.columns if c.lower().startswith("bill address")), None)
    ship_col = next((c for c in df.columns if c.lower().startswith("ship address")), None)
    if bill_col is None:
        print(f"! no 'Bill address' column; found: {list(df.columns)}", file=sys.stderr)
        return 2

    # Drop the trailing total/blank rows some exports carry.
    df = df.dropna(how="all")
    total_rows = len(df)

    overrides = load_overrides(args.overrides)
    if overrides:
        print(f"Loaded {len(overrides)} parish-confirmed address override(s) from private/.")
    override_hits = 0

    name_cols = [c for c in df.columns if "name" in c.lower()]

    ship_only = 0
    to_geocode: list[dict] = []
    for i, row in df.iterrows():
        raw_bill = row.get(bill_col)
        raw_ship = row.get(ship_col) if ship_col else None
        has_bill = isinstance(raw_bill, str) and raw_bill.strip()
        has_ship = isinstance(raw_ship, str) and raw_ship.strip()
        if not has_bill and has_ship:
            ship_only += 1
        if not has_bill:
            continue
        parts = normalize_address(raw_bill)
        if not parts.get("zip") and not parts.get("street"):
            continue
        # Apply a parish-confirmed correction before the address is used for
        # anything, so the wrong ZIP never reaches a geocoder or the map.
        corrected = 0
        row_names = " ".join(str(row.get(c) or "") for c in name_cols).lower()
        for ov in overrides:
            if ov["match_name"] and ov["match_name"] in row_names:
                if parts.get("zip") != ov["zip"]:
                    ref = load_zip_table().get(ov["zip"]) or {}
                    parts = {
                        **parts,
                        "zip": ov["zip"],
                        "city": ref.get("city") or parts.get("city"),
                        "state": ref.get("state") or parts.get("state"),
                        # The street no longer belongs to the corrected ZIP.
                        "street": None,
                        "unit": None,
                    }
                    corrected = 1
                    override_hits += 1
                break

        hid = stable_id("hh", "donor", str(i), parts.get("street") or "", parts.get("zip") or "")
        rec = {"id": hid, "source": "donor", "corrected": corrected, **parts}
        to_geocode.append(rec)

    print(f"\nDonor rows read: {total_rows}")
    print(f"Rows with a Bill address: {len(to_geocode)}")
    print(f"Rows with Ship but no Bill address: {ship_only}")
    if overrides:
        print(f"Address overrides applied: {override_hits}")

    results: dict[str, dict] = {}
    if args.zip_only:
        print("  --zip-only: placing at ZIP centroids, no geocoder contacted")
    elif not args.offline and to_geocode:
        results = census_batch_geocode(to_geocode, session)
        print(f"  census matched {len(results)}/{len(to_geocode)}")
        if not args.no_nominatim:
            missing = [r for r in to_geocode if r["id"] not in results]
            if missing:
                print(f"  nominatim fallback for {len(missing)} (1 req/s) ...", flush=True)
            for rec in missing:
                got = nominatim_geocode(rec, session, limiter)
                if got:
                    results[rec["id"]] = got

    for rec in to_geocode:
        got = results.get(rec["id"]) or zip_place(rec.get("zip"))
        if got is None:
            got = {"lat": None, "lon": None, "match_quality": "failed", "geocoder": None}
        households.append({**rec, **got})

    # ---------------- attenders (PRD 3a) ----------------
    attenders: list[dict] = []
    att_path = ROOT / args.attenders if not str(args.attenders).startswith("/") else args.attenders
    try:
        with open(att_path, newline="") as fh:
            for n, row in enumerate(csv.DictReader(fh)):
                z = re.sub(r"\D", "", str(row.get("zip", "")))[:5].zfill(5)
                if len(z) != 5 or z == "00000":
                    continue
                try:
                    size = int(float(row.get("household_size") or 1))
                except ValueError:
                    size = 1
                joined = str(row.get("joined_within_12mo", "")).strip().upper().startswith("Y")
                placed = zip_place(z) or {}
                lat, lon = placed.get("lat"), placed.get("lon")
                attenders.append({
                    "id": stable_id("att", z, str(n)),
                    "zip": z,
                    "lat": lat,
                    "lon": lon,
                    "household_size": max(1, size),
                    "joined_within_12mo": 1 if joined else 0,
                })
        print(f"Attender households read: {len(attenders)}")
    except FileNotFoundError:
        print(f"Attender ZIP card not found at {att_path} (optional, PRD 3a) — skipping.")

    # ---------------- flags ----------------
    placed = [h for h in households if h["lat"] is not None]
    riverside = [h for h in placed if (h.get("zip") or "").startswith("925")]
    anchor_pool = riverside or placed
    if anchor_pool:
        anchor = (median([h["lat"] for h in anchor_pool]), median([h["lon"] for h in anchor_pool]))
    else:
        anchor = (33.953, -117.396)  # downtown Riverside, only if nothing placed

    core = [h for h in placed if (h.get("state") or "CA").upper() == "CA"]
    if core:
        med = (median([h["lat"] for h in core]), median([h["lon"] for h in core]))
    else:
        med = anchor

    for h in households:
        h["in_state"] = 1 if (h.get("state") or "").upper() == "CA" else 0
        if h["lat"] is None:
            h["distance_mi_from_riverside_cluster"] = None
            h["outlier"] = 0
            continue
        d = haversine_mi(h["lat"], h["lon"], anchor[0], anchor[1])
        h["distance_mi_from_riverside_cluster"] = round(d, 2)
        d_med = haversine_mi(h["lat"], h["lon"], med[0], med[1])
        h["outlier"] = 1 if (not h["in_state"] or d_med > OUTLIER_MI) else 0

    # ---------------- reports ----------------
    order = ["exact", "interpolated", "zip-only", "zip-only-coarse", "failed"]
    counts = {k: 0 for k in order}
    for h in households:
        counts[h["match_quality"]] = counts.get(h["match_quality"], 0) + 1
    print_table(
        "Geocode match quality",
        [[k, counts.get(k, 0), f"{(counts.get(k,0)/max(1,total_rows))*100:.0f}%"] for k in order]
        + [["unplaced (no bill address)", total_rows - len(households), ""],
           ["TOTAL donor rows", total_rows, "100%"]],
        ["match_quality", "rows", "share of donor rows"],
    )
    print(f"Outliers flagged (out-of-state or >{OUTLIER_MI:.0f} mi from median): "
          f"{sum(h['outlier'] for h in households)}")
    print(f"Riverside-cluster anchor: {anchor[0]:.4f}, {anchor[1]:.4f}")

    # ---------------- outputs ----------------
    # Full, identifiable-adjacent file stays private (R-P1).
    priv = PRIVATE / "households_geocoded.csv"
    with priv.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(households[0].keys()) if households else ["id"])
        w.writeheader()
        w.writerows(households)
    print(f"  wrote {priv} (PRIVATE, gitignored)")

    # Anonymous publication (R-P3): id, lat, lon, zip, flags. Nothing else.
    write_json(DATA / "households_anon.json", {
        "generated_from": "donor bill addresses",
        "source": "live",
        "donor_rows_total": total_rows,
        "households": [
            {
                "id": h["id"],
                "lat": round_coord(h["lat"]) if h["lat"] is not None else None,
                "lon": round_coord(h["lon"]) if h["lon"] is not None else None,
                "zip": h.get("zip"),
                "in_state": h["in_state"],
                "outlier": h["outlier"],
                "match_quality": h["match_quality"],
                "corrected": h.get("corrected", 0),
            }
            for h in households
        ],
    })
    write_json(DATA / "attenders_anon.json", {
        "source": "live",
        "attenders": [
            {
                "id": a["id"],
                "zip": a["zip"],
                "lat": round_coord(a["lat"]) if a["lat"] is not None else None,
                "lon": round_coord(a["lon"]) if a["lon"] is not None else None,
                "household_size": a["household_size"],
                "joined_within_12mo": a["joined_within_12mo"],
            }
            for a in attenders
        ],
    })
    write_json(DATA / "data_quality.json", {
        "donor_rows_total": total_rows,
        "donor_rows_with_address": len(households),
        "unplaced_rows": total_rows - len([h for h in households if h["lat"] is not None]),
        "ship_only_rows": ship_only,
        "match_quality": counts,
        "outliers": sum(h["outlier"] for h in households),
        "overrides_applied": override_hits,
        "outlier_threshold_mi": OUTLIER_MI,
        "attender_households": len(attenders),
        "attenders_placed": len([a for a in attenders if a["lat"] is not None]),
        "riverside_anchor": {"lat": round_coord(anchor[0]), "lon": round_coord(anchor[1])},
        "caveat": (
            "The donor list is a proxy for the congregation, not the congregation. "
            "Rows without an address cannot be placed at all, and some addressed "
            "donors are remote supporters rather than attenders."
        ),
    })
    print("\nNext: scripts/check_pii.py, then scripts/centroid.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
