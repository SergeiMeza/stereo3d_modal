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
# Env vars are "|"-separated below: emails contain "@".
# Owner alerts (GPU line, S3D-34; file-keeping reports, S3D-24): the address
# the KPI alerts already mail.
OWNER_ALERT_EMAIL="${OWNER_ALERT_EMAIL:-sergei@spatial-ai-labs.com}"
# File keeping (S3D-24) on test erases files and mails notices (to the
# owner's address) only for these accounts besides the owner's; other test
# projects are dry runs. Comma-separated emails; prod ignores it.
FILE_KEEPING_TEST_ACCOUNTS="${FILE_KEEPING_TEST_ACCOUNTS:-}"
# The web's own payment-method configuration "Stereo3D web" (spec v6 D2),
# created in TEST mode 2026-11-03; prod gets its own once the owner
# approves the live steps (J2). Never the account's Default.
if [[ -z "${STRIPE_PMC_WEB:-}" && "$ENV" == "test" ]]; then
  STRIPE_PMC_WEB="pmc_1UXYkVAVV5NpxADI3Vj4kzJI"
fi
STRIPE_PMC_WEB="${STRIPE_PMC_WEB:-}"

# Admin passkey sessions (ADR 0135): mounted when admin-session-key-{env}
# exists, so an env without it still deploys (passkey sessions off there).
SECRETS="STRIPE_SECRET_KEY=stripe-secret-key-${ENV}:latest,STRIPE_WEBHOOK_SECRET=stripe-webhook-secret-${ENV}:latest,STRIPE_PUBLISHABLE_KEY=stripe-publishable-key-${ENV}:latest,MODAL_TOKEN_ID=modal-token-id:latest,MODAL_TOKEN_SECRET=modal-token-secret:latest,RECONCILE_TOKEN=reconcile-token-${ENV}:latest,SLACK_WEBHOOK_URL=slack-webhook:latest,RESEND_API_KEY=RESEND_API_KEY:latest,RC_API_KEY_V1=RC_API_KEY_V1:latest"
if gcloud secrets describe "admin-session-key-${ENV}" --project "$PROJECT" >/dev/null 2>&1; then
  SECRETS="${SECRETS},ADMIN_SESSION_KEY=admin-session-key-${ENV}:latest"
fi
# RevenueCat webhook (POST /webhooks/revenuecat): the Authorization header
# set in the RevenueCat dashboard, mounted when
# revenuecat-webhook-auth-{env} exists (the route answers 503 without it).
if gcloud secrets describe "revenuecat-webhook-auth-${ENV}" --project "$PROJECT" >/dev/null 2>&1; then
  SECRETS="${SECRETS},REVENUECAT_WEBHOOK_AUTH=revenuecat-webhook-auth-${ENV}:latest"
fi
# svs-backend's proxy key (X-SVS-Proxy-Key): its X-SVS-Client-IP is
# trusted only with it; mounted when svs-gateway-proxy-key-{env} exists.
if gcloud secrets describe "svs-gateway-proxy-key-${ENV}" --project "$PROJECT" >/dev/null 2>&1; then
  SECRETS="${SECRETS},SVS_PROXY_KEY=svs-gateway-proxy-key-${ENV}:latest"
fi

# Optional pass-throughs (unset = unchanged behaviour): SVS_BACKEND_URL
# (prod: https://svs-backend-prod-151335782809.us-central1.run.app for the
# deletion hand-off; test has it as the code default), and the scaling the
# live stream needs (ADR 0143; defaults 20 and 10 as before).
EXTRA_ENV=""
if [[ -n "${SVS_BACKEND_URL:-}" ]]; then
  EXTRA_ENV="${EXTRA_ENV}|SVS_BACKEND_URL=${SVS_BACKEND_URL}"
fi
# QA agents' sign-in codes in the TEST log (owner 2026-11-07): set on the
# test deploy only. The prod deploy never sets it, and the gateway ignores
# it unless APP_ENV=test.
if [[ "$ENV" == "test" ]]; then
  EXTRA_ENV="${EXTRA_ENV}|QA_LOG_SIGNIN_CODES=1"
fi
# The revenue report's readers (GET /v1/admin/revenue/daily): service
# account emails, comma-separated; unset = nobody may read it.
if [[ -n "${KPI_OIDC_SERVICE_ACCOUNTS:-}" ]]; then
  EXTRA_ENV="${EXTRA_ENV}|KPI_OIDC_SERVICE_ACCOUNTS=${KPI_OIDC_SERVICE_ACCOUNTS}"
fi
CONCURRENCY="${CONCURRENCY:-20}"
MAX_INSTANCES="${MAX_INSTANCES:-10}"
# NO_TRAFFIC=1: deploy the revision without traffic, reachable at its tag
# URL (https://candidate---<service host>) for a smoke check; then move
# traffic with `gcloud run services update-traffic <service> --to-latest`
# (rollback: --to-revisions=<old revision>=100).
TRAFFIC_FLAGS=()
if [[ "${NO_TRAFFIC:-}" == "1" ]]; then
  TRAFFIC_FLAGS=(--no-traffic --tag candidate)
fi

gcloud run deploy "$SERVICE" \
  --project "$PROJECT" --region "$REGION" \
  --source . \
  --service-account "$SA" \
  --allow-unauthenticated \
  --min-instances 0 --max-instances "${MAX_INSTANCES}" \
  --memory 1Gi --cpu 1 --timeout 3600 --concurrency "${CONCURRENCY}" \
  --set-env-vars "^|^APP_ENV=${ENV}|GCP_PROJECT_ID=${PROJECT}|MODAL_BASE_URL=https://${MODAL_WORKSPACE}--stereo3d-api-${ENV}.modal.run|CORS_ORIGINS=${CORS_ORIGINS}|FIREBASE_WEB_API_KEY=${FIREBASE_WEB_API_KEY}|LIFELIKE_BASE_URL=${LIFELIKE_BASE_URL}|MODAL_WORKSPACE_ID=${MODAL_WORKSPACE}|OWNER_ALERT_EMAIL=${OWNER_ALERT_EMAIL}|FILE_KEEPING_TEST_ACCOUNTS=${FILE_KEEPING_TEST_ACCOUNTS}|STRIPE_PMC_WEB=${STRIPE_PMC_WEB}${EXTRA_ENV}" \
  --set-secrets "$SECRETS" \
  ${TRAFFIC_FLAGS[@]+"${TRAFFIC_FLAGS[@]}"}

URL=$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.url)')
echo "Deployed: $URL"
echo
echo "Reminders:"
echo "  - Stripe webhook endpoint: ${URL}/webhooks/stripe — 34 events (prod-readiness.md):"
echo "      payment_intent.{succeeded,payment_failed,canceled,amount_capturable_updated,processing}"
echo "      checkout.session.{completed,async_payment_succeeded,async_payment_failed,expired}"
echo "      invoice.{created,paid,payment_failed,payment_action_required,finalization_failed,overpaid}"
echo "      customer.subscription.{created,updated,deleted}"
echo "      payment_method.{detached,attached,automatically_updated}   (attached/automatically_updated: 200, ignored)"
echo "      refund.{created,updated,failed}"
echo "      charge.dispute.{created,updated,closed,funds_withdrawn,funds_reinstated}"
echo "      radar.early_fraud_warning.{created,updated}"
echo "      charge.refunded, customer.updated, mandate.updated   (200, ignored)"
echo "  - Scheduler: gcloud scheduler jobs create http ${SERVICE}-reconcile --schedule='* * * * *' \\"
echo "      --uri='${URL}/internal/reconcile' --http-method=POST \\"
echo "      --headers='X-Reconcile-Token=<value of reconcile-token-${ENV}>'"
