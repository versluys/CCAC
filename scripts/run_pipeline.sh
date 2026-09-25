#!/usr/bin/env bash
#
# Run the whole pipeline, from anywhere.
#
#   scripts/run_pipeline.sh                    households, centres, and the candidates on file
#   scripts/run_pipeline.sh --serve            build the web app and start the worker too
#   scripts/run_pipeline.sh --examples         include the 15 fictional example candidates
#   scripts/run_pipeline.sh --discover         ALSO sweep OpenStreetMap for every church
#   scripts/run_pipeline.sh --clear-discovered forget a previous sweep
#   scripts/run_pipeline.sh --isochrones       compute the reachable-area polygons
#   scripts/run_pipeline.sh --reset-db         recreate the local database from scratch first
#
# Discovery is off by default, deliberately. A 40-mile sweep returns about 2,500
# churches, of which a handful are available and most have no mapped building.
# That is a list nobody works. The candidates worth tracking are the ones someone
# heard about — a listing, a broker, a conversation after a service — entered by
# hand in the dashboard. Use --discover when you want the sweep as a reference,
# not as the working list.
#
# This exists because the two mistakes that actually cost time during the build
# were not logic errors. They were running from the wrong directory, and pasting
# a command line with a trailing "# comment" that argparse then rejected. A
# script that finds its own repo root and takes real flags removes both.
#
# It stops at the first failing stage rather than carrying on with stale data,
# because a pipeline that half-ran is worse than one that did not run at all:
# the dashboard still shows numbers, and they are quietly from the last attempt.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PY="$ROOT/.venv/bin/python"
DISCOVER=0
CLEAR_DISCOVERED=0
WITH_EXAMPLES=0
WITH_ISOCHRONES=0
SERVE=0
FORCE=0
RESET_DB=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --discover)       DISCOVER=1 ;;
    --clear-discovered) CLEAR_DISCOVERED=1 ;;
    --keep-discovery) echo "note: --keep-discovery is no longer needed; discovery is off by default" ;;
    --examples)       WITH_EXAMPLES=1 ;;
    --isochrones)     WITH_ISOCHRONES=1 ;;
    --serve)          SERVE=1 ;;
    --reset-db)       RESET_DB=1 ;;
    --force)          FORCE=1 ;;
    -h|--help)        sed -n '3,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\n\033[1m==== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mSTOPPED: %s\033[0m\n' "$*" >&2; exit 1; }

echo "Repository: $ROOT"

[[ -x "$PY" ]] || die "no virtual environment at .venv
  python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt"

# ---------------------------------------------------------------------------
say "Preflight"
if ! "$PY" scripts/preflight.py --stage pre; then
  if [[ $FORCE -eq 0 ]]; then
    die "preflight reported failures. Fix them, or re-run with --force to proceed anyway."
  fi
  echo "(--force given, continuing despite failures)"
fi

say "1/6  Ingest and geocode"
"$PY" scripts/ingest.py || die "ingest failed"

say "2/6  Privacy gate"
"$PY" scripts/check_pii.py || die "the PII gate found donor data in data/. Nothing further should run."

say "3/6  Centroids"
"$PY" scripts/centroid.py || die "centroid failed"

if [[ $CLEAR_DISCOVERED -eq 1 ]]; then
  say "Clearing a previous sweep"
  rm -f data/churches.json .cache/overpass_*.json
  echo "removed data/churches.json; hand-entered candidates live in the database and are untouched"
fi

say "4/6  Candidate discovery"
if [[ $DISCOVER -eq 1 ]]; then
  # The cache keys on the query text, which includes the radius, so a stale
  # response from a different radius would be silently reused.
  rm -f .cache/overpass_*.json
  "$PY" scripts/churches.py || die "church discovery failed. Overpass may have timed out; run this again — the church query caches separately from parking, so a retry only redoes what failed."
else
  echo "skipped: the sweep is off by default (--discover to run it)."
  if [[ -f data/churches.json ]]; then
    n=$("$PY" -c "import json,sys;print(len(json.load(open('data/churches.json')).get('candidates') or []))" 2>/dev/null || echo 0)
    if [[ "$n" -gt 0 ]]; then
      echo "  data/churches.json still holds $n candidate(s) from an earlier sweep, and they"
      echo "  will be seeded. Use --clear-discovered to drop them."
    fi
  fi
  echo "  Candidates you add in the dashboard live in the database and are not affected"
  echo "  by this script."
fi

if [[ $WITH_EXAMPLES -eq 1 ]]; then
  say "4a/6  Fictional examples"
  "$PY" scripts/make_examples.py
fi

say "5/6  Drive times for every candidate"
"$PY" scripts/drive_matrix.py || die "drive routing failed. Without it every candidate scores zero on the heaviest weight."

if [[ $WITH_ISOCHRONES -eq 1 ]]; then
  say "5a/6  Isochrone polygons"
  "$PY" scripts/isochrones.py || echo "isochrones failed; the map falls back to distance rings"
fi

say "6/6  Database seed"
"$PY" scripts/seed_d1.py || die "seed generation failed"

say "Preflight again"
"$PY" scripts/preflight.py --stage post || echo "(see the warnings above)"

if [[ $SERVE -eq 1 ]]; then
  say "Building and serving"
  ( cd web && npm run build )

  # schema.sql uses CREATE TABLE IF NOT EXISTS, so it cannot add a column to a
  # table that already exists. A local database made before a schema change
  # keeps the old shape and the seed then fails on the missing column. The
  # local database holds nothing that is not regenerated from seed.sql — except
  # notes, status changes and contacts somebody typed in, which is why this is
  # a flag and not automatic.
  if [[ $RESET_DB -eq 1 ]]; then
    echo
    echo "--reset-db removes the local database."
    echo
    echo "Households, centres, drive times and the examples all come back from the"
    echo "seed. What does NOT come back is anything typed into the dashboard:"
    echo "candidates added by hand, notes, contacts, status changes. Those live only"
    echo "here. Export them first if there is anything to lose:"
    echo "    http://localhost:8787/api/export.csv"
    echo
    if [[ -d worker/.wrangler/state ]]; then
      printf 'Continue? [y/N] '
      read -r reply
      case "$reply" in
        y|Y|yes|YES) rm -rf worker/.wrangler/state; echo "database removed" ;;
        *) echo "left the database alone; the seed may fail if its schema is older than schema.sql"; ;;
      esac
    fi
  fi

  ( cd worker && npm run db:schema:local && npm run db:seed:local ) || {
    echo
    echo "The seed failed. The usual cause is a local database created before a" >&2
    echo "schema change, which CREATE TABLE IF NOT EXISTS cannot alter." >&2
    echo "  scripts/run_pipeline.sh --keep-discovery --serve --reset-db" >&2
    exit 1
  }
  echo
  echo "Open http://localhost:8787"
  ( cd worker && npm run dev )
else
  cat <<'NEXT'

Next, to see it:
  cd worker && npm run db:schema:local && npm run db:seed:local
  cd ../web && npm run build
  cd ../worker && npm run dev
  # then open http://localhost:8787

Or re-run this script with --serve to do all of that.
NEXT
fi
