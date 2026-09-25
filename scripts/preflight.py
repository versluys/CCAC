#!/usr/bin/env python3
"""Check the machine and the data before, or after, a pipeline run.

    .venv/bin/python scripts/preflight.py

Every check here exists because something actually went wrong during the build,
not because it seemed prudent. Run it before a pipeline run to catch the setup
problems, and again afterwards to catch the staleness ones.

FAIL means a number in the dashboard will be wrong or missing.
WARN means it will be right but weaker than it could be.
"""

from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
PRIVATE = ROOT / "private"
DATA = ROOT / "data"
CACHE = ROOT / ".cache"

RESULTS: list[tuple[str, str, str, str]] = []  # level, title, detail, remedy


def ok(title, detail=""):
    RESULTS.append(("PASS", title, detail, ""))


def warn(title, detail, remedy=""):
    RESULTS.append(("WARN", title, detail, remedy))


def fail(title, detail, remedy=""):
    RESULTS.append(("FAIL", title, detail, remedy))


def age(path: pathlib.Path) -> str:
    mins = (time.time() - path.stat().st_mtime) / 60
    if mins < 90:
        return f"{mins:.0f} min ago"
    if mins < 60 * 48:
        return f"{mins/60:.0f} h ago"
    return f"{mins/1440:.0f} days ago"


def read(path: pathlib.Path):
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


# --------------------------------------------------------------------------
def check_location():
    """The commonest mistake: running from scripts/ instead of the repo root."""
    cwd = pathlib.Path.cwd().resolve()
    if cwd != ROOT:
        warn("Working directory",
             f"you are in {cwd}, the repo root is {ROOT}",
             f"cd {ROOT}   # then use .venv/bin/python scripts/<name>.py")
    else:
        ok("Working directory", str(ROOT))

    if not (ROOT / ".venv" / "bin" / "python").exists():
        fail("Virtual environment", "no .venv in the repo root",
             "python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt")
    else:
        running_venv = pathlib.Path(sys.executable).resolve()
        expected = (ROOT / ".venv" / "bin" / "python").resolve()
        if running_venv != expected:
            warn("Interpreter", f"running {sys.executable}, not the project venv",
                 ".venv/bin/python scripts/preflight.py")
        else:
            ok("Interpreter", f"project venv, Python {sys.version.split()[0]}")


def check_deps():
    missing = []
    for mod in ("pandas", "openpyxl", "requests", "shapely", "pyproj"):
        try:
            __import__(mod)
        except ImportError:
            missing.append(mod)
    if missing:
        fail("Python dependencies", f"missing: {', '.join(missing)}",
             ".venv/bin/pip install -r scripts/requirements.txt")
    else:
        ok("Python dependencies", "pandas, openpyxl, requests, shapely, pyproj")


def check_inputs():
    books = [p for p in PRIVATE.glob("*.xls*") if not p.name.startswith(("~$", "."))]
    if not books:
        fail("Donor workbook", f"no .xlsx in {PRIVATE}",
             "put the QuickBooks export in private/ (gitignored)")
    elif len(books) > 1:
        warn("Donor workbook", f"{len(books)} workbooks present, so which one is ambiguous",
             "ingest.py will stop and ask; pass --xlsx private/<name>")
    else:
        ok("Donor workbook", f"{books[0].name}, modified {age(books[0])}")

    ov = PRIVATE / "address_overrides.csv"
    if not ov.exists():
        warn("Address overrides", "none present",
             "this file is gitignored, so it does not survive a fresh clone. "
             "If the parish has confirmed any corrections, they are not being applied.")
    else:
        rows = [l for l in ov.read_text().splitlines()[1:] if l.strip() and not l.startswith("#")]
        ok("Address overrides", f"{len(rows)} correction(s) on file")

    att = PRIVATE / "attender_zips.csv"
    if not att.exists():
        warn("Attender ZIP card", "not collected",
             "without it the centre rests on the giving record alone, which leans "
             "toward longer-tenured members and under-weights recent transfers")
    else:
        rows = [l for l in att.read_text().splitlines()[1:] if l.strip()]
        ok("Attender ZIP card", f"{len(rows)} household(s)")


def check_network():
    """Which pipeline stages can run from here at all."""
    try:
        import requests
    except ImportError:
        return
    targets = [
        ("Census geocoder", "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"
                            "?address=1600+Pennsylvania+Ave+NW+Washington+DC+20500"
                            "&benchmark=Public_AR_Current&format=json", "ingest.py street-level geocoding"),
        ("Overpass", "https://overpass-api.de/api/status", "churches.py discovery"),
        ("OSRM", "https://router.project-osrm.org/route/v1/driving/"
                 "-117.37,33.93;-117.40,33.95?overview=false", "drive times and isochrones"),
        ("Map tiles", "https://tiles.openfreemap.org/styles/positron", "the basemap in the browser"),
    ]
    for name, url, what in targets:
        try:
            r = requests.get(url, timeout=20)
            if r.ok:
                ok(f"Reachable: {name}", what)
            else:
                warn(f"Reachable: {name}", f"HTTP {r.status_code} — {what} may degrade", "")
        except Exception as exc:
            fail(f"Unreachable: {name}", f"{type(exc).__name__} — {what} cannot run",
                 "run this from an ordinary network connection, off VPN")


def check_radius():
    """A cached Overpass response from a different radius is silently wrong."""
    try:
        text = (ROOT / "scripts" / "churches.py").read_text()
        m = re.search(r"SEARCH_RADIUS_M = (\d+)", text)
        radius = int(m.group(1)) if m else None
    except OSError:
        radius = None
    ch = read(DATA / "churches.json")
    if not ch or not ch.get("candidates"):
        warn("Church discovery", "churches.json holds no candidates",
             ".venv/bin/python scripts/churches.py")
        return
    stored = ch.get("radius_m")
    if radius and stored and stored != radius:
        fail("Search radius", f"churches.json was built at {stored} m, the code now says {radius} m",
             "rm -f .cache/overpass_*.json && .venv/bin/python scripts/churches.py")
    else:
        mi = (stored or 0) / 1609.344
        ok("Search radius", f"{stored} m ({mi:.0f} mi), matches the code")
    ok("Candidates discovered", f"{len(ch['candidates'])}, generated {age(DATA / 'churches.json')}")


def check_order():
    """Stage outputs must be newer than what they were derived from.

    A centroid recomputed after a discovery run means the churches were found
    around a point that has since moved, and nothing in the output says so.
    """
    seq = [
        ("households_anon.json", "ingest.py"),
        ("centroids.json", "centroid.py"),
        ("churches.json", "churches.py"),
        ("candidate_drive.json", "drive_matrix.py"),
    ]
    present = []
    for name, script in seq:
        path = DATA / name
        if not path.exists():
            continue
        # An empty placeholder has no ordering to be wrong about; whether it
        # should be populated is check_radius's business, not this one.
        payload = read(path) or {}
        if name == "churches.json" and not payload.get("candidates"):
            continue
        present.append((path, script))

    stale = False
    for (earlier, es), (later, ls) in zip(present, present[1:]):
        if later.stat().st_mtime < earlier.stat().st_mtime:
            stale = True
            fail(f"Stale: {later.name}",
                 f"older than {earlier.name}, so {ls} ran before the {es} output it depends on",
                 f".venv/bin/python scripts/{ls}")
    if stale:
        return
    if len(present) < 2:
        warn("Stage order", "too few stages have run to check the ordering", "")
    else:
        ok("Stage order", f"{len(present)} stage output(s), each newer than its input")


def check_scoring():
    """The bug that mattered most: an empty drive share zeroes the heaviest weight."""
    ch = read(DATA / "churches.json") or {}
    ex = read(DATA / "examples.json") or {}
    total = len(ch.get("candidates", [])) + len(ex.get("candidates", []))
    dm = read(DATA / "candidate_drive.json")
    if total == 0:
        return
    if not dm:
        fail("Drive routing", f"{total} candidate(s) but no candidate_drive.json",
             ".venv/bin/python scripts/drive_matrix.py"
             "   # without it every candidate scores 0 on the 35-point drive weight")
        return
    routed = len(dm.get("candidates") or {})
    if routed < total:
        fail("Drive routing", f"{routed} of {total} candidate(s) routed",
             ".venv/bin/python scripts/drive_matrix.py   # the unrouted ones rank as if nobody drives")
    else:
        src = dm.get("source")
        detail = f"{routed} candidate(s), source: {src}"
        if src == "osrm":
            ok("Drive routing", detail)
        elif src == "mixed":
            warn("Drive routing",
                 f"{detail} — {dm.get('proxy_candidates')} are straight-line estimates",
                 "re-run drive_matrix.py on a good connection before comparing candidates")
        else:
            warn("Drive routing", f"{detail} — these are NOT drive times",
                 "re-run drive_matrix.py where router.project-osrm.org is reachable")


def check_centroids():
    c = read(DATA / "centroids.json")
    if not c:
        fail("Centroids", "centroids.json missing", ".venv/bin/python scripts/centroid.py")
        return
    methods = list((c.get("centroids") or {}).keys())
    if c.get("drive_stats_source") != "osrm":
        warn("Centroids", f"drive figures are a {c.get('drive_stats_source')} estimate, not routed",
             ".venv/bin/python scripts/centroid.py   # from a machine that can reach OSRM")
    elif not any(m.startswith("drive_time") for m in methods):
        warn("Centroids", "no drive-time method present", ".venv/bin/python scripts/centroid.py")
    else:
        ok("Centroids", f"{len(methods)} methods, default {c.get('default_method')}, routed")


def check_examples():
    ex = read(DATA / "examples.json")
    if ex and ex.get("candidates"):
        warn("Fictional examples", f"{len(ex['candidates'])} present in the data",
             ".venv/bin/python scripts/make_examples.py --clear   # before the committee works the real list")
    else:
        ok("Fictional examples", "none")


def check_seed():
    seed = ROOT / "worker" / "seed.sql"
    if not seed.exists():
        fail("D1 seed", "worker/seed.sql missing",
             ".venv/bin/python scripts/seed_d1.py > worker/seed.sql")
        return
    newest = max((p.stat().st_mtime for p in DATA.glob("*.json")), default=0)
    if seed.stat().st_mtime < newest:
        fail("D1 seed", f"older than data/, so the dashboard is showing the previous run",
             ".venv/bin/python scripts/seed_d1.py > worker/seed.sql"
             " && cd worker && npm run db:schema:local && npm run db:seed:local")
    else:
        ok("D1 seed", f"generated {age(seed)}, newer than data/")

    dist = ROOT / "web" / "dist" / "index.html"
    if not dist.exists():
        fail("Web build", "web/dist is missing", "cd web && npm install && npm run build")
    else:
        src_newest = max((p.stat().st_mtime for p in (ROOT / "web" / "src").rglob("*")
                          if p.is_file()), default=0)
        if dist.stat().st_mtime < src_newest:
            warn("Web build", "older than web/src, so the browser has stale code",
                 "cd web && npm run build")
        else:
            ok("Web build", f"built {age(dist)}")


def check_privacy():
    try:
        tracked = subprocess.run(["git", "ls-files", "private/"], cwd=ROOT,
                                 capture_output=True, text=True, check=False).stdout.strip()
    except OSError:
        return
    bad = [l for l in tracked.splitlines() if l.strip() and l.strip() != "private/README.md"]
    if bad:
        fail("Privacy", f"git is tracking {len(bad)} file(s) under private/",
             f"git rm --cached {' '.join(bad)}")
    else:
        ok("Privacy", "nothing under private/ is tracked except its README")

    r = subprocess.run([sys.executable, str(ROOT / "scripts" / "check_pii.py")],
                       cwd=ROOT, capture_output=True, text=True, check=False)
    if r.returncode != 0:
        fail("PII gate", "check_pii.py reports findings",
             ".venv/bin/python scripts/check_pii.py   # read the findings")
    else:
        ok("PII gate", "data/ carries no donor PII")


def main() -> int:
    print("Christ's Chapel Site Finder — preflight\n")
    for fn in (check_location, check_deps, check_inputs, check_network, check_radius,
               check_order, check_centroids, check_scoring, check_examples,
               check_seed, check_privacy):
        try:
            fn()
        except Exception as exc:
            warn(f"Check {fn.__name__} could not run", f"{type(exc).__name__}: {exc}", "")

    width = max(len(t) for _, t, _, _ in RESULTS) + 2
    for level, title, detail, remedy in RESULTS:
        mark = {"PASS": "  ok ", "WARN": " warn", "FAIL": " FAIL"}[level]
        print(f"{mark}  {title.ljust(width)}{detail}")
        if remedy:
            for line in remedy.splitlines():
                print(f"        -> {line}")

    fails = sum(1 for l, *_ in RESULTS if l == "FAIL")
    warns = sum(1 for l, *_ in RESULTS if l == "WARN")
    print(f"\n{len(RESULTS)} checks: {len(RESULTS)-fails-warns} ok, {warns} warn, {fails} FAIL")
    if fails:
        print("\nFix the FAILs before trusting any number in the dashboard.")
    elif warns:
        print("\nNothing is broken. The warnings are places the answer is weaker than it could be.")
    else:
        print("\nAll clear.")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
