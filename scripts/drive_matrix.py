#!/usr/bin/env python3
"""Route every candidate church to every household, in one batch.

    .venv/bin/python scripts/drive_matrix.py

Why this is needed, and why it matters more at 40 miles than at 20:

fit_score gives its heaviest weight, 35 of 100 points, to the share of
households within a 20-minute drive. The discovery pipeline cannot fill that
field, so until a candidate is routed it scores zero on the factor that matters
most. The dashboard routes a candidate when somebody opens it, which is fine for
the handful under active consideration and useless for ranking thousands. The
sort order is what decides which candidates a person ever opens, so a ranking
computed with the largest weight missing quietly buries good buildings.

This routes all of them up front. OSRM's table endpoint takes many sources
against the same destinations, so with a few dozen households roughly fifty
candidates fit in one request: a few thousand candidates cost a couple of
minutes, once, cached.

Distance is also the wrong filter at this radius. A church 38 miles out along
the 91 can be a shorter Sunday drive than one 22 miles away over the hills.
These routed figures are what the table should filter on.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time

import requests

from common import CACHE, DATA, USER_AGENT, RateLimiter, haversine_mi, median, read_json, write_json

OSRM_BASE = "https://router.project-osrm.org"
MAX_COORDS = 95
BANDS = [15, 20, 30, 45, 60]
PROXY_MPH = 27.0


def osrm_matrix(sources, dests, session, limiter, cache):
    """Drive minutes for every source against every destination."""
    coords = [f"{lon:.5f},{lat:.5f}" for lat, lon in list(sources) + list(dests)]
    src_idx = ";".join(str(i) for i in range(len(sources)))
    dst_idx = ";".join(str(i + len(sources)) for i in range(len(dests)))
    key = hashlib.sha256((";".join(coords) + f"|{len(sources)}").encode()).hexdigest()[:20]
    if key in cache:
        return cache[key]

    url = f"{OSRM_BASE}/table/v1/driving/{';'.join(coords)}"
    for attempt in range(4):
        limiter.wait()
        try:
            resp = session.get(
                url,
                params={"sources": src_idx, "destinations": dst_idx, "annotations": "duration"},
                timeout=180,
                headers={"User-Agent": USER_AGENT},
            )
            resp.raise_for_status()
            payload = resp.json()
            if payload.get("code") != "Ok":
                raise ValueError(payload.get("code"))
            rows = [[(v / 60.0) if v is not None else None for v in row]
                    for row in payload["durations"]]
            cache[key] = rows
            return rows
        except (requests.RequestException, ValueError, KeyError) as exc:
            wait = 4 * 2 ** attempt
            print(f"    ! {type(exc).__name__}: {exc}; retrying in {wait}s", file=sys.stderr)
            time.sleep(wait)
    return None


def summarise(minutes: list[float | None], total: int) -> dict:
    routed = [m for m in minutes if m is not None]
    bands = {}
    for b in BANDS:
        n = len([m for m in routed if m <= b])
        bands[str(b)] = {"count": n, "share": round(n / max(1, total), 4)}
    return {
        "bands": bands,
        "median_min": round(median(routed), 1) if routed else None,
        "mean_min": round(sum(routed) / len(routed), 1) if routed else None,
        "unreachable": len(minutes) - len(routed),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--limit", type=int, default=0,
                    help="route only the N nearest candidates; 0 routes all of them")
    ap.add_argument("--offline", action="store_true",
                    help="use a straight-line proxy instead of routing; clearly labelled as such")
    args = ap.parse_args()

    churches = read_json(DATA / "churches.json", {}) or {}
    examples = read_json(DATA / "examples.json", {}) or {}
    hh = read_json(DATA / "households_anon.json", {}) or {}
    # Examples are routed too. Otherwise they sit at zero on the heaviest
    # scoring weight and the demonstration shows a ranking that cannot move.
    cands = [c for c in list(churches.get("candidates", [])) + list(examples.get("candidates", []))
             if c.get("lat") is not None]
    # Out-of-state supporters and flagged outliers are not driving here on a
    # Sunday, so they do not belong in a measure of the Sunday drive.
    homes = [h for h in hh.get("households", [])
             if h.get("lat") is not None and h.get("in_state") and not h.get("outlier")]

    if not cands:
        print("! no candidates in data/churches.json; run scripts/churches.py first", file=sys.stderr)
        return 2
    if not homes:
        print("! no placed households; run scripts/ingest.py first", file=sys.stderr)
        return 2

    if args.limit:
        center = churches.get("center") or {}
        if center.get("lat") is None:
            cent = read_json(DATA / "centroids.json", {}) or {}
            center = (cent.get("centroids") or {}).get(cent.get("default_method") or "", {})
        if center.get("lat") is not None:
            cands.sort(key=lambda c: haversine_mi(c["lat"], c["lon"], center["lat"], center["lon"]))
        cands = cands[: args.limit]

    dests = [(h["lat"], h["lon"]) for h in homes]
    per_request = max(1, MAX_COORDS - len(dests))
    batches = -(-len(cands) // per_request)
    print(f"Candidates: {len(cands)}   households: {len(homes)}")
    print(f"{per_request} candidates per OSRM request -> {batches} request(s)"
          f"{' (skipped: --offline)' if args.offline else ''}\n")

    session = requests.Session()
    limiter = RateLimiter(1.1)
    cache_path = CACHE / "osrm_matrix_cache.json"
    cache = read_json(cache_path, {}) or {}

    out: dict[str, dict] = {}
    failed_batches = 0
    routed_count = 0
    proxy_count = 0

    for start in range(0, len(cands), per_request):
        batch = cands[start : start + per_request]
        rows = None
        # Tracked per batch, not once for the whole run. A batch that OSRM
        # refused falls back to straight-line estimates, and labelling those
        # "osrm" would present an estimate as a measured drive time — the one
        # thing this tool must never do.
        batch_source = "proxy"
        if not args.offline:
            print(f"  routing {start + len(batch)} of {len(cands)} ...", flush=True)
            rows = osrm_matrix([(c["lat"], c["lon"]) for c in batch], dests, session, limiter, cache)
            if rows is None:
                failed_batches += 1
            else:
                batch_source = "osrm"
        if rows is None:
            rows = [[haversine_mi(c["lat"], c["lon"], d[0], d[1]) / PROXY_MPH * 60 for d in dests]
                    for c in batch]
            if not args.offline:
                print("    fell back to a straight-line estimate for this batch", file=sys.stderr)
        for c, row in zip(batch, rows):
            summary = summarise(row, len(homes))
            out[c["id"]] = {
                **summary,
                "minutes": {h["id"]: (None if m is None else round(m, 1))
                            for h, m in zip(homes, row)},
                "source": batch_source,
            }
        if batch_source == "osrm":
            routed_count += len(batch)
        else:
            proxy_count += len(batch)

    if not args.offline:
        write_json(cache_path, cache)
    if failed_batches:
        print(f"\n! {failed_batches} batch(es) fell back to straight-line estimates "
              f"({proxy_count} candidate(s)). Those rows are labelled 'proxy', and the "
              f"dashboard shows them as estimates rather than drive times.", file=sys.stderr)

    # The file-level source is the weaker of the two, so a partly-failed run is
    # never summarised as fully routed.
    overall = "osrm" if proxy_count == 0 and not args.offline else (
        "proxy" if routed_count == 0 else "mixed")
    write_json(DATA / "candidate_drive.json", {
        "households": len(homes),
        "bands_min": BANDS,
        "source": overall,
        "routed_candidates": routed_count,
        "proxy_candidates": proxy_count,
        "caveat": ("Free-flow OSRM driving times; a Sunday morning is usually a little quicker. "
                   "Out-of-state and outlier households are excluded."
                   if overall == "osrm" else
                   ("STRAIGHT-LINE ESTIMATES at 27 mph, not drive times."
                    if overall == "proxy" else
                    f"MIXED: {routed_count} candidate(s) routed through OSRM, "
                    f"{proxy_count} left as straight-line estimates. Check the per-candidate "
                    f"source before comparing two candidates against each other.")),
        "candidates": out,
    })

    # What the committee will actually want to know from this.
    ranked = sorted(out.items(), key=lambda kv: -kv[1]["bands"]["20"]["share"])
    print(f"\nBest 20-minute reach, top 10 of {len(ranked)}:")
    by_id = {c["id"]: c for c in cands}
    for cid, s in ranked[:10]:
        name = (by_id.get(cid, {}).get("name") or "?")[:42]
        print(f"  {s['bands']['20']['share']*100:5.0f}% within 20 min  "
              f"median {str(s['median_min']):>5} min  {name}")

    reach = [s["bands"]["20"]["share"] for s in out.values()]
    print(f"\nAcross all candidates: best {max(reach)*100:.0f}%, "
          f"median {median(reach)*100:.0f}%, worst {min(reach)*100:.0f}% within 20 minutes.")
    print(f"Routed: {routed_count}   straight-line estimates: {proxy_count}")
    print("Next: scripts/seed_d1.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
