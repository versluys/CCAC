#!/usr/bin/env bash
#
# Deploy to Cloudflare: the Worker, the database, and the built dashboard.
#
#   scripts/deploy.sh --check     what is configured and what is missing
#   scripts/deploy.sh --db        create and migrate the remote D1
#   scripts/deploy.sh --seed      push the current pipeline output to the remote D1
#   scripts/deploy.sh             build and deploy the Worker
#
# Deploying matters for more than convenience. Candidates, notes and contacts
# entered by hand live only in the database they were typed into, and a local one
# is disposable: any schema change can force it to be recreated. Once the
# committee is entering real research, it belongs in a database that persists.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/worker"

TOML="wrangler.toml"
say() { printf '\n\033[1m==== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mSTOPPED: %s\033[0m\n' "$*" >&2; exit 1; }

placeholders() {
  grep -n "REPLACE_WITH_" "$TOML" || true
}

check() {
  say "Configuration"
  local missing=0
  local left
  left="$(placeholders)"
  if [[ -n "$left" ]]; then
    missing=1
    echo "These still need real values in worker/$TOML:"
    echo "$left" | sed 's/^/  /'
  else
    echo "  ok   no placeholders left in $TOML"
  fi

  if grep -q '^ *ALLOWED_EMAIL_DOMAINS = ""' "$TOML"; then
    echo "  warn ALLOWED_EMAIL_DOMAINS is empty. The Access policy is then the only"
    echo "       thing keeping this private. Set it to the Workspace domain."
  else
    echo "  ok   ALLOWED_EMAIL_DOMAINS is set"
  fi

  if grep -qE '^ *routes = ' "$TOML"; then
    echo "  ok   a custom domain is configured"
  else
    echo "  warn no custom domain yet; the Worker will serve on workers.dev"
  fi

  if grep -q 'ENVIRONMENT = "development"' <(sed -n '/^\[vars\]/,/^\[/p' "$TOML"); then
    die "the top-level ENVIRONMENT is \"development\", which enables the dev sign-in bypass"
  else
    echo "  ok   the production environment does not enable the dev bypass"
  fi

  [[ -f ../web/dist/index.html ]] \
    && echo "  ok   web/dist exists" \
    || echo "  warn web/dist is missing; run: cd web && npm run build"

  local parts
  parts=$(ls seed/*.sql 2>/dev/null | wc -l | tr -d ' ')
  echo "  ok   $parts seed part(s) ready"

  say "Cloudflare Access, once the Worker is deployed"
  cat <<'ACCESS'
  1. Zero Trust > Settings > Authentication > Login methods: add Google Workspace.
  2. Zero Trust > Access > Applications > Add > Self-hosted.
     Domain: the Worker's hostname (custom domain, or the workers.dev one).
  3. Policy: Allow, with Include > Emails ending in @<your-domain>, and ideally
     narrowed further to a Google group such as site-committee@.
  4. Copy the application's AUD tag into CF_ACCESS_AUD, and the team domain into
     CF_ACCESS_TEAM_DOMAIN. Then redeploy.
  5. Open the app in a private window. You should be challenged by Google, and a
     non-parish account should be refused.

  The Worker verifies the token itself: signature against the team's JWKS, plus
  the audience, the issuer and the expiry. A token minted for a different Access
  application in the same account is refused, so one app cannot be used to reach
  another.
ACCESS
  return $missing
}

case "${1-}" in
  --check) check; exit $? ;;
  --db)
    check >/dev/null || die "configuration is incomplete; run --check"
    say "Creating the database (skip the error if it already exists)"
    npx wrangler d1 create ccac-sitefinder || true
    echo
    echo "Put the database_id above into worker/wrangler.toml, then re-run --db."
    grep -q 'REPLACE_WITH_YOUR_D1_DATABASE_ID' "$TOML" && exit 0
    say "Applying the schema"
    npx wrangler d1 execute ccac-sitefinder --file=schema.sql --remote
    ;;
  --seed)
    say "Seeding the remote database"
    ls seed/*.sql >/dev/null 2>&1 || die "no seed parts; run scripts/run_pipeline.sh first"
    for f in seed/*.sql; do
      echo "  $f"
      npx wrangler d1 execute ccac-sitefinder --file="$f" --remote || die "part $f failed"
    done
    echo "Seeded. Hand-entered candidates and notes already in the remote database were not touched."
    ;;
  -h|--help) sed -n '3,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  "")
    check || die "configuration is incomplete; run --check"
    say "Building the dashboard"
    ( cd ../web && npm run build )
    say "Deploying the Worker"
    npx wrangler deploy
    say "Next"
    echo "Open the Worker's URL. Without Access in front of it you will get a 403,"
    echo "which is the Worker refusing an unverified request, not a broken deploy."
    ;;
  *) die "unknown option: ${1}. Try --help" ;;
esac
