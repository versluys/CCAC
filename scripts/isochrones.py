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
import sys
import time

import requests

from common import CACHE, DATA, USER_AGENT, RateLimiter, read_json, write_json

OSRM_BASE = "https://router.project-osrm.org"
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


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--center-method", default=None)
    ap.add_argument("--lat", type=float)
    ap.add_argument("--lon", type=float)
    ap.add_argument(
        "--candidate",
        help="draw the bands around a candidate church instead of the centre; "
             "an id from data/churches.json, or part of its name",
    )
    # A 60-minute band reaches roughly 55 miles on open freeway, so the grid
    # has to cover that or the outer isochrone gets clipped into a square.
    ap.add_argument("--max-mi", type=float, default=55.0, help="half-extent of the sampled grid")
    ap.add_argument("--spacing-km", type=float, default=2.5, help="grid spacing; smaller is slower")
    ap.add_argument("--bands", default=",".join(str(b) for b in BANDS_MIN),
                    help="comma-separated minute bands")
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

    pts, dlat, dlon = build_grid(center[0], center[1], args.max_mi, args.spacing_km)
    print(f"Centre: {center[0]:.4f}, {center[1]:.4f} (method: {method})")
    print(f"Sampling {len(pts)} grid points at {args.spacing_km} km spacing "
          f"within {args.max_mi:.0f} mi, in batches of {CHUNK}.\n")

    session = requests.Session()
    limiter = RateLimiter(1.1)
    cache_path = CACHE / "osrm_isochrone_cache.json"
    cache = read_json(cache_path, {}) or {}

    minutes = osrm_durations(center, pts, session, limiter, cache)
    write_json(cache_path, cache)

    reached = [m for m in minutes if m is not None]
    if not reached:
        print("\n! OSRM returned nothing. Nothing was written.", file=sys.stderr)
        return 3
    print(f"\nRouted {len(reached)} of {len(pts)} grid points "
          f"({len(pts) - len(reached)} unreachable or unanswered).")
    print(f"Furthest routed point: {max(reached):.0f} min.")
    if max(reached) < max(bands):
        print(f"  note: nothing reached {max(bands)} min, so that band will be the whole grid.")

    features = []
    for band in bands:
        poly = cells_to_polygons(pts, minutes, dlat, dlon, band)
        n = len([m for m in minutes if m is not None and m <= band])
        if poly is None:
            print(f"  {band:>2} min: no cells reached")
            continue
        features.append({
            "type": "Feature",
            "properties": {"minutes": band, "cells": n},
            "geometry": json.loads(json.dumps(poly.__geo_interface__)),
        })
        print(f"  {band:>2} min: {n} cells")

    write_json(DATA / "isochrones.json", {
        "type": "FeatureCollection",
        "center": {"lat": round(center[0], 5), "lon": round(center[1], 5), "method": method},
        "grid_spacing_km": args.spacing_km,
        "bands_min": bands,
        "source": "OSRM driving profile over a sampled grid",
        "caveat": (
            "Blocky at the grid spacing by design: each cell means a road there was "
            "reachable within the band. Free-flow OSRM times, so a Sunday morning "
            "drive is usually a little faster than this shows."
        ),
        "features": features,
    })
    print("\nNext: scripts/seed_d1.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
