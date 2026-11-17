#!/usr/bin/env bash
# Stores Kinsburg's keys where they belong, asking for each one privately (nothing is shown or saved
# on this computer). Press Enter on an empty prompt to skip a key you don't have yet; run it again later.
#
#   bash scripts/set-secrets.sh
#
# Cloudflare (the Worker):  IG_ACCESS_TOKEN (checked with Instagram; IG_USER_ID is then filled in for you), IG_APP_SECRET
# GitHub (the automations): CLOUDFLARE_API_TOKEN
# The Instagram token is kept only in Cloudflare: the daily Reel posts through the Worker.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=jadenchr/kinsburg

ask() { # ask NAME "where to find it" -> sets REPLY (hidden input)
  printf '\n%s\n  %s\n  Paste it and press Enter (it will not show), or just press Enter to skip: ' "$1" "$2"
  printf '\033[?2004l' # turn off "bracketed paste", which wraps pasted text in invisible markers
  IFS= read -rs REPLY; echo
  # Drop those markers (ESC[200~ ... ESC[201~) and anything else invisible or whitespace.
  REPLY="${REPLY//$'\033[200~'/}"; REPLY="${REPLY//$'\033[201~'/}"
  REPLY="$(printf '%s' "$REPLY" | LC_ALL=C tr -cd '[:graph:]')"
}

admin_ig() { # POST a JSON body to the Worker's admin Instagram endpoint; prints the JSON reply
  curl -s -X POST "https://kinsburg.com/admin/ig" -H 'content-type: application/json' \
    -K <(printf 'header = "Authorization: Bearer %s"\n' "$(cat ~/.kinsburg-admin-token)") -d "$1"
}

shape() { # describe a pasted value without revealing it: length and first two characters
  printf '%d characters, starting "%s…"' "${#REPLY}" "${REPLY:0:2}"
}

to_cloudflare() {
  if [ -z "$REPLY" ]; then echo "  skipped"; return; fi
  echo "  received $(shape)"
  printf '%s' "$REPLY" | npx wrangler secret put "$1" >/dev/null 2>&1 && echo "  stored in Cloudflare" || echo "  FAILED to store $1 in Cloudflare"
  REPLY=
}

echo "Kinsburg keys. Values go straight to Cloudflare or GitHub."

ask IG_ACCESS_TOKEN "Meta app > Instagram > API setup with Instagram login > Generate access tokens > Generate token next to @kinsburgtown (a long text, usually starting with IG)."
if [ -n "$REPLY" ] && [ "${REPLY:0:2}" != IG ]; then echo "  warning: Instagram tokens normally start with IG; this one is $(shape)"; fi
to_cloudflare IG_ACCESS_TOKEN

echo "  checking the token with Instagram..."
sleep 3
WHO="$(admin_ig '{"whoami":true}')"
IGID="$(printf '%s' "$WHO" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("user_id") or "")' 2>/dev/null || true)"
if [ -n "$IGID" ]; then
  echo "  works: it belongs to @$(printf '%s' "$WHO" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("username"))')"
  printf '%s' "$IGID" | npx wrangler secret put IG_USER_ID >/dev/null 2>&1 && echo "  IG_USER_ID filled in automatically and stored in Cloudflare" || echo "  FAILED to store IG_USER_ID"
else
  echo "  The token was stored but doesn't reach @kinsburgtown yet: $(printf '%s' "$WHO" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("error") or d.get("hint") or "no Instagram account found")' 2>/dev/null)"
  echo "  (If you skipped it, that's expected. Otherwise run this script again and paste the token once more.)"
fi

ask IG_APP_SECRET "Same Instagram setup page (or App settings > Basic): Instagram app secret > Show."
to_cloudflare IG_APP_SECRET

ask CLOUDFLARE_API_TOKEN "dash.cloudflare.com > My Profile > API Tokens > Create token > template 'Edit Cloudflare Workers', add permission Account > D1 > Edit."
if [ -n "$REPLY" ]; then
  echo "  received $(shape)"
  # A token made under My Profile is a user token; one made under Manage Account is an account token.
  CHECK=
  for VERIFY in user/tokens/verify accounts/31ce91dac9bd75b1092a843484b1fe70/tokens/verify; do
    CHECK="$(curl -s "https://api.cloudflare.com/client/v4/$VERIFY" -K <(printf 'header = "Authorization: Bearer %s"\n' "$REPLY") | python3 -c 'import json,sys; d=json.load(sys.stdin); print("ok" if d.get("success") else (d.get("errors") or [{}])[0].get("message","rejected"))' 2>/dev/null || echo "no answer")"
    [ "$CHECK" = ok ] && break
  done
  if [ "$CHECK" != ok ]; then echo "  Cloudflare rejected this token ($CHECK), not stored. Create a new one and run the script again."; REPLY=; fi
fi
if [ -n "$REPLY" ]; then
  printf '%s' "$REPLY" | gh secret set CLOUDFLARE_API_TOKEN -R "$REPO" && echo "  stored in GitHub" || echo "  FAILED to store in GitHub"
else echo "  skipped"; fi
REPLY=

echo
echo "Now stored:"
echo "  Cloudflare: $(npx wrangler secret list 2>/dev/null | grep -o '"name": "[A-Z_]*"' | cut -d'"' -f4 | tr '\n' ' ')"
echo "  GitHub:     $(gh secret list -R "$REPO" | cut -f1 | tr '\n' ' ')"
