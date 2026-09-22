"""Shared helpers for the Christ's Chapel site-finder pipeline.

Privacy note (PRD R-P1/R-P2/R-P3): anything written under ``PRIVATE`` may hold
names and street addresses and is gitignored. Anything written under ``DATA``
must be anonymous and is committed. ``scripts/check_pii.py`` enforces that.
"""

from __future__ import annotations

import json
import math
import os
import pathlib
import re
import time
from typing import Iterable, Sequence

ROOT = pathlib.Path(__file__).resolve().parent.parent
PRIVATE = ROOT / "private"
DATA = ROOT / "data"
CACHE = ROOT / ".cache"

for _d in (PRIVATE, DATA, CACHE):
    _d.mkdir(exist_ok=True)

# Published coordinates are rounded to 3 decimals (~110 m) per R-P3.
COORD_PRECISION = 3

EARTH_RADIUS_MI = 3958.7613


# --------------------------------------------------------------------------
# geometry
# --------------------------------------------------------------------------
def haversine_mi(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in statute miles."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_MI * math.asin(math.sqrt(a))


def median(values: Sequence[float]) -> float:
    if not values:
        raise ValueError("median of empty sequence")
    s = sorted(values)
    mid = len(s) // 2
    if len(s) % 2:
        return s[mid]
    return (s[mid - 1] + s[mid]) / 2


def centroid_mean(points: Sequence[tuple[float, float]]) -> tuple[float, float]:
    if not points:
        raise ValueError("mean of no points")
    return (
        sum(p[0] for p in points) / len(points),
        sum(p[1] for p in points) / len(points),
    )


def geometric_median(
    points: Sequence[tuple[float, float]],
    weights: Sequence[float] | None = None,
    iters: int = 512,
    tol: float = 1e-9,
) -> tuple[float, float]:
    """Weiszfeld's algorithm on lat/lon.

    Distances are computed in a local equirectangular projection so that a
    degree of longitude is not treated as a degree of latitude. At Riverside's
    latitude that error would be ~23%, which is enough to move the answer by
    more than a mile.
    """
    if not points:
        raise ValueError("geometric median of no points")
    w = list(weights) if weights is not None else [1.0] * len(points)
    if len(w) != len(points):
        raise ValueError("weights and points differ in length")

    lat0 = median([p[0] for p in points])
    kx = math.cos(math.radians(lat0))

    def to_xy(p):
        return (p[1] * kx, p[0])

    xy = [to_xy(p) for p in points]
    cx = sum(x * wi for (x, _), wi in zip(xy, w)) / sum(w)
    cy = sum(y * wi for (_, y), wi in zip(xy, w)) / sum(w)

    for _ in range(iters):
        num_x = num_y = denom = 0.0
        coincident = 0.0
        for (x, y), wi in zip(xy, w):
            d = math.hypot(x - cx, y - cy)
            if d < 1e-12:
                coincident += wi
                continue
            num_x += wi * x / d
            num_y += wi * y / d
            denom += wi / d
        if denom == 0:
            break
        nx, ny = num_x / denom, num_y / denom
        if coincident:
            # Vardi-Zhang step: do not let a point sitting on the estimate
            # freeze the iteration.
            r = math.hypot((nx - cx) * denom, (ny - cy) * denom)
            shrink = 0.0 if r == 0 else max(0.0, 1 - coincident / r)
            nx = cx + shrink * (nx - cx)
            ny = cy + shrink * (ny - cy)
        moved = math.hypot(nx - cx, ny - cy)
        cx, cy = nx, ny
        if moved < tol:
            break

    return (cy, cx / kx)


# --------------------------------------------------------------------------
# address normalisation
# --------------------------------------------------------------------------
UNIT_RE = re.compile(
    r"(?:^|[\s,])(?:(?P<kw>apt|appt|apartment|unit|ste|suite|bldg|building|rm|room|fl|floor|trlr|lot|spc|space)\.?\s*(?P<val>[\w\-]+)"
    r"|#\s*(?P<hashval>[\w\-]+))",
    re.IGNORECASE,
)
# Some rows run the unit designator into the street suffix with no space,
# e.g. "Calinda Lnapt 123". Catch that separately so the street is not eaten.
GLUED_UNIT_RE = re.compile(r"(?<=[a-z])(?P<kw>apt|ste|unit)\.?\s*(?P<val>[\w\-]+)\s*$", re.IGNORECASE)

# Right-anchored: the only reliably placed tokens are the trailing state and
# ZIP. This export has no commas at all, so a left-to-right parse mistakes
# street numbers for ZIPs.
STATE_ZIP_RE = re.compile(r"[\s,]+(?P<state>[A-Za-z]{2})\.?[\s,]+(?P<zip>\d{5})(?:-\d{4})?\s*$")
TRAILING_ZIP_RE = re.compile(r"[\s,]+(?P<zip>\d{5})(?:-\d{4})?\s*$")
ZIP_RE = re.compile(r"\b(\d{5})(?:-\d{4})?\b")
COUNTRY_TOKENS = {"USA", "US", "U.S.A.", "U.S.", "UNITED STATES", "UNITED STATES OF AMERICA"}

_ZIP_TABLE: dict[str, dict] | None = None


def load_zip_table() -> dict[str, dict]:
    """zip -> {lat, lon, city, state} from the vendored public reference table.

    This is published geography, not donor data, so it lives in data/.
    """
    global _ZIP_TABLE
    if _ZIP_TABLE is None:
        table: dict[str, dict] = {}
        path = DATA / "zip_centroids.csv"
        if path.exists():
            import csv as _csv

            with path.open() as fh:
                for row in _csv.DictReader(fh):
                    try:
                        table[row["zip"].zfill(5)] = {
                            "lat": float(row["lat"]),
                            "lon": float(row["lon"]),
                            "city": row.get("city") or None,
                            "state": (row.get("state") or "").upper() or None,
                            "precision": row.get("precision") or "coarse",
                        }
                    except (ValueError, KeyError):
                        continue
        _ZIP_TABLE = table
    return _ZIP_TABLE


def strip_country(text: str) -> str:
    out = text
    for _ in range(2):
        stripped = out.strip(" ,.")
        for tok in sorted(COUNTRY_TOKENS, key=len, reverse=True):
            if stripped.upper().endswith(tok):
                head = stripped[: len(stripped) - len(tok)].strip(" ,.")
                if head:
                    out = head
                break
        else:
            break
    return out.strip(" ,")


def normalize_address(raw: str) -> dict:
    """Split a free-text billing address into parts.

    Parses from the right, because the donor export writes addresses as one
    unpunctuated line ("665 John Dr. Corona Ca 92880"). The trailing ZIP and
    state are the only dependable anchors; the city is then recovered by
    matching the ZIP against the public ZIP table rather than guessed from
    word position.
    """
    if raw is None:
        return {}
    text = str(raw).replace("\r", "\n").replace("\n", " ")
    text = re.sub(r"\s+", " ", text).strip(" ,")
    if not text:
        return {}

    text = strip_country(text)
    if not text:
        return {}

    city = state = zipcode = None
    m = STATE_ZIP_RE.search(text)
    if m:
        state, zipcode = m.group("state").upper(), m.group("zip")
        rest = text[: m.start()].strip(" ,")
    else:
        m = TRAILING_ZIP_RE.search(text)
        if m:
            zipcode = m.group("zip")
            rest = text[: m.start()].strip(" ,")
        else:
            rest = text

    # The ZIP table is authoritative for city/state; a mistyped state
    # abbreviation should not send a household to the wrong coast.
    table = load_zip_table()
    ref = table.get(zipcode) if zipcode else None
    if ref:
        if ref.get("state"):
            state = ref["state"]
        city = ref.get("city")

    # Strip a trailing city name off the street line when it is there.
    if city:
        pat = re.compile(r"[\s,]+" + re.escape(city) + r"\s*$", re.IGNORECASE)
        m2 = pat.search(rest)
        if m2:
            rest = rest[: m2.start()].strip(" ,")
        elif re.fullmatch(re.escape(city), rest.strip(), re.IGNORECASE):
            rest = ""

    unit = None
    m3 = GLUED_UNIT_RE.search(rest) or UNIT_RE.search(rest)
    if m3:
        unit_kw = (m3.groupdict().get("kw") or "#").strip().rstrip(".")
        unit_val = (m3.groupdict().get("val") or m3.groupdict().get("hashval") or "").strip()
        if unit_val:
            unit = f"{unit_kw.title()} {unit_val}"
            rest = (rest[: m3.start()] + " " + rest[m3.end():]).strip(" ,")
            rest = re.sub(r"\s{2,}", " ", rest)

    return {
        "street": rest or None,
        "unit": unit,
        "city": city,
        "state": state,
        "zip": zipcode,
    }


# --------------------------------------------------------------------------
# io
# --------------------------------------------------------------------------
def round_coord(v: float) -> float:
    return round(float(v), COORD_PRECISION)


def write_json(path: pathlib.Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n")
    print(f"  wrote {path.relative_to(ROOT)}")


def read_json(path: pathlib.Path, default=None):
    if not path.exists():
        return default
    return json.loads(path.read_text())


def print_table(title: str, rows: Iterable[Sequence], headers: Sequence[str]) -> None:
    rows = [[("" if c is None else str(c)) for c in r] for r in rows]
    headers = [str(h) for h in headers]
    widths = [len(h) for h in headers]
    for r in rows:
        for i, c in enumerate(r):
            widths[i] = max(widths[i], len(c))
    line = "  ".join("-" * w for w in widths)
    print(f"\n{title}")
    print("  ".join(h.ljust(w) for h, w in zip(headers, widths)))
    print(line)
    for r in rows:
        print("  ".join(c.ljust(w) for c, w in zip(r, widths)))
    print()


class RateLimiter:
    """Simple minimum-interval limiter (Nominatim: 1 request/second)."""

    def __init__(self, min_interval_s: float):
        self.min_interval_s = min_interval_s
        self._last = 0.0

    def wait(self) -> None:
        delta = time.monotonic() - self._last
        if delta < self.min_interval_s:
            time.sleep(self.min_interval_s - delta)
        self._last = time.monotonic()


USER_AGENT = os.environ.get(
    "CCAC_USER_AGENT",
    "ChristsChapelSiteFinder/1.0 (parish site search; contact: treasurer@christschapelrec.org)",
)
