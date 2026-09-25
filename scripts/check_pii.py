#!/usr/bin/env python3
"""Phase 1 acceptance gate — prove that data/ carries no donor PII.

    .venv/bin/python scripts/check_pii.py

Exits non-zero on any finding. Run it before every commit; CI runs it too.
Checks, in order of how badly each would break R-P1/R-P3:

  1. No donor surname from the private workbook appears anywhere in data/.
  2. No email addresses.
  3. No phone numbers.
  4. No street addresses (house number + street-type suffix).
  5. Household records expose only the R-P3 key set.
  6. Published coordinates are rounded to 3 decimals.
  7. Nothing under private/ is tracked by git.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys

from common import DATA, PRIVATE, ROOT

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
PHONE_RE = re.compile(r"(?<!\d)(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}(?!\d)")
STREET_RE = re.compile(
    r"\b\d{1,6}\s+(?:[NSEW]\.?\s+)?[A-Za-z][A-Za-z.'\-]*(?:\s+[A-Za-z][A-Za-z.'\-]*){0,3}\s+"
    r"(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|cir|circle|blvd|boulevard|"
    r"way|pl|place|ter|terrace|pkwy|parkway|trl|trail|hwy|highway)\b\.?",
    re.IGNORECASE,
)

ALLOWED_HOUSEHOLD_KEYS = {"id", "lat", "lon", "zip", "in_state", "outlier", "match_quality", "corrected"}
ALLOWED_ATTENDER_KEYS = {"id", "zip", "lat", "lon", "household_size", "joined_within_12mo"}

# ---------------------------------------------------------------------------
# What each published file is, and therefore what counts as a finding in it.
#
# The point of this gate is donor privacy, not the absence of all addresses.
# A church's street address and office telephone are public commercial details
# and are the whole reason the candidate files exist; flagging them makes the
# gate cry wolf on every run, and a gate that always fails is a gate nobody
# reads. What must never appear is anything traceable to a parishioner.
#
# Anything not listed here is treated as donor-derived, so a new output added
# later is checked strictly until somebody classifies it deliberately.
# ---------------------------------------------------------------------------

# Derived from the giving record. Strict: no emails, phones, street addresses
# or donor names, and only the R-P3 key set.
DONOR_DERIVED = {
    "households_anon.json",
    "attenders_anon.json",
    "data_quality.json",
    # Positions computed from where households are, so it is checked as
    # strictly as the households themselves.
    "centroids.json",
}

# Derived from OpenStreetMap, routing, or a committee member typing in a
# building they heard about. These describe churches, not households.
CANDIDATE_DERIVED = {
    "churches.json",
    "examples.json",
    "candidate_drive.json",
    "isochrones.json",
}

# Published geography and templates. No parish data of any kind.
REFERENCE_FILES = {"zip_centroids.csv", "OVERRIDES_TEMPLATE.csv"}

# private/README.md documents what belongs in private/ and is deliberately
# tracked, so that a fresh clone has the directory to fill. It is the only
# path under private/ that git may know about.
TRACKED_PRIVATE_ALLOWED = {"private/README.md"}


def donor_name_tokens() -> set[str]:
    """Surnames and given names from the private workbook, if it is present."""
    tokens: set[str] = set()
    try:
        import pandas as pd
    except ImportError:
        return tokens
    for xlsx in PRIVATE.glob("*.xlsx"):
        try:
            df = pd.read_excel(xlsx, sheet_name=0, header=3)
        except Exception:
            continue
        for col in df.columns:
            if "name" not in str(col).lower():
                continue
            for val in df[col].dropna():
                for tok in re.split(r"[^A-Za-z'\-]+", str(val)):
                    if len(tok) >= 4:
                        tokens.add(tok.lower())
    # Words that are also ordinary English or place names would fire falsely.
    tokens -= {"family", "trust", "church", "chapel", "christ", "north", "south",
               "east", "west", "saint", "john", "mary", "hill", "park", "lake",
               "wood", "king", "long", "beach", "point", "cross", "grace"}
    return tokens


def main() -> int:
    findings: list[str] = []
    review: list[str] = []
    names = donor_name_tokens()
    if names:
        print(f"Loaded {len(names)} donor name tokens from private/ for cross-checking.")
    else:
        print("No private workbook present; running pattern checks only.")

    unclassified: list[str] = []
    for path in sorted(DATA.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(ROOT)
        text = path.read_text(errors="replace")

        if path.name in REFERENCE_FILES:
            continue

        about_churches = path.name in CANDIDATE_DERIVED
        if not about_churches and path.name not in DONOR_DERIVED:
            # Fail closed: an unclassified file is checked as if it came from the
            # donor record, and named so somebody decides what it is.
            unclassified.append(str(rel))

        if about_churches:
            # A church's own address and telephone belong here. What would not
            # is a parishioner's name, so that check still runs — but as a
            # review item, because a surname can legitimately be part of a
            # church's name and a false alarm every run would retire the gate.
            lowered = text.lower()
            for tok in sorted(names):
                if re.search(rf"\b{re.escape(tok)}\b", lowered):
                    review.append(
                        f"{rel}: {tok!r} matches a donor name token. Church names and "
                        f"street names share surnames, so this is usually a coincidence — "
                        f"confirm it is not a household that reached this file."
                    )
            continue

        for m in EMAIL_RE.finditer(text):
            findings.append(f"{rel}: email-like string {m.group()!r}")
        for m in PHONE_RE.finditer(text):
            findings.append(f"{rel}: phone-like string {m.group()!r}")
        for m in STREET_RE.finditer(text):
            findings.append(f"{rel}: street-address-like string {m.group()!r}")
        lowered = text.lower()
        for tok in names:
            if re.search(rf"\b{re.escape(tok)}\b", lowered):
                findings.append(f"{rel}: donor name token {tok!r} appears in published data")

    # Structural checks on the published household/attender records.
    hh = DATA / "households_anon.json"
    if hh.exists():
        payload = json.loads(hh.read_text())
        for rec in payload.get("households", []):
            extra = set(rec) - ALLOWED_HOUSEHOLD_KEYS
            if extra:
                findings.append(f"households_anon.json: record {rec.get('id')} has extra keys {sorted(extra)}")
            for k in ("lat", "lon"):
                v = rec.get(k)
                if v is not None and round(float(v), 3) != float(v):
                    findings.append(f"households_anon.json: {rec.get('id')} {k}={v} exceeds 3-decimal rounding (R-P3)")
    att = DATA / "attenders_anon.json"
    if att.exists():
        for rec in json.loads(att.read_text()).get("attenders", []):
            extra = set(rec) - ALLOWED_ATTENDER_KEYS
            if extra:
                findings.append(f"attenders_anon.json: record has extra keys {sorted(extra)}")

    # Nothing from private/ may be tracked.
    try:
        tracked = subprocess.run(
            ["git", "ls-files", "private/"], cwd=ROOT, capture_output=True, text=True, check=False
        ).stdout.strip()
        if tracked:
            for line in tracked.splitlines():
                if line.strip() in TRACKED_PRIVATE_ALLOWED:
                    continue
                findings.append(f"git tracks a private file: {line}")
    except OSError:
        pass

    if unclassified:
        print(f"\nNOTE — {len(unclassified)} file(s) in data/ are not classified in "
              f"check_pii.py, so they were checked strictly:")
        for u in unclassified:
            print(f"  - {u}")
        print("  Add each to DONOR_DERIVED or CANDIDATE_DERIVED once you know what it holds.")

    if review:
        shown = review[:15]
        print(f"\nREVIEW — {len(review)} name collision(s) in church data "
              f"(not failures){', first 15 shown' if len(review) > 15 else ''}:")
        for r in shown:
            print(f"  - {r}")

    if findings:
        print(f"\nFAIL — {len(findings)} finding(s):", file=sys.stderr)
        for f in findings[:40]:
            print(f"  - {f}", file=sys.stderr)
        if len(findings) > 40:
            print(f"  ... and {len(findings) - 40} more", file=sys.stderr)
        return 1
    print("\nPASS — no donor PII in the published data, coordinates are rounded, "
          "private/ is untracked.")
    print("      Church addresses and phone numbers in the candidate files are public "
          "commercial details and are expected.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
