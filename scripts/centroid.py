#!/usr/bin/env python3
"""Phase 2 — compute every plausible congregational centre, not just one.

    .venv/bin/python scripts/centroid.py

A single centroid is a weak answer, so this emits four and lets the committee
argue with the evidence in front of them (PRD 7.2):

  mean_all          naive mean of in-state points, outliers included
  mean_trimmed      mean with out-of-state and >60 mi points dropped
  geometric_median  Weiszfeld; minimises total straight-line distance
  drive_time_median grid search minimising total drive minutes (needs OSRM)

The drive-time median is the default search centre, because families decide by
Sunday drive time and the I-15 / I-215 / SR-91 / SR-60 network distorts
straight lines badly. When OSRM is unreachable the script says so, marks the
method unavailable, and falls back to the geometric median rather than
silently passing off a straight-line answer as a drive-time one.
"""

from __future__ import annotations

import argparse
import itertools
import json
import math
import sys

import requests

from common import (
    CACHE,
    DATA,
    USER_AGENT,
    RateLimiter,
    centroid_mean,
    geometric_median,
    haversine_mi,
    median,
    print_table,
    read_json,
    round_coord,
    write_json,
)

OSRM_BASE = "https://router.project-osrm.org"
DRIVE_BANDS_MIN = [10, 15, 20, 30]

# Used only when OSRM is unreachable: a blunt straight-line-to-minutes proxy
# for inland Riverside County arterials. Labelled as an estimate everywhere
# it surfaces, because it is one.
PROXY_MPH = 27.0


def load_points(include_attenders: bool = True) -> tuple[list[dict], list[dict]]:
    """Placed households, with out-of-state donors excluded entirely.

    Out-of-state donors are supporters, not attenders: they can never drive to
    a Sunday service, so including them in any centre — even the deliberately
    naive one — answers the wrong question. They stay in the map layer and the
    data-quality panel, flagged, but they do not vote on where the parish sits.
    """
    hh = read_json(DATA / "households_anon.json", {}) or {}
    att = read_json(DATA / "attenders_anon.json", {}) or {}
    donors = [
        h for h in hh.get("households", [])
        if h.get("lat") is not None and h.get("in_state", 1)
    ]
    excluded = len([h for h in hh.get("households", []) if h.get("lat") is not None]) - len(donors)
    if excluded:
        print(f"Excluded {excluded} out-of-state donor household(s) from all centroid methods.")
    attenders = [a for a in att.get("attenders", []) if a.get("lat") is not None] if include_attenders else []
    return donors, attenders


def weighted_points(donors, attenders, mode: str) -> list[tuple[float, float, float]]:
    """(lat, lon, weight) for a given population view.

    Donor households weigh 1. Attender households weigh by household size,
    because the ZIP card counts people and the donor list counts giving units.
    A donor household that also returned a card would otherwise be counted
    twice; merged mode drops donor points whose ZIP is already represented by
    an attender card, which is the closest thing to deduplication that ZIP-only
    data permits.
    """
    if mode == "donors":
        return [(d["lat"], d["lon"], 1.0) for d in donors]
    if mode == "attenders":
        return [(a["lat"], a["lon"], float(a.get("household_size") or 1)) for a in attenders]
    att_zips = {a.get("zip") for a in attenders}
    pts = [(a["lat"], a["lon"], float(a.get("household_size") or 1)) for a in attenders]
    pts += [(d["lat"], d["lon"], 1.0) for d in donors if d.get("zip") not in att_zips]
    return pts


def osrm_table(sources, destinations, session, limiter) -> list[list[float]] | None:
    """Drive minutes from each source to each destination, or None."""
    coords = [f"{lon:.5f},{lat:.5f}" for lat, lon in itertools.chain(sources, destinations)]
    src_idx = ";".join(str(i) for i in range(len(sources)))
    dst_idx = ";".join(str(i + len(sources)) for i in range(len(destinations)))
    url = f"{OSRM_BASE}/table/v1/driving/{';'.join(coords)}"
    limiter.wait()
    try:
        resp = session.get(
            url,
            params={"sources": src_idx, "destinations": dst_idx, "annotations": "duration"},
            timeout=120,
            headers={"User-Agent": USER_AGENT},
        )
        resp.raise_for_status()
        payload = resp.json()
    except (requests.RequestException, ValueError) as exc:
        print(f"  ! OSRM table failed: {exc}", file=sys.stderr)
        return None
    if payload.get("code") != "Ok":
        print(f"  ! OSRM returned {payload.get('code')}", file=sys.stderr)
        return None
    return [[(v / 60.0) if v is not None else None for v in row] for row in payload["durations"]]


def proxy_minutes(a, b) -> float:
    """Straight-line miles converted at a flat arterial speed. An estimate."""
    return haversine_mi(a[0], a[1], b[0], b[1]) / PROXY_MPH * 60.0


def candidate_grid(center, radius_mi=15.0, spacing_km=2.0):
    """Candidate centres on a 2 km grid within 15 mi of the seed (PRD 7.2)."""
    spacing_mi = spacing_km * 0.621371
    steps = int(math.ceil(radius_mi / spacing_mi))
    lat0 = center[0]
    dlat = spacing_mi / 69.0
    dlon = spacing_mi / (69.0 * math.cos(math.radians(lat0)))
    out = []
    for i in range(-steps, steps + 1):
        for j in range(-steps, steps + 1):
            p = (lat0 + i * dlat, center[1] + j * dlon)
            if haversine_mi(p[0], p[1], center[0], center[1]) <= radius_mi:
                out.append(p)
    return out


def drive_stats(center, pts, matrix_row=None) -> dict:
    """Share of households within each drive band of a centre."""
    total_w = sum(w for *_, w in pts) or 1.0
    mins = []
    for idx, (lat, lon, w) in enumerate(pts):
        m = matrix_row[idx] if matrix_row is not None else proxy_minutes(center, (lat, lon))
        if m is None:
            m = proxy_minutes(center, (lat, lon))
        mins.append((m, w))
    out = {}
    for band in DRIVE_BANDS_MIN:
        w = sum(w for m, w in mins if m <= band)
        out[f"within_{band}min"] = round(w / total_w, 4)
        out[f"within_{band}min_count"] = int(sum(1 for m, _ in mins if m <= band))
    out["mean_min"] = round(sum(m * w for m, w in mins) / total_w, 2)
    out["median_min"] = round(median([m for m, _ in mins]), 2)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--no-osrm", action="store_true", help="skip the drive-time median")
    ap.add_argument("--outlier-mi", type=float, default=60.0)
    args = ap.parse_args()

    donors, attenders = load_points()
    if not donors and not attenders:
        print("! no placed households; run scripts/ingest.py first", file=sys.stderr)
        return 2

    session = requests.Session()
    limiter = RateLimiter(1.1)
    cache_path = CACHE / "osrm_cache.json"
    cache = read_json(cache_path, {}) or {}

    # Only build the three-way comparison once an attender ZIP card exists;
    # without it "merged" is just "donors" under another name (PRD 3a).
    modes = ("donors", "attenders", "merged") if attenders else ("donors",)
    views = {}
    for mode in modes:
        pts = weighted_points(donors, attenders, mode)
        if pts:
            views[mode] = pts
    print(f"Population views: " + ", ".join(f"{k} ({len(v)} pts)" for k, v in views.items()))

    centroids: dict[str, dict] = {}
    primary = views.get("merged") or views.get("donors")

    for mode, pts in views.items():
        suffix = "" if (mode == "merged" or len(views) == 1) else f"_{mode}"
        latlon = [(p[0], p[1]) for p in pts]
        w = [p[2] for p in pts]

        # 1. naive mean, everything in
        mean_all = centroid_mean(latlon)

        # 2. trimmed: drop points far from the median (out-of-state points are
        #    already flagged as outliers upstream and never reach here)
        med = (median([p[0] for p in latlon]), median([p[1] for p in latlon]))
        core = [(p, wi) for p, wi in zip(latlon, w) if haversine_mi(p[0], p[1], med[0], med[1]) <= args.outlier_mi]
        dropped = len(latlon) - len(core)
        mean_trimmed = centroid_mean([p for p, _ in core]) if core else mean_all

        # 3. geometric median on the trimmed core
        gm = geometric_median([p for p, _ in core], [wi for _, wi in core]) if core else mean_all

        centroids[f"mean_all{suffix}"] = {
            "lat": mean_all[0], "lon": mean_all[1],
            "meta": {"view": mode, "n": len(latlon), "note": "Naive mean; pulled by every remaining outlier."},
        }
        centroids[f"mean_trimmed{suffix}"] = {
            "lat": mean_trimmed[0], "lon": mean_trimmed[1],
            "meta": {"view": mode, "n": len(core), "dropped": dropped,
                     "note": f"Mean after dropping {dropped} point(s) >{args.outlier_mi:.0f} mi from the median."},
        }
        centroids[f"geometric_median{suffix}"] = {
            "lat": gm[0], "lon": gm[1],
            "meta": {"view": mode, "n": len(core),
                     "note": "Weiszfeld; minimises total straight-line distance. Robust to outliers."},
        }

    # 4. drive-time median, on the primary view only (the grid search is the
    #    expensive part and the committee only ever adopts one centre)
    osrm_ok = False
    if not args.no_osrm and primary:
        seed_key = "geometric_median" if "geometric_median" in centroids else "geometric_median_donors"
        seed = (centroids[seed_key]["lat"], centroids[seed_key]["lon"])
        grid = candidate_grid(seed)
        print(f"Drive-time median: testing {len(grid)} candidate centres against {len(primary)} households ...")
        dests = [(p[0], p[1]) for p in primary]
        best = None          # minimises total drive minutes
        best_share = None    # maximises households within 20 minutes
        # OSRM's public demo caps table size; walk the grid in chunks.
        chunk = 25
        for start in range(0, len(grid), chunk):
            srcs = grid[start : start + chunk]
            ck = json.dumps([[round(c, 4) for c in s] for s in srcs]) + "|" + str(len(dests))
            matrix = cache.get(ck)
            if matrix is None:
                matrix = osrm_table(srcs, dests, session, limiter)
                if matrix is None:
                    break
                cache[ck] = matrix
            for row, src in zip(matrix, srcs):
                mins = [
                    (m if m is not None else proxy_minutes(src, d), p[2])
                    for m, d, p in zip(row, dests, primary)
                ]
                total = sum(m * w for m, w in mins)
                if best is None or total < best[0]:
                    best = (total, src, row)

                # A second objective, because these are not the same question.
                # Minimising total minutes trades a household at 22 minutes
                # against one at 50, and the far household wins that trade
                # every time. Maximising the share inside a 20-minute drive is
                # what the scoring weights actually reward, and what a family
                # deciding whether to come on a wet Sunday actually feels.
                within = sum(w for m, w in mins if m <= 20.0)
                if best_share is None or (within, -total) > (best_share[0], -best_share[3]):
                    best_share = (within, src, row, total)
        if best:
            osrm_ok = True
            write_json(cache_path, cache)
            view_name = "merged" if "merged" in views else "donors"
            total_w = sum(p[2] for p in primary) or 1.0
            centroids["drive_time_median"] = {
                "lat": best[1][0], "lon": best[1][1],
                "meta": {"view": view_name,
                         "n": len(primary),
                         "total_drive_min": round(best[0], 1),
                         "note": "Minimises TOTAL drive minutes. A household 50 minutes out "
                                 "pulls as hard as one at 20, so this is not the same as "
                                 "serving the most families within a reasonable Sunday drive."},
            }
            if best_share:
                centroids["drive_time_max_share_20min"] = {
                    "lat": best_share[1][0], "lon": best_share[1][1],
                    "meta": {"view": view_name,
                             "n": len(primary),
                             "within_20min": round(best_share[0] / total_w, 4),
                             "total_drive_min": round(best_share[3], 1),
                             "note": "Maximises the share of households within a 20-minute drive. "
                                     "This is the objective the scoring weights reward."},
                }

    if not osrm_ok:
        print("  ! drive-time median unavailable (OSRM unreachable or disabled).")
        print("    Falling back to the geometric median as the default centre.")
        print("    Re-run this script from a machine that can reach router.project-osrm.org.")

    # ---------------- drive-band tables ----------------
    if osrm_ok and "drive_time_max_share_20min" in centroids:
        # The committee is choosing where most families can reasonably get to
        # on a Sunday, not where the summed odometer reading is lowest.
        default_method = "drive_time_max_share_20min"
    elif osrm_ok:
        default_method = "drive_time_median"
    else:
        default_method = "geometric_median" if "geometric_median" in centroids else "geometric_median_donors"
    rows = []
    for name, c in centroids.items():
        pts = views.get(c["meta"]["view"]) or primary
        stats = drive_stats((c["lat"], c["lon"]), pts)
        c["meta"]["drive_stats"] = stats
        c["meta"]["drive_stats_source"] = "osrm" if osrm_ok else "straight-line proxy"
        rows.append([
            name + (" *" if name == default_method else ""),
            f"{c['lat']:.4f}, {c['lon']:.4f}",
            c["meta"]["n"],
            f"{stats['within_10min']*100:.0f}%",
            f"{stats['within_15min']*100:.0f}%",
            f"{stats['within_20min']*100:.0f}%",
            f"{stats['within_30min']*100:.0f}%",
            stats["median_min"],
        ])
    print_table(
        f"Centroid methods (* = default; drive stats from {'OSRM' if osrm_ok else 'STRAIGHT-LINE PROXY, not real drive times'})",
        rows,
        ["method", "lat, lon", "n", "<=10min", "<=15min", "<=20min", "<=30min", "median min"],
    )

    write_json(DATA / "centroids.json", {
        "default_method": default_method,
        "drive_stats_source": "osrm" if osrm_ok else "proxy",
        "proxy_mph": None if osrm_ok else PROXY_MPH,
        "bands_min": DRIVE_BANDS_MIN,
        "centroids": {
            k: {"lat": round_coord(v["lat"]), "lon": round_coord(v["lon"]), **v["meta"]}
            for k, v in centroids.items()
        },
    })
    print("Next: scripts/churches.py --center-from data/centroids.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
