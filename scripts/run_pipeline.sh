#!/usr/bin/env bash
#
# Run the whole pipeline, from anywhere.
#
#   scripts/run_pipeline.sh                  full run
#   scripts/run_pipeline.sh --keep-discovery reuse the cached Overpass results
#   scripts/run_pipeline.sh --examples       add the 15 fictional examples
#   scripts/run_pipeline.sh --isochrones     also compute the reachable-area polygons
#   scripts/run_pipeline.sh --serve          build the web app and start the worker at the end
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
KEEP_DISCOVERY=0
WITH_EXAMPLES=0
WITH_ISOCHRONES=0
SERVE=0
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep-discovery) KEEP_DISCOVERY=1 ;;
    --examples)       WITH_EXAMPLES=1 ;;
    --isochrones)     WITH_ISOCHRONES=1 ;;
    --serve)          SERVE=1 ;;
    --force)          FORCE=1 ;;
    -h|--help)        sed -n '3,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

say "4/6  Church discovery"
if [[ $KEEP_DISCOVERY -eq 1 ]]; then
  echo "reusing the cached Overpass results (--keep-discovery)"
else
  # The cache keys on the query text, which includes the radius, so a stale
  # response from a different radius would be silently reused.
  rm -f .cache/overpass_*.json
fi
"$PY" scripts/churches.py || die "church discovery failed. Overpass may have timed out; run this again — the church query caches separately from parking, so a retry only redoes what failed."

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
"$PY" scripts/seed_d1.py > worker/seed.sql || die "seed generation failed"
wc -l < worker/seed.sql | xargs printf 'worker/seed.sql: %s statements\n'

say "Preflight again"
"$PY" scripts/preflight.py --stage post || echo "(see the warnings above)"

if [[ $SERVE -eq 1 ]]; then
  say "Building and serving"
  ( cd web && npm run build )
  ( cd worker && npm run db:schema:local && npm run db:seed:local )
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
