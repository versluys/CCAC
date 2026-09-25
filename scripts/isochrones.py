#!/usr/bin/env python3
"""Real drive-time isochrones, in 15 / 30 / 45 / 60 minute bands.

    .venv/bin/python scripts/isochrones.py                      # from the chosen centre
    .venv/bin/python scripts/isochrones.py --candidate "Grace"  # around a candidate church
    .venv/bin/python scripts/isochrones.py --bands 20,40        # different thresholds

Why this exists: the map used to draw circles sized at an assumed average speed
and label them drive-time rings. In this county that is simply false. A
20-minute drive from central Riverside runs a long way up the 91 and the 215 and
barely crosses the hills to the south. The honest shape is lobed, and getting it
requires actually routing.

Method: sample a grid around the point, ask OSRM for the driving time from that
point to every grid cell, then union the cells under each threshold. The result
is blocky at the grid spacing, which is deliberate: each cell means "a road here
was reachable in N minutes", and smoothing that into a confident curve would
claim precision the sampling does not have.

Note on what to use when. For "how far does the congregation drive to this
building", the dashboard already answers exactly, from a single routing request
against the households themselves, and it does it on demand per candidate. This
script draws the reachable *area*, which is the picture rather than the number.
Use it for the map; use the drawer for the figures.

Writes data/isochrones.json as GeoJSON. Responses are cached, so a re-run after
a dropped connection costs nothing.
"""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import math
import os
import sys
import time

import requests

from common import (
    CACHE, DATA, USER_AGENT, RateLimiter, describe_traffic, read_json, traffic_factor, write_json,
)

OSRM_BASE = "https://router.project-osrm.org"

# openrouteservice returns true isochrone polygons: one request per point gives
# every band, already following the road network. The grid method below samples
# a lattice and unions the cells, which is honest but blocky, and needs hundreds
# of requests per point to approach the same detail. Use ORS when a key is
# present; a free account covers far more than this parish will ever need.
ORS_ISOCHRONE_URL = "https://api.openrouteservice.org/v2/isochrones/driving-car"

# Free-tier limits at the time of writing: 20 isochrone requests per minute,
# 500 per day. Staying under the per-minute cap by a margin is cheaper than
# handling the 429 it would otherwise produce partway through a run.
ORS_MIN_INTERVAL_S = 3.2
ORS_DAILY_QUOTA = 500
BANDS_MIN = [15, 30, 45, 60]

# OSRM's public demo limits how many coordinates one table request may carry.
CHUNK = 95


def build_grid(lat0: float, lon0: float, max_mi: float, spacing_km: float):
    spacing_mi = spacing_km * 0.621371
    dlat = spacing_mi / 69.0
    dlon = spacing_mi / (69.0 * math.cos(math.radians(lat0)))
    steps = int(math.ceil(max_mi / spacing_mi))
    pts = []
    for i in range(-steps, steps + 1):
        for j in range(-steps, steps + 1):
            pts.append((lat0 + i * dlat, lon0 + j * dlon))
    return pts, dlat, dlon


def osrm_durations(center, dests, session, limiter, cache) -> list[float | None]:
    """Driving minutes from the centre to each destination."""
    out: list[float | None] = []
    for start in range(0, len(dests), CHUNK):
        batch = dests[start : start + CHUNK]
        key = hashlib.sha256(
            json.dumps([[round(center[0], 5), round(center[1], 5)],
                        [[round(a, 5), round(b, 5)] for a, b in batch]]).encode()
        ).hexdigest()[:20]
        cached = cache.get(key)
        if cached is not None:
            out.extend(cached)
            continue

        coords = ";".join(
            f"{lon:.5f},{lat:.5f}" for lat, lon in itertools.chain([center], batch)
        )
        dst = ";".join(str(i + 1) for i in range(len(batch)))
        limiter.wait()
        print(f"  routing {start + len(batch)} of {len(dests)} grid points ...", flush=True)
        row: list[float | None] | None = None
        for attempt in range(4):
            try:
                resp = session.get(
                    f"{OSRM_BASE}/table/v1/driving/{coords}",
                    params={"sources": "0", "destinations": dst, "annotations": "duration"},
                    timeout=120,
                    headers={"User-Agent": USER_AGENT},
                )
                resp.raise_for_status()
                payload = resp.json()
                if payload.get("code") != "Ok":
                    raise ValueError(payload.get("code"))
                row = [(v / 60.0) if v is not None else None for v in payload["durations"][0]]
                break
            except (requests.RequestException, ValueError, KeyError, IndexError) as exc:
                wait = 3 * 2 ** attempt
                print(f"    ! {type(exc).__name__}: {exc}; retrying in {wait}s", file=sys.stderr)
                time.sleep(wait)
        if row is None:
            print("  ! OSRM did not answer for this batch; those cells are left unreachable",
                  file=sys.stderr)
            row = [None] * len(batch)
        else:
            cache[key] = row
        out.extend(row)
    return out


def cells_to_polygons(pts, minutes, dlat, dlon, threshold):
    """Union the grid cells reachable within `threshold` minutes."""
    from shapely.geometry import box
    from shapely.ops import unary_union

    cells = [
        box(lon - dlon / 2, lat - dlat / 2, lon + dlon / 2, lat + dlat / 2)
        for (lat, lon), m in zip(pts, minutes)
        if m is not None and m <= threshold
    ]
    if not cells:
        return None
    merged = unary_union(cells)
    # Close pinholes where a single grid point missed a road, without inventing
    # reach the routing did not find.
    merged = merged.buffer(dlon * 0.55).buffer(-dlon * 0.5)
    if merged.is_empty:
        return None
    return merged.simplify(dlon / 8, preserve_topology=True)


def ors_isochrones(center, bands, key, session, limiter, tf=1.0) -> list[dict] | None:
    """True isochrone polygons from openrouteservice. All bands, one request."""
    limiter.wait()
    try:
        resp = session.post(
            ORS_ISOCHRONE_URL,
            headers={"Authorization": key, "Content-Type": "application/json",
                     "Accept": "application/geo+json"},
            json={
                # ORS takes [lon, lat] and seconds.
                "locations": [[round(center[1], 6), round(center[0], 6)]],
                # A band of N minutes under a traffic factor f is the area
                # reachable in N/f minutes of the router's own free-flow time:
                # slower traffic (f > 1) shrinks the area, faster expands it.
                "range": [int(round(b * 60 / tf)) for b in bands],
                "range_type": "time",
                "location_type": "start",
                # Smooth a little: 0 hugs individual roads and looks spidery,
                # 100 is a blob. The middle reads as a neighbourhood.
                "smoothing": 25,
                "attributes": ["total_pop"] if False else [],
            },
            timeout=120,
        )
        if resp.status_code == 403:
            print("    ! openrouteservice refused the key (403)", file=sys.stderr)
            return None
        if resp.status_code == 429:
            print("    ! openrouteservice rate limit reached; waiting 60s", file=sys.stderr)
            time.sleep(60)
            return None
        resp.raise_for_status()
        payload = resp.json()
    except (requests.RequestException, ValueError) as exc:
        print(f"    ! openrouteservice: {type(exc).__name__}: {exc}", file=sys.stderr)
        return None

    feats = []
    for f in payload.get("features", []):
        secs = (f.get("properties") or {}).get("value")
        if secs is None:
            continue
        # Label the band by the minutes asked for, not the free-flow seconds sent.
        feats.append({
            "type": "Feature",
            "properties": {"minutes": int(round(secs * tf / 60)), "cells": None},
            "geometry": f.get("geometry"),
        })
    # ORS returns largest first; draw order wants that reversed by the map,
    # which sorts anyway. Sort here so the file reads sensibly.
    feats.sort(key=lambda f: f["properties"]["minutes"])
    return feats or None


def load_candidates() -> list[dict]:
    """Every candidate on file, discovered and example alike."""
    out = []
    for name in ("churches.json", "examples.json"):
        payload = read_json(DATA / name, {}) or {}
        for c in payload.get("candidates", []):
            if c.get("lat") is not None:
                out.append(c)
    return out


def compute_set(center, bands, args, session, limiter, cache, label, ors_key=None,
                tf=1.0) -> list[dict]:
    """The bands around one point, preferring real isochrones over a sampled grid."""
    if ors_key:
        feats = ors_isochrones(center, bands, ors_key, session, limiter, tf)
        if feats:
            return feats
        print(f"    falling back to the sampled grid for {label}", file=sys.stderr)

    pts, dlat, dlon = build_grid(center[0], center[1], args.max_mi, args.spacing_km)
    minutes = osrm_durations(center, pts, session, limiter, cache)
    minutes = [None if m is None else m * tf for m in minutes]
    reached = [m for m in minutes if m is not None]
    if not reached:
        print(f"  ! {label}: OSRM returned nothing", file=sys.stderr)
        return []
    features = []
    for band in bands:
        poly = cells_to_polygons(pts, minutes, dlat, dlon, band)
        if poly is None:
            continue
        features.append({
            "type": "Feature",
            "properties": {"minutes": band,
                           "cells": len([m for m in minutes if m is not None and m <= band])},
            "geometry": json.loads(json.dumps(poly.__geo_interface__)),
        })
    return features


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--center-method", default=None)
    ap.add_argument("--lat", type=float)
    ap.add_argument("--lon", type=float)
    ap.add_argument(
        "--candidate",
        help="draw the bands around one candidate church instead of the centre; "
             "an id, or part of its name",
    )
    ap.add_argument(
        "--all-candidates", action="store_true",
        help="compute a set for every candidate, so the map can show the reachable "
             "area around whichever one is selected",
    )
    # A 60-minute band reaches roughly 55 miles on open freeway, so the grid
    # has to cover that or the outer isochrone gets clipped into a square.
    ap.add_argument("--max-mi", type=float, default=55.0, help="half-extent of the sampled grid")
    ap.add_argument("--spacing-km", type=float, default=2.5, help="grid spacing; smaller is slower")
    ap.add_argument("--bands", default=",".join(str(b) for b in BANDS_MIN),
                    help="comma-separated minute bands")
    ap.add_argument("--traffic-factor", type=float, default=None,
                    help="multiply drive times (1.0 = as routed)")
    ap.add_argument("--no-ors", action="store_true",
                    help="ignore CCAC_ORS_KEY and use the sampled grid instead")
    args = ap.parse_args()

    cent = read_json(DATA / "centroids.json")
    if args.candidate:
        # The committee's real question is about a building, not an abstract
        # centre: if the parish moved here, how far would people drive?
        churches = read_json(DATA / "churches.json", {}) or {}
        needle = args.candidate.lower()
        matches = [
            c for c in churches.get("candidates", [])
            if c.get("id", "").lower() == needle or needle in (c.get("name") or "").lower()
        ]
        if not matches:
            print(f"! no candidate matching {args.candidate!r} in data/churches.json", file=sys.stderr)
            return 2
        if len(matches) > 1 and not any(c.get("id", "").lower() == needle for c in matches):
            print(f"! {len(matches)} candidates match {args.candidate!r}; pass an id instead:",
                  file=sys.stderr)
            for c in matches[:10]:
                print(f"    {c['id']}  {c.get('name')}", file=sys.stderr)
            return 2
        chosen = next((c for c in matches if c.get("id", "").lower() == needle), matches[0])
        center = (chosen["lat"], chosen["lon"])
        method = f"candidate:{chosen['id']}"
        print(f"Drawing bands around: {chosen.get('name')} ({chosen['id']})")
    elif args.lat is not None and args.lon is not None:
        center, method = (args.lat, args.lon), "manual"
    elif cent:
        method = args.center_method or cent["default_method"]
        if method not in cent["centroids"]:
            print(f"! no centroid named {method}; have: {list(cent['centroids'])}", file=sys.stderr)
            return 2
        c = cent["centroids"][method]
        center, = [(c["lat"], c["lon"])]
    else:
        print("! run scripts/centroid.py first, or pass --lat/--lon", file=sys.stderr)
        return 2

    try:
        bands = sorted({int(b) for b in str(args.bands).split(",") if b.strip()})
    except ValueError:
        print(f"! --bands must be comma-separated whole minutes, got {args.bands!r}", file=sys.stderr)
        return 2
    if not bands:
        print("! no bands requested", file=sys.stderr)
        return 2

    ors_key = None if args.no_ors else os.environ.get("CCAC_ORS_KEY", "").strip() or None
    tf = traffic_factor(args.traffic_factor)
    print(f"Traffic: {describe_traffic(tf)}")

    session = requests.Session()
    # A free openrouteservice key allows 20 isochrone requests a minute and 500
    # a day, so 3.2 seconds apart keeps a margin under the per-minute cap. OSRM
    # has no published cap and simply asks for gentleness.
    limiter = RateLimiter(ORS_MIN_INTERVAL_S if ors_key else 1.1)
    cache_path = CACHE / "osrm_isochrone_cache.json"
    cache = read_json(cache_path, {}) or {}

    # Every point we draw bands around, keyed by subject: the chosen centre, and
    # each candidate, so the map can answer "what can be reached from HERE" for
    # whichever building is selected rather than only for an abstract centre.
    subjects: list[tuple[str, tuple[float, float], str]] = [("center", center, f"centre ({method})")]
    if args.all_candidates:
        cands = load_candidates()
        if not cands:
            print("! --all-candidates but no candidates on file", file=sys.stderr)
            return 2
        subjects += [(c["id"], (c["lat"], c["lon"]), c.get("name") or c["id"]) for c in cands]

    print(f"Bands: {', '.join(str(b) for b in bands)} min")
    print(f"Subjects: {len(subjects)}"
          f"{' (the centre only; --all-candidates for every candidate)' if not args.all_candidates else ''}")
    if ors_key:
        mins = len(subjects) * ORS_MIN_INTERVAL_S / 60
        print("Method: openrouteservice — true isochrone polygons, one request per subject.")
        print(f"{len(subjects)} request(s), paced at one per {ORS_MIN_INTERVAL_S:g}s to stay "
              f"under the free tier's 20 per minute. About {mins:.0f} minute(s).")
        if len(subjects) > ORS_DAILY_QUOTA:
            print(f"  ! {len(subjects)} subjects exceeds the free daily quota of "
                  f"{ORS_DAILY_QUOTA}. Later ones will fail; split the run across days,"
                  f" or narrow the candidate list.", file=sys.stderr)
        print()
    else:
        probe, _, _ = build_grid(center[0], center[1], args.max_mi, args.spacing_km)
        per = -(-len(probe) // CHUNK)
        print("Method: sampled grid through OSRM. Honest but blocky, and slow: a real")
        print("isochrone follows the streets, and a lattice at this spacing cannot.")
        print("  For the shape you actually want, get a free key at openrouteservice.org")
        print("  and set CCAC_ORS_KEY. One request per subject instead of hundreds.")
        print(f"\n{len(probe)} grid points per subject at {args.spacing_km} km spacing, "
              f"in batches of {CHUNK}.")
        print(f"About {per * len(subjects)} OSRM request(s) in total, cached between runs.\n")

    sets: dict[str, list[dict]] = {}
    for i, (key, point, label) in enumerate(subjects, 1):
        print(f"[{i}/{len(subjects)}] {label}")
        feats = compute_set(point, bands, args, session, limiter, cache, label, ors_key, tf)
        if feats:
            sets[key] = feats
            # Report the shape, not the cell count: a routing service returns
            # polygons and no cells, and printing "cells:None" for every band
            # reads as though nothing was computed.
            parts = []
            for f in feats:
                ring = (f.get("geometry") or {}).get("coordinates") or []
                verts = 0
                stack = [ring]
                while stack:
                    node = stack.pop()
                    if node and isinstance(node[0], (int, float)):
                        verts += 1
                    elif node:
                        stack.extend(node)
                parts.append(f"{f['properties']['minutes']}min:{verts}pts")
            print("    " + ", ".join(parts))
        write_json(cache_path, cache)

    if not sets:
        print("\n! nothing computed. Nothing was written.", file=sys.stderr)
        return 3

    write_json(DATA / "isochrones.json", {
        "type": "IsochroneSets",
        "center": {"lat": round(center[0], 5), "lon": round(center[1], 5), "method": method},
        "grid_spacing_km": args.spacing_km,
        "bands_min": bands,
        "traffic_factor": tf,
        "source": ("openrouteservice isochrones, driving-car"
                   if ors_key else "OSRM driving profile over a sampled grid"),
        "caveat": (
            (f"Drive times multiplied by {tf:g}. " if abs(tf - 1.0) > 1e-9 else "")
            + ("Free-flow driving times, so a Sunday morning is usually a little quicker."
            if ors_key else
            "Blocky at the grid spacing by design: each cell means a road there was "
            "reachable within the band. Free-flow OSRM times, so a Sunday morning "
            "drive is usually a little faster than this shows.")
        ),
        # Keyed by subject: "center", or a candidate id.
        "sets": sets,
    })
    print(f"\n{len(sets)} isochrone set(s) written.")
    print("Next: scripts/seed_d1.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
