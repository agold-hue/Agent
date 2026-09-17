#!/usr/bin/env bash
# One-shot Fly.io setup for Workmate. Run from the repo root after `fly auth login`:
#   scripts/setup-fly.sh <app-name> [region]
# It creates the app and its volume, asks for the secrets it needs, writes APP_URL into fly.toml,
# and deploys. Safe to re-run: existing apps, volumes and secrets are kept.
set -euo pipefail
APP="${1:-}"; REGION="${2:-ewr}"
if [ -z "$APP" ]; then echo "usage: scripts/setup-fly.sh <app-name> [region]   (e.g. scripts/setup-fly.sh acme-workmate ewr)"; exit 1; fi
command -v fly >/dev/null || { echo "flyctl is not installed: https://fly.io/docs/flyctl/install/"; exit 1; }
fly auth whoami >/dev/null 2>&1 || { echo "run: fly auth login"; exit 1; }

ask() { # ask VAR "prompt" [default] [secret]
  local var="$1" prompt="$2" def="${3:-}" secret="${4:-}" val
  if [ -n "${!var:-}" ]; then return; fi
  if [ -n "$secret" ]; then read -r -s -p "$prompt: " val; echo; else read -r -p "$prompt${def:+ [$def]}: " val; fi
  printf -v "$var" '%s' "${val:-$def}"
}

echo "== App"
fly apps list --json 2>/dev/null | grep -q "\"Name\": *\"$APP\"" || fly apps create "$APP" --org personal
sed -i.bak -e "s|^app = .*|app = \"$APP\"|" -e "s|^primary_region = .*|primary_region = \"$REGION\"|" -e "s|APP_URL = .*|APP_URL = \"https://$APP.fly.dev\"|" fly.toml && rm -f fly.toml.bak

echo "== Volume (browser profiles and files)"
fly volumes list -a "$APP" --json 2>/dev/null | grep -q '"name": *"workmate_data"' || fly volumes create workmate_data --size 10 --region "$REGION" -a "$APP" --yes

echo "== Secrets (press Enter to keep an existing value; values are not echoed)"
ask DATABASE_URL "Postgres connection string (Neon: postgres://...)" "" secret
ask ANTHROPIC_API_KEY "Anthropic API key" "" secret
ask MASTER_KEY "MASTER_KEY (Enter to generate)" "$(openssl rand -base64 32)"
ask SESSION_SECRET "SESSION_SECRET (Enter to generate)" "$(openssl rand -hex 32)"
ask SMTP_HOST "SMTP host for sign-in codes and notifications" "smtp.gmail.com"
ask SMTP_PORT "SMTP port" "587"
ask SMTP_USER "SMTP user (the sending address)" ""
ask SMTP_PASS "SMTP password / app password" "" secret
ask MAIL_FROM "From address" "$SMTP_USER"
ask DEV_LOGIN_CODE "Shared sign-in code for testing (leave empty to use email codes)" ""
SECRETS=(DATABASE_URL="$DATABASE_URL" ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" MASTER_KEY="$MASTER_KEY" SESSION_SECRET="$SESSION_SECRET" SMTP_HOST="$SMTP_HOST" SMTP_PORT="$SMTP_PORT" SMTP_USER="$SMTP_USER" SMTP_PASS="$SMTP_PASS" MAIL_FROM="$MAIL_FROM" APP_URL="https://$APP.fly.dev")
[ -n "$DEV_LOGIN_CODE" ] && SECRETS+=(DEV_LOGIN_CODE="$DEV_LOGIN_CODE")
fly secrets set -a "$APP" --stage "${SECRETS[@]}"

echo "== Deploy"
fly deploy -a "$APP" --ha=false
echo
echo "Done. Open https://$APP.fly.dev and sign in. Logs: fly logs -a $APP"
echo "Commit the updated fly.toml so future deploys use the same app: git add fly.toml && git commit -m 'Fly app name' && git push"
