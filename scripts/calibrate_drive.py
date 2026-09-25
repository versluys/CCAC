#!/usr/bin/env python3
"""Check the router's drive times against trips you actually know.

    .venv/bin/python scripts/calibrate_drive.py

The router is not a traffic model. OSRM's public profile uses speed limits, and
falls back to conservative defaults wherever OpenStreetMap has no maxspeed tag,
which in Riverside County is a lot of road. So its times can be wrong in either
direction, and no amount of arguing settles which.

This settles it. Put in trips you drive, with the time they really take on a
Sunday morning, and it asks the router for the same trips and reports the ratio.
That ratio is the traffic factor, derived rather than guessed:

    export CCAC_TRAFFIC_FACTOR=<the number this prints>

Edit private/known_trips.csv — it is gitignored, because where people drive from
is their business:

    from_lat,from_lon,to_lat,to_lon,real_minutes,label
    33.9533,-117.3962,33.8753,-117.5664,15,Riverside to Corona

A ratio below 1 means the router is slower than the road, and a factor below 1
is then justified by evidence rather than by assumption.
"""

from __future__ import annotations

import csv
import sys

import requests

from common import PRIVATE, USER_AGENT, RateLimiter, median, print_table

OSRM_BASE = "https://router.project-osrm.org"

TEMPLATE = """from_lat,from_lon,to_lat,to_lon,real_minutes,label
# One trip per line. real_minutes is what it actually takes you on a Sunday
# morning, door to door minus parking. Three or four honest trips beat a dozen
# guessed ones. Delete these examples and put in your own.
33.9533,-117.3962,33.8753,-117.5664,15,Riverside to Corona
33.9533,-117.3962,34.0556,-117.1825,25,Riverside to Redlands
33.9533,-117.3962,33.7475,-117.2287,22,Riverside to Perris
"""


def route_minutes(a, b, session, limiter) -> float | None:
    limiter.wait()
    url = (f"{OSRM_BASE}/route/v1/driving/"
           f"{a[1]:.5f},{a[0]:.5f};{b[1]:.5f},{b[0]:.5f}")
    try:
        r = session.get(url, params={"overview": "false"}, timeout=60,
                        headers={"User-Agent": USER_AGENT})
        r.raise_for_status()
        payload = r.json()
        if payload.get("code") != "Ok" or not payload.get("routes"):
            return None
        return payload["routes"][0]["duration"] / 60.0
    except (requests.RequestException, ValueError, KeyError, IndexError) as exc:
        print(f"  ! {type(exc).__name__}: {exc}", file=sys.stderr)
        return None


def main() -> int:
    path = PRIVATE / "known_trips.csv"
    if not path.exists():
        path.write_text(TEMPLATE)
        print(f"Wrote a template to {path}.")
        print("Put in trips you actually drive, with real Sunday-morning times, then re-run.")
        print("The examples in it are plausible but they are not measurements.")
        return 0

    trips = []
    with path.open() as fh:
        for row in csv.DictReader(l for l in fh if not l.lstrip().startswith("#")):
            try:
                trips.append({
                    "a": (float(row["from_lat"]), float(row["from_lon"])),
                    "b": (float(row["to_lat"]), float(row["to_lon"])),
                    "real": float(row["real_minutes"]),
                    "label": (row.get("label") or "").strip() or "trip",
                })
            except (KeyError, ValueError, TypeError):
                continue

    if not trips:
        print(f"! no usable rows in {path}", file=sys.stderr)
        return 2

    session = requests.Session()
    limiter = RateLimiter(1.1)

    rows, ratios = [], []
    for t in trips:
        routed = route_minutes(t["a"], t["b"], session, limiter)
        if routed is None:
            rows.append([t["label"], f"{t['real']:.0f}", "no route", "-"])
            continue
        ratio = t["real"] / routed if routed else None
        ratios.append(ratio)
        rows.append([t["label"], f"{t['real']:.0f}", f"{routed:.1f}", f"{ratio:.2f}"])

    print_table("Known trips against the router",
                rows, ["trip", "you say", "router says", "ratio"])

    if not ratios:
        print("! nothing routed, so nothing to conclude.", file=sys.stderr)
        return 3

    factor = median(ratios)
    print(f"Median ratio across {len(ratios)} trip(s): {factor:.2f}")
    print()
    if factor < 0.9:
        print(f"The router is consistently SLOWER than these roads really are.")
        print(f"A factor of {factor:.2f} is justified by these measurements:")
        print(f"    export CCAC_TRAFFIC_FACTOR={factor:.2f}")
    elif factor > 1.1:
        print(f"The router is consistently FASTER than these roads really are.")
        print(f"    export CCAC_TRAFFIC_FACTOR={factor:.2f}")
    else:
        print("The router is within 10% of your own times, which is inside the noise of")
        print("door-to-door variation. Leave the factor at 1.0.")

    spread = max(ratios) / min(ratios) if min(ratios) else 0
    if spread > 1.6:
        print()
        print(f"Caution: the ratios disagree with each other by {spread:.1f}x, so a single")
        print("multiplier is fitting trips that behave differently. That usually means")
        print("freeway trips and surface-street trips need different treatment, and one")
        print("number for both will be wrong for each.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
