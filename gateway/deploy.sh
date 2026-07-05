#!/usr/bin/env bash
# Deploy the gateway to Cloud Run.
#
#   ./deploy.sh test | prod
#
# One-time per project setup (see README.md):
#   - secrets in Secret Manager: stripe-secret-key-{env}, stripe-webhook-secret-{env},
#     modal-token-id, modal-token-secret, reconcile-token-{env}, slack-webhook (optional)
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

gcloud run deploy "$SERVICE" \
  --project "$PROJECT" --region "$REGION" \
  --source . \
  --service-account "$SA" \
  --allow-unauthenticated \
  --min-instances 0 --max-instances 10 \
  --memory 512Mi --cpu 1 --timeout 120 \
  --set-env-vars "^@^APP_ENV=${ENV}@GCP_PROJECT_ID=${PROJECT}@MODAL_BASE_URL=https://${MODAL_WORKSPACE}--stereo3d-api-${ENV}.modal.run@CORS_ORIGINS=${CORS_ORIGINS}" \
  --set-secrets "STRIPE_SECRET_KEY=stripe-secret-key-${ENV}:latest,STRIPE_WEBHOOK_SECRET=stripe-webhook-secret-${ENV}:latest,STRIPE_PUBLISHABLE_KEY=stripe-publishable-key-${ENV}:latest,MODAL_TOKEN_ID=modal-token-id:latest,MODAL_TOKEN_SECRET=modal-token-secret:latest,RECONCILE_TOKEN=reconcile-token-${ENV}:latest,SLACK_WEBHOOK_URL=slack-webhook:latest"

URL=$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.url)')
echo "Deployed: $URL"
echo
echo "Reminders:"
echo "  - Stripe webhook endpoint: ${URL}/webhooks/stripe (events: payment_intent.amount_capturable_updated, payment_intent.canceled, payment_intent.payment_failed, payment_intent.succeeded)"
echo "  - Scheduler: gcloud scheduler jobs create http ${SERVICE}-reconcile --schedule='* * * * *' \\"
echo "      --uri='${URL}/internal/reconcile' --http-method=POST \\"
echo "      --headers='X-Reconcile-Token=<value of reconcile-token-${ENV}>'"
