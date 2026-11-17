#!/usr/bin/env bash
# Stores Kinsburg's keys where they belong, asking for each one privately (nothing is shown or saved
# on this computer). Press Enter on an empty prompt to skip a key you don't have yet; run it again later.
#
#   bash scripts/set-secrets.sh
#
# Cloudflare (the Worker):  IG_USER_ID, IG_ACCESS_TOKEN, IG_APP_SECRET
# GitHub (the automations): CLOUDFLARE_API_TOKEN
# The Instagram token is kept only in Cloudflare: the daily Reel posts through the Worker.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=jadenchr/kinsburg

ask() { # ask NAME "where to find it" -> sets REPLY (hidden input)
  printf '\n%s\n  %s\n  Paste it and press Enter (it will not show), or just press Enter to skip: ' "$1" "$2"
  IFS= read -rs REPLY; echo
  REPLY="${REPLY#"${REPLY%%[![:space:]]*}"}"; REPLY="${REPLY%"${REPLY##*[![:space:]]}"}"
}

to_cloudflare() {
  if [ -z "$REPLY" ]; then echo "  skipped"; return; fi
  printf '%s' "$REPLY" | npx wrangler secret put "$1" >/dev/null 2>&1 && echo "  stored in Cloudflare" || echo "  FAILED to store $1 in Cloudflare"
  REPLY=
}

echo "Kinsburg keys. Values go straight to Cloudflare or GitHub."

ask IG_USER_ID "Meta app > Instagram > API setup with Instagram login > Generate access tokens: the number under @kinsburgtown."
if [ -n "$REPLY" ] && ! [[ "$REPLY" =~ ^[0-9]+$ ]]; then echo "  that doesn't look like an ID (digits only), skipped"; REPLY=; fi
to_cloudflare IG_USER_ID

ask IG_ACCESS_TOKEN "Same page: Generate token next to @kinsburgtown (a long text starting with IG)."
to_cloudflare IG_ACCESS_TOKEN

ask IG_APP_SECRET "Same page, or App settings > Basic: Instagram app secret > Show."
to_cloudflare IG_APP_SECRET

ask CLOUDFLARE_API_TOKEN "dash.cloudflare.com > My Profile > API Tokens > Create token > template 'Edit Cloudflare Workers', add permission Account > D1 > Edit."
if [ -n "$REPLY" ]; then
  printf '%s' "$REPLY" | gh secret set CLOUDFLARE_API_TOKEN -R "$REPO" && echo "  stored in GitHub" || echo "  FAILED to store in GitHub"
else echo "  skipped"; fi
REPLY=

echo
echo "Now stored:"
echo "  Cloudflare: $(npx wrangler secret list 2>/dev/null | grep -o '"name": "[A-Z_]*"' | cut -d'"' -f4 | tr '\n' ' ')"
echo "  GitHub:     $(gh secret list -R "$REPO" | cut -f1 | tr '\n' ' ')"
