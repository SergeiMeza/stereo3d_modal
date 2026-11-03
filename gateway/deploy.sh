#!/usr/bin/env bash
# Deploy the gateway to Cloud Run.
#
#   ./deploy.sh test | prod
#
# One-time per project setup (see README.md):
#   - secrets in Secret Manager: stripe-secret-key-{env}, stripe-webhook-secret-{env},
#     modal-token-id, modal-token-secret, reconcile-token-{env}, slack-webhook (optional),
#     RESEND_API_KEY (send-only Resend key on spatial-ai-labs.com, shared with
#     Spatial Video Studio's backend; mails China-mode password resets)
#   - service account with roles: datastore.user, storage.objectAdmin (bucket-scoped),
#     iam.serviceAccountTokenCreator (on itself), secretmanager.secretAccessor
#   - Cloud Scheduler job hitting POST /internal/reconcile every 60s
set -euo pipefail

ENV="${1:?usage: ./deploy.sh test|prod}"
[[ "$ENV" == "test" || "$ENV" == "prod" ]] || { echo "env must be test|prod"; exit 1; }

PROJECT="${GCP_PROJECT_ID:?set GCP_PROJECT_ID}"
REGION="${GCP_REGION:-us-central1}"
SERVICE="stereo3d-gateway-${ENV}"
SA="${SERVICE}@${PROJECT}.iam.gserviceaccount.com"
MODAL_WORKSPACE="${MODAL_WORKSPACE:?set MODAL_WORKSPACE (e.g. stereo-crafter-test)}"

# Browser origins allowed by the CORS middleware. Prod pins to the web
# client's domain; test stays open for localhost dev + Vercel previews.
if [[ -z "${CORS_ORIGINS:-}" ]]; then
  if [[ "$ENV" == "prod" ]]; then
    CORS_ORIGINS="https://www.stereo3d.studio,https://stereo3d.studio,https://stereo3d-studio.vercel.app"
  else
    CORS_ORIGINS="*"
  fi
fi

# Public Firebase web API key (web/src/lib/firebase.ts DEFAULT_CONFIG), for
# the /v1/auth/* routes that sign browsers in on their behalf. Not a secret:
# Firebase web keys ship in every web and mobile client.
FIREBASE_WEB_API_KEY="${FIREBASE_WEB_API_KEY:-AIzaSyCZcwCfTeRhsLjmPHXUPMEU7xNUserJESQ}"

# Lifelike 3D: the shared lifelike3d Modal service (ml-sharp-modal
# docs/LIFELIKE_API.md), same workspace as the stereo3d API. Test points at
# the test service by default; prod stays off (new projects default to
# classic) until LIFELIKE_BASE_URL is passed explicitly — the prod service
# is not deployed yet. Its proxy auth reuses the modal-token-* secrets.
if [[ -z "${LIFELIKE_BASE_URL:-}" && "$ENV" == "test" ]]; then
  LIFELIKE_BASE_URL="https://${MODAL_WORKSPACE}--lifelike3d-api-${ENV}.modal.run"
fi
LIFELIKE_BASE_URL="${LIFELIKE_BASE_URL:-off}"

gcloud run deploy "$SERVICE" \
  --project "$PROJECT" --region "$REGION" \
  --source . \
  --service-account "$SA" \
  --allow-unauthenticated \
  --min-instances 0 --max-instances 10 \
  --memory 1Gi --cpu 1 --timeout 3600 --concurrency 20 \
  --set-env-vars "^@^APP_ENV=${ENV}@GCP_PROJECT_ID=${PROJECT}@MODAL_BASE_URL=https://${MODAL_WORKSPACE}--stereo3d-api-${ENV}.modal.run@CORS_ORIGINS=${CORS_ORIGINS}@FIREBASE_WEB_API_KEY=${FIREBASE_WEB_API_KEY}@LIFELIKE_BASE_URL=${LIFELIKE_BASE_URL}" \
  --set-secrets "STRIPE_SECRET_KEY=stripe-secret-key-${ENV}:latest,STRIPE_WEBHOOK_SECRET=stripe-webhook-secret-${ENV}:latest,STRIPE_PUBLISHABLE_KEY=stripe-publishable-key-${ENV}:latest,MODAL_TOKEN_ID=modal-token-id:latest,MODAL_TOKEN_SECRET=modal-token-secret:latest,RECONCILE_TOKEN=reconcile-token-${ENV}:latest,SLACK_WEBHOOK_URL=slack-webhook:latest,RESEND_API_KEY=RESEND_API_KEY:latest"

URL=$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.url)')
echo "Deployed: $URL"
echo
echo "Reminders:"
echo "  - Stripe webhook endpoint: ${URL}/webhooks/stripe (events: payment_intent.amount_capturable_updated, payment_intent.canceled, payment_intent.payment_failed, payment_intent.succeeded)"
echo "  - Scheduler: gcloud scheduler jobs create http ${SERVICE}-reconcile --schedule='* * * * *' \\"
echo "      --uri='${URL}/internal/reconcile' --http-method=POST \\"
echo "      --headers='X-Reconcile-Token=<value of reconcile-token-${ENV}>'"
