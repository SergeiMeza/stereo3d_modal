#!/usr/bin/env bash
# Break-glass for the admin console's passkeys (ADR 0135).
#
#   gateway/scripts/admin-passkeys-reset.sh <test|prod> <uid> [--dry-run]
#
# Deletes every passkey (and pending passkey challenge) of <uid> in
# admin_passkeys_{env}, and revokes all of its admin sessions by bumping
# admin_session_epochs_{env}/{uid}.epoch. The admin then signs in with
# Google again and enrols a new first passkey within 5 minutes.
#
# Local only, with your own gcloud login (Firestore access on the
# project). Prints counts only; posts a Slack alert (slack-webhook secret)
# naming the uid and who ran it. --dry-run counts without changing
# anything or alerting.
set -euo pipefail

ENV="${1:?usage: admin-passkeys-reset.sh <test|prod> <uid> [--dry-run]}"
UID_ARG="${2:?usage: admin-passkeys-reset.sh <test|prod> <uid> [--dry-run]}"
DRY="${3:-}"
[[ "$ENV" == "test" || "$ENV" == "prod" ]] || { echo "env must be test or prod" >&2; exit 2; }
[[ "$UID_ARG" =~ ^[A-Za-z0-9_-]{1,128}$ ]] || { echo "that doesn't look like a uid" >&2; exit 2; }
[[ -z "$DRY" || "$DRY" == "--dry-run" ]] || { echo "unknown option $DRY" >&2; exit 2; }

PROJECT="${GCP_PROJECT_ID:-spatial-video-studio}"
TOKEN="$(gcloud auth print-access-token)"
BASE="https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents"
WHO="$(gcloud config get-value account 2>/dev/null || echo unknown)"

fs() { # method url [body]
  curl -sS --fail-with-body -X "$1" "$2" -H "Authorization: Bearer ${TOKEN}" -H "x-goog-user-project: ${PROJECT}" \
    -H "Content-Type: application/json" ${3:+--data "$3"}
}

# names <collection>: the documents of the uid in a collection, one per line.
names() {
  local body
  body=$(python3 -I -c 'import json,sys; print(json.dumps({"structuredQuery":{"from":[{"collectionId":sys.argv[1]}],
    "where":{"fieldFilter":{"field":{"fieldPath":"uid"},"op":"EQUAL","value":{"stringValue":sys.argv[2]}}}}}))' "$1" "$UID_ARG")
  fs POST "${BASE}:runQuery" "$body" | python3 -I -c 'import json,sys
for row in json.load(sys.stdin):
    d = row.get("document")
    if d: print(d["name"])'
}

PASSKEYS="$(names "admin_passkeys_${ENV}")"
CHALLENGES="$(names "admin_passkey_challenges_${ENV}")"
NP=$(grep -c . <<<"$PASSKEYS" || true)
NC=$(grep -c . <<<"$CHALLENGES" || true)

if [[ "$DRY" == "--dry-run" ]]; then
  echo "dry run (${ENV}): ${NP} passkey(s), ${NC} pending challenge(s); nothing changed"
  exit 0
fi

for n in $PASSKEYS $CHALLENGES; do
  fs DELETE "https://firestore.googleapis.com/v1/${n}" >/dev/null
done
EPOCH_DOC="projects/${PROJECT}/databases/(default)/documents/admin_session_epochs_${ENV}/${UID_ARG}"
COMMIT=$(python3 -I -c 'import json,sys; print(json.dumps({"writes":[{"transform":{"document":sys.argv[1],"fieldTransforms":[
  {"fieldPath":"epoch","increment":{"integerValue":"1"}},{"fieldPath":"updated_at","setToServerValue":"REQUEST_TIME"}]}}]}))' "$EPOCH_DOC")
fs POST "${BASE}:commit" "$COMMIT" >/dev/null

echo "${ENV}: ${NP} passkey(s) and ${NC} pending challenge(s) deleted; sessions revoked"

HOOK="$(gcloud secrets versions access latest --secret=slack-webhook --project "$PROJECT" 2>/dev/null || true)"
if [[ -n "$HOOK" ]]; then
  MSG=$(python3 -I -c 'import json,sys; print(json.dumps({"text": ":warning: [gateway/%s] admin_passkeys_reset\nadmin passkeys of `%s` reset by %s: %s passkey(s) deleted, sessions revoked" % tuple(sys.argv[1:])}))' \
    "$ENV" "$UID_ARG" "$WHO" "$NP")
  curl -sS -o /dev/null -X POST "$HOOK" -H "Content-Type: application/json" --data "$MSG" || echo "Slack alert not sent" >&2
else
  echo "Slack alert not sent (no slack-webhook secret readable)" >&2
fi
