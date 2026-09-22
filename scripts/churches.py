#!/usr/bin/env python3
"""Phase 3 — find every church within 20 mi of the chosen centre and screen it.

    .venv/bin/python scripts/churches.py
    .venv/bin/python scripts/churches.py --center-method geometric_median
    .venv/bin/python scripts/churches.py --google-places   # needs CCAC_GOOGLE_KEY

What this can and cannot tell you (PRD 7.3, 7.4):

  It CAN say where a building is, how big its footprint is, and how much
  parking sits next to it. Those come from OpenStreetMap geometry.

  It CANNOT say how many people fit inside, or whether anyone will lease it.
  Capacity here is an ESTIMATE derived from footprint and parking, banded
  coarsely, and every band is labelled as an estimate in the UI. Seats get
  confirmed by phone or by walking the building, and nothing else.

OSM church coverage is incomplete and building polygons are often missing, so
'unknown' is a real answer and is never dropped from the list.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import time

import requests

from common import (
    CACHE,
    DATA,
    USER_AGENT,
    RateLimiter,
    haversine_mi,
    print_table,
    read_json,
    round_coord,
    write_json,
)

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
SEARCH_RADIUS_M = 32187  # 20 statute miles
PARKING_RADIUS_M = 100

M2_PER_FT2 = 0.09290304

# Capacity thresholds (PRD 7.4). A 200-seat sanctuary needs roughly
# 3,000-4,000 ft2 of seating; the building around it -- narthex, restrooms,
# fellowship space -- typically pushes the footprint past 6,000 ft2. Parking
# codes locally run about 1 space per 3-4 seats, so 50-70 stalls, and at
# ~30 m2 per stall including aisles that is roughly 1,500-2,100 m2 of lot.
FOOTPRINT_LIKELY_FT2 = 6000.0
PARKING_LIKELY_M2 = 1500.0

OVERPASS_QUERY = """
[out:json][timeout:180];
(
  nwr["amenity"="place_of_worship"]["religion"="christian"](around:{radius},{lat},{lon});
  nwr["building"~"church|chapel|cathedral"](around:{radius},{lat},{lon});
);
out center tags geom;
"""

PARKING_QUERY = """
[out:json][timeout:180];
(
  way["amenity"="parking"](around:{radius},{lat},{lon});
  relation["amenity"="parking"](around:{radius},{lat},{lon});
);
out center geom;
"""


# --------------------------------------------------------------------------
# geometry: equal-area footprint in California Albers (EPSG:3310)
# --------------------------------------------------------------------------
def _projector():
    from pyproj import CRS, Transformer

    return Transformer.from_crs(CRS.from_epsg(4326), CRS.from_epsg(3310), always_xy=True)


def ring_area_m2(coords: list[dict], transformer) -> float:
    """Planar area of a closed ring, projected to an equal-area CRS."""
    if not coords or len(coords) < 4:
        return 0.0
    try:
        from shapely.geometry import Polygon
    except ImportError:
        return 0.0
    pts = [transformer.transform(c["lon"], c["lat"]) for c in coords]
    try:
        poly = Polygon(pts)
        if not poly.is_valid:
            poly = poly.buffer(0)
        return float(abs(poly.area))
    except Exception:
        return 0.0


def element_area_m2(el: dict, transformer) -> float:
    if el.get("type") == "way" and el.get("geometry"):
        return ring_area_m2(el["geometry"], transformer)
    if el.get("type") == "relation":
        total = 0.0
        for member in el.get("members", []):
            if member.get("role") in ("outer", "") and member.get("geometry"):
                total += ring_area_m2(member["geometry"], transformer)
            elif member.get("role") == "inner" and member.get("geometry"):
                total -= ring_area_m2(member["geometry"], transformer)
        return max(0.0, total)
    return 0.0


def element_point(el: dict) -> tuple[float, float] | None:
    if el.get("type") == "node" and el.get("lat") is not None:
        return (el["lat"], el["lon"])
    c = el.get("center")
    if c:
        return (c["lat"], c["lon"])
    geom = el.get("geometry") or []
    if geom:
        return (
            sum(g["lat"] for g in geom) / len(geom),
            sum(g["lon"] for g in geom) / len(geom),
        )
    return None


def point_in_ring(pt: tuple[float, float], ring: list[dict]) -> bool:
    """Ray casting in lat/lon; adequate for 'is this node inside that building'."""
    x, y = pt[1], pt[0]
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]["lon"], ring[i]["lat"]
        x2, y2 = ring[(i + 1) % n]["lon"], ring[(i + 1) % n]["lat"]
        if (y1 > y) != (y2 > y):
            xin = (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-15) + x1
            if x < xin:
                inside = not inside
    return inside


# --------------------------------------------------------------------------
# fetching
# --------------------------------------------------------------------------
def overpass(query: str, session: requests.Session, limiter: RateLimiter, label: str,
             rounds: int = 4) -> dict | None:
    """Query Overpass, cache the answer, and survive a dropped connection.

    The cache is keyed on a SHA-256 of the query text. Python's built-in hash()
    is randomised per process, so keying on it would mean the cache never hit
    across runs and every retry re-downloaded the whole county.

    Each round tries every endpoint in turn, then backs off before the next
    round. Overpass is a donated public service and a flaky client should wait
    rather than hammer it.
    """
    digest = hashlib.sha256(query.encode()).hexdigest()[:16]
    cache_key = CACHE / f"overpass_{digest}.json"
    cached = read_json(cache_key)
    if cached is not None:
        print(f"  {label}: cache hit ({len(cached.get('elements', []))} elements)")
        return cached

    for attempt in range(rounds):
        for endpoint in OVERPASS_ENDPOINTS:
            limiter.wait()
            print(f"  {label}: querying {endpoint}"
                  f"{f' (round {attempt + 1} of {rounds})' if attempt else ''} ...", flush=True)
            try:
                resp = session.post(endpoint, data={"data": query}, timeout=240,
                                    headers={"User-Agent": USER_AGENT})
                if resp.status_code in (429, 504):
                    print(f"    busy ({resp.status_code}); trying the next endpoint")
                    continue
                resp.raise_for_status()
                payload = resp.json()
            except (requests.RequestException, ValueError) as exc:
                print(f"    ! {type(exc).__name__}: {exc}", file=sys.stderr)
                continue
            if not isinstance(payload.get("elements"), list):
                print("    ! response had no element list; not caching it", file=sys.stderr)
                continue
            write_json(cache_key, payload)
            print(f"  {label}: {len(payload['elements'])} elements (cached)")
            return payload
        if attempt < rounds - 1:
            wait = 5 * 2 ** attempt
            print(f"    all endpoints failed; waiting {wait}s before retrying", flush=True)
            time.sleep(wait)

    print(f"  ! {label}: every Overpass endpoint failed after {rounds} rounds.", file=sys.stderr)
    return None


def google_places(lat: float, lon: float, radius_m: int, key: str,
                  session: requests.Session) -> list[dict]:
    """Optional gap-filler (PRD 7.3 mitigation 1). Behind a flag and a key."""
    url = "https://places.googleapis.com/v1/places:searchText"
    headers = {
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,"
                            "places.location,places.websiteUri,places.nationalPhoneNumber",
        "Content-Type": "application/json",
    }
    body = {
        "textQuery": "church",
        "locationBias": {"circle": {"center": {"latitude": lat, "longitude": lon},
                                    "radius": min(float(radius_m), 50000.0)}},
        "maxResultCount": 20,
    }
    out, page = [], None
    for _ in range(3):
        if page:
            body["pageToken"] = page
        try:
            resp = session.post(url, headers=headers, json=body, timeout=60)
            resp.raise_for_status()
            payload = resp.json()
        except (requests.RequestException, ValueError) as exc:
            print(f"  ! Google Places: {exc}", file=sys.stderr)
            break
        out.extend(payload.get("places", []))
        page = payload.get("nextPageToken")
        if not page:
            break
        time.sleep(2)
    return out


# --------------------------------------------------------------------------
# screening
# --------------------------------------------------------------------------
def capacity_band(footprint_ft2: float | None, parking_m2: float | None) -> str:
    """Coarse, honest bands. Never a seat count (PRD 7.4)."""
    has_fp = footprint_ft2 is not None and footprint_ft2 > 0
    has_pk = parking_m2 is not None and parking_m2 > 0
    if has_fp and footprint_ft2 >= FOOTPRINT_LIKELY_FT2 and has_pk and parking_m2 >= PARKING_LIKELY_M2:
        return "likely_200+"
    if (has_fp and footprint_ft2 >= FOOTPRINT_LIKELY_FT2) or (has_pk and parking_m2 >= PARKING_LIKELY_M2):
        return "possible"
    if has_fp and footprint_ft2 < FOOTPRINT_LIKELY_FT2 * 0.6 and not (has_pk and parking_m2 >= PARKING_LIKELY_M2):
        return "unlikely"
    return "unknown"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--center-method", default=None, help="key in data/centroids.json; default: its default_method")
    ap.add_argument("--lat", type=float, help="override the centre latitude")
    ap.add_argument("--lon", type=float, help="override the centre longitude")
    ap.add_argument("--radius-m", type=int, default=SEARCH_RADIUS_M)
    ap.add_argument("--google-places", action="store_true", help="fill OSM gaps (needs CCAC_GOOGLE_KEY)")
    args = ap.parse_args()

    cent = read_json(DATA / "centroids.json")
    if args.lat is not None and args.lon is not None:
        center = (args.lat, args.lon)
        method = "manual"
    elif cent:
        method = args.center_method or cent["default_method"]
        if method not in cent["centroids"]:
            print(f"! no centroid named {method}; have: {list(cent['centroids'])}", file=sys.stderr)
            return 2
        center = (cent["centroids"][method]["lat"], cent["centroids"][method]["lon"])
    else:
        print("! run scripts/centroid.py first, or pass --lat/--lon", file=sys.stderr)
        return 2

    print(f"Search centre: {center[0]:.4f}, {center[1]:.4f} (method: {method})")
    print(f"Radius: {args.radius_m} m ({args.radius_m/1609.344:.1f} mi)\n")

    session = requests.Session()
    limiter = RateLimiter(3.0)  # Overpass asks for gentle clients
    transformer = _projector()

    churches = overpass(
        OVERPASS_QUERY.format(radius=args.radius_m, lat=center[0], lon=center[1]),
        session, limiter, "churches",
    )
    if churches is None:
        print("\nOverpass is unreachable from this machine. Nothing was written.", file=sys.stderr)
        print("Run this script from a network that can reach overpass-api.de.", file=sys.stderr)
        return 3
    parking = overpass(
        PARKING_QUERY.format(radius=args.radius_m, lat=center[0], lon=center[1]),
        session, limiter, "parking",
    )
    if parking is None:
        # Without parking polygons every capacity band would read low, and a
        # 'possible' building would be mislabelled 'unlikely'. A wrong band is
        # worse than a missing file, so stop instead.
        print("\n! Churches were fetched but parking was not. Capacity bands would be"
              "\n  understated, so nothing was written. The church query is cached, so"
              "\n  re-running this script will only retry the parking query.", file=sys.stderr)
        return 3

    # --- parking lots, projected, with a spatial index ---------------------
    #
    # Attribution is by TRUE distance from the church to the lot's edge, not by
    # the distance to the lot's centre. A shopping-centre lot can have its
    # centre within 100 m of a church it does not belong to, and a large lot
    # sharing a boundary with a church can have its centre 300 m away. Using
    # the centre gets both cases wrong, in opposite directions, and every error
    # lands straight in the capacity band.
    from shapely.geometry import Point, Polygon
    from shapely.strtree import STRtree

    lot_polys: list[Polygon] = []
    lot_areas: list[float] = []
    for el in parking.get("elements", []):
        geom = el.get("geometry")
        if el.get("type") == "way" and geom and len(geom) >= 4:
            rings = [geom]
        elif el.get("type") == "relation":
            rings = [m["geometry"] for m in el.get("members", [])
                     if m.get("role") in ("outer", "") and m.get("geometry")
                     and len(m["geometry"]) >= 4]
        else:
            continue
        for ring in rings:
            try:
                poly = Polygon([transformer.transform(c["lon"], c["lat"]) for c in ring])
                if not poly.is_valid:
                    poly = poly.buffer(0)
                if poly.is_empty or poly.area <= 0:
                    continue
            except Exception:
                continue
            lot_polys.append(poly)
            lot_areas.append(float(poly.area))

    lot_index = STRtree(lot_polys) if lot_polys else None
    print(f"\nParking polygons with usable geometry: {len(lot_polys)}")

    # --- churches ----------------------------------------------------------
    raw = churches.get("elements", [])
    polygons = [el for el in raw if el.get("type") in ("way", "relation") and el.get("geometry")]
    candidates: dict[str, dict] = {}

    for el in raw:
        pt = element_point(el)
        if not pt:
            continue
        tags = el.get("tags") or {}
        cid = f"osm:{el['type']}/{el['id']}"
        area_m2 = element_area_m2(el, transformer)
        candidates[cid] = {
            "id": cid,
            "name": tags.get("name") or "(unnamed place of worship)",
            "denomination": tags.get("denomination") or tags.get("religion"),
            "address": " ".join(x for x in [
                tags.get("addr:housenumber"), tags.get("addr:street"),
                tags.get("addr:city"), tags.get("addr:state"), tags.get("addr:postcode"),
            ] if x) or None,
            "lat": pt[0], "lon": pt[1],
            "website": tags.get("website") or tags.get("contact:website"),
            "phone": tags.get("phone") or tags.get("contact:phone"),
            "footprint_m2": area_m2 or None,
            "osm_type": el["type"],
            "source": "osm",
            "_geometry": el.get("geometry"),
        }

    # Deduplicate: a node tagged place_of_worship sitting inside a church
    # building polygon is the same church counted twice. Keep the polygon,
    # since it is the one carrying a footprint, but inherit the node's tags
    # where the polygon has none.
    dropped = 0
    for cid in list(candidates):
        c = candidates[cid]
        if c["osm_type"] != "node":
            continue
        for poly in polygons:
            pid = f"osm:{poly['type']}/{poly['id']}"
            if pid == cid or pid not in candidates:
                continue
            ring = poly.get("geometry") or []
            if len(ring) >= 4 and point_in_ring((c["lat"], c["lon"]), ring):
                host = candidates[pid]
                for field in ("name", "denomination", "address", "website", "phone"):
                    if not host.get(field) and c.get(field):
                        host[field] = c[field]
                if host["name"].startswith("(unnamed") and not c["name"].startswith("(unnamed"):
                    host["name"] = c["name"]
                del candidates[cid]
                dropped += 1
                break

    # --- parking within 100 m, capacity band, distance ---------------------
    out = []
    for c in candidates.values():
        c.pop("_geometry", None)
        parking_m2 = 0.0
        lots_counted = 0
        if lot_index is not None:
            cx, cy = transformer.transform(c["lon"], c["lat"])
            here = Point(cx, cy)
            # Query a generous box, then filter on real edge distance.
            for idx in lot_index.query(here.buffer(PARKING_RADIUS_M)):
                if here.distance(lot_polys[idx]) <= PARKING_RADIUS_M:
                    parking_m2 += lot_areas[idx]
                    lots_counted += 1
        c["parking_lots_counted"] = lots_counted or None
        fp_ft2 = (c["footprint_m2"] / M2_PER_FT2) if c.get("footprint_m2") else None
        c["footprint_ft2"] = round(fp_ft2, 0) if fp_ft2 else None
        c["parking_m2"] = round(parking_m2, 0) if parking_m2 else None
        c["parking_spaces_est"] = int(parking_m2 // 30) if parking_m2 else None
        # A church does not own 40,000 m2 of asphalt. Past this, the lot almost
        # certainly belongs to a mall or a school sharing the block, so the
        # figure is flagged rather than fed to the capacity band as fact.
        c["parking_shared_suspect"] = 1 if parking_m2 > 20000 else None
        c["capacity_est"] = capacity_band(
            c["footprint_ft2"],
            # Do not let a suspected shopping-centre lot promote a candidate.
            None if c.get("parking_shared_suspect") else c["parking_m2"],
        )
        c["distance_mi_from_center"] = round(haversine_mi(c["lat"], c["lon"], center[0], center[1]), 2)
        c["lat"], c["lon"] = round_coord(c["lat"]), round_coord(c["lon"])
        c.pop("footprint_m2", None)
        out.append(c)

    # --- optional Google Places gap-fill -----------------------------------
    if args.google_places:
        key = os.environ.get("CCAC_GOOGLE_KEY")
        if not key:
            print("\n! --google-places set but CCAC_GOOGLE_KEY is empty; skipping.", file=sys.stderr)
        else:
            tiles = 7
            est_cost = tiles * 3 * 0.032  # Text Search (New), ~$32/1000 at time of writing
            print(f"\nGoogle Places: ~{tiles*3} requests, estimated cost ~${est_cost:.2f}. "
                  f"Proceeding because --google-places was passed.")
            added = 0
            for p in google_places(center[0], center[1], args.radius_m, key, session):
                loc = p.get("location") or {}
                lat, lon = loc.get("latitude"), loc.get("longitude")
                if lat is None:
                    continue
                dup = any(
                    haversine_mi(lat, lon, c["lat"], c["lon"]) * 1609.344 < 50
                    for c in out
                )
                if dup:
                    continue
                out.append({
                    "id": f"gplace:{p.get('id')}",
                    "name": (p.get("displayName") or {}).get("text") or "(unnamed)",
                    "denomination": None,
                    "address": p.get("formattedAddress"),
                    "lat": round_coord(lat), "lon": round_coord(lon),
                    "website": p.get("websiteUri"),
                    "phone": p.get("nationalPhoneNumber"),
                    "footprint_ft2": None, "parking_m2": None, "parking_spaces_est": None,
                    "capacity_est": "unknown",
                    "distance_mi_from_center": round(haversine_mi(lat, lon, center[0], center[1]), 2),
                    "osm_type": None, "source": "google_places",
                })
                added += 1
            print(f"  added {added} candidate(s) not already in OSM")

    out = [c for c in out if c["distance_mi_from_center"] <= args.radius_m / 1609.344 + 0.5]
    out.sort(key=lambda c: c["distance_mi_from_center"])

    bands = {}
    for c in out:
        bands[c["capacity_est"]] = bands.get(c["capacity_est"], 0) + 1
    print_table(
        "Capacity screen (ESTIMATES from footprint and parking, never seat counts)",
        [[b, bands.get(b, 0)] for b in ("likely_200+", "possible", "unlikely", "unknown")]
        + [["TOTAL", len(out)]],
        ["capacity_est", "candidates"],
    )
    print(f"Deduplicated {dropped} node(s) that sat inside a church building polygon.")
    suspect = len([c for c in out if c.get("parking_shared_suspect")])
    if suspect:
        print(f"Flagged {suspect} candidate(s) whose adjacent parking exceeds 20,000 m2 — "
              f"almost certainly a shared mall or school lot, so it does not raise their band.")
    with_fp = len([c for c in out if c.get('footprint_ft2')])
    print(f"Candidates with a building footprint: {with_fp} of {len(out)} "
          f"({with_fp/max(1,len(out))*100:.0f}%) — the rest are OSM coverage gaps, not small buildings.")

    write_json(DATA / "churches.json", {
        "center": {"lat": round_coord(center[0]), "lon": round_coord(center[1]), "method": method},
        "radius_m": args.radius_m,
        "generated": "overpass" + ("+google_places" if args.google_places else ""),
        "coverage_caveat": (
            "OpenStreetMap church coverage is incomplete and building polygons are "
            "often missing. 'unknown' means no footprint was mapped, not a small "
            "building. Use the manual-add form for anything this missed."
        ),
        "capacity_thresholds": {
            "footprint_likely_ft2": FOOTPRINT_LIKELY_FT2,
            "parking_likely_m2": PARKING_LIKELY_M2,
        },
        "candidates": out,
    })
    print("Next: scripts/seed_d1.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
