#!/usr/bin/env python3
"""Write 15 clearly fictional example candidates, for exercising the tool.

    .venv/bin/python scripts/make_examples.py
    .venv/bin/python scripts/make_examples.py --clear

These exist so the dashboard can be demonstrated and the pipeline exercised
before, or instead of, a full discovery run.

Every name is drawn from Narnia on purpose. A realistic set of plausible
Riverside church names with real addresses would be indistinguishable from
genuine leads: someone would phone one, or put it in a vestry packet, and the
tool would have manufactured a candidate out of nothing. Fiction that announces
itself cannot do that. Each row also carries source="example" and is_example=1,
the dashboard shows a banner while any are present, and `--clear` removes them.

Coordinates are real points spread across the search area so drive times,
capacity bands and the histogram all behave as they would on live data. The
buildings they sit on are not churches and are not for lease.
"""

from __future__ import annotations

import argparse
import sys

from common import DATA, read_json, round_coord, write_json

# lat, lon, name, denomination, footprint ft2, parking m2, tenancy, listed, note
EXAMPLES = [
    (33.9533, -117.3962, "Cair Paravel Assembly", "anglican", 9400, 2600, "sole", 1,
     "Listed for lease. Largest of the examples; comfortably past the 200-seat screen."),
    (33.9214, -117.4531, "Lantern Waste Fellowship", "baptist", 7100, 1850, "either", 1,
     "Listed. Sits close to the congregation's centre of gravity."),
    (33.8891, -117.3402, "Beaversdam Community Church", "nondenominational", 6300, 1600, "shared", 0,
     "Not listed. Already hosts a Korean congregation on Sunday afternoons."),
    (34.0103, -117.4418, "Stone Table Chapel", "presbyterian", 5200, 1500, "shared", 1,
     "Listed. Footprint is marginal for 200; parking is adequate."),
    (33.9741, -117.3168, "Aslan's How Bible Church", "reformed", 8800, 2400, "sole", 0,
     "Not listed. Declining attendance reported locally; worth a conversation."),
    (33.8452, -117.5078, "Glasswater Creek Church", "methodist", 4100, 900, "shared", 0,
     "Too small on both measures. Kept in the list as a screened-out example."),
    (34.0625, -117.1893, "Anvard Fellowship Hall", "lutheran", 7600, 2100, "either", 1,
     "Listed. Further out; useful for seeing the drive-time tail."),
    (33.7802, -117.2214, "Archenland Community Chapel", "anglican", 6900, 1750, "sole", 1,
     "Listed. South of the hills, so the drive is longer than the mileage suggests."),
    (34.1071, -117.5589, "Owlwood Meeting House", "quaker", 3200, 700, "sole", 0,
     "Small and distant. Screened out, but left visible."),
    (33.9968, -117.6412, "Telmar Road Church", "pentecostal", 10200, 3100, "shared", 0,
     "Large. Parking figure is big enough to be worth checking for a shared lot."),
    (33.7315, -117.4104, "Harfang Hall", "nondenominational", 5800, 1550, "either", 0,
     "Borderline footprint. The kind of building only a visit settles."),
    (34.1402, -117.2907, "Ettinsmoor Union Church", "congregational", 6100, 1400, "unknown", 1,
     "Listed. Capacity plausible, parking short of the guideline."),
    (33.8677, -117.6835, "Charn Street Chapel", "episcopal", 7900, 2200, "sole", 1,
     "Listed. Comparable to Cair Paravel on paper, half an hour further out."),
    (33.9089, -117.2033, "Bism Valley Church", "baptist", None, 1900, "unknown", 0,
     "No footprint mapped: an example of the coverage gap, not a small building."),
    (34.0388, -117.8146, "World's End Fellowship", "nondenominational", 8400, 2500, "sole", 1,
     "Listed but at the far edge. Exists to show the over-an-hour bucket populate."),
]

M2_PER_FT2 = 0.09290304
FOOTPRINT_LIKELY_FT2 = 6000.0
PARKING_LIKELY_M2 = 1500.0


def band(fp: float | None, pk: float | None) -> str:
    has_fp, has_pk = fp is not None and fp > 0, pk is not None and pk > 0
    if has_fp and fp >= FOOTPRINT_LIKELY_FT2 and has_pk and pk >= PARKING_LIKELY_M2:
        return "likely_200+"
    if (has_fp and fp >= FOOTPRINT_LIKELY_FT2) or (has_pk and pk >= PARKING_LIKELY_M2):
        return "possible"
    if has_fp and fp < FOOTPRINT_LIKELY_FT2 * 0.6 and not (has_pk and pk >= PARKING_LIKELY_M2):
        return "unlikely"
    return "unknown"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--clear", action="store_true", help="remove the examples file")
    args = ap.parse_args()

    path = DATA / "examples.json"
    if args.clear:
        if path.exists():
            path.unlink()
            print(f"removed {path.name}")
        else:
            print("nothing to remove")
        return 0

    from common import haversine_mi

    cent = read_json(DATA / "centroids.json", {}) or {}
    default = (cent.get("centroids") or {}).get(cent.get("default_method") or "", {})
    clat, clon = default.get("lat"), default.get("lon")

    rows = []
    for lat, lon, name, denom, fp, pk, tenancy, listed, note in EXAMPLES:
        rows.append({
            "id": f"example:{name.lower().replace(' ', '-').replace(chr(39), '')}",
            "name": name,
            "denomination": denom,
            "address": None,   # deliberately absent: a fake address invites a letter
            "lat": round_coord(lat), "lon": round_coord(lon),
            "website": None, "phone": None,
            "footprint_ft2": fp,
            "parking_m2": pk,
            "parking_spaces_est": int(pk // 30) if pk else None,
            "parking_lots_counted": 1 if pk else None,
            "capacity_est": band(fp, pk),
            "tenancy_possible": tenancy,
            "listed_for_lease": listed,
            "denomination_notes": note,
            "distance_mi_from_center": (round(haversine_mi(lat, lon, clat, clon), 2)
                                        if clat is not None else None),
            "source": "example",
            "is_example": 1,
        })

    counts: dict[str, int] = {}
    for r in rows:
        counts[r["capacity_est"]] = counts.get(r["capacity_est"], 0) + 1

    write_json(path, {
        "source": "example",
        "warning": (
            "FICTIONAL. These 15 candidates are named after places in Narnia so that "
            "they cannot be mistaken for real churches. The coordinates are real points "
            "in the search area, chosen so drive times and capacity bands behave "
            "realistically; the buildings there are not churches and are not for lease. "
            "Remove them with: scripts/make_examples.py --clear"
        ),
        "candidates": rows,
    })
    print(f"\n15 fictional examples written. Capacity bands: {counts}")
    print(f"Listed for lease: {sum(r['listed_for_lease'] for r in rows)} of {len(rows)}")
    if clat is None:
        print("note: no centroid yet, so distances are blank. Re-run after centroid.py.")
    print("\nThese are clearly-labelled fiction. Clear them with --clear before the")
    print("committee works the real list.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
