.PHONY: env up down logs build backfill psql open data-dir backup restore

# Writes .env from the key files in ~/dev without printing anything secret: the Firestore service
# account path (the Spatial Video Studio KPI's read-only key) and, when ~/dev/s3d-kpi-vercel.env
# exists, a Vercel token that can read the stereo3d-studio project.
env:
	@test -f .env || { \
	  cp .env.example .env; \
	  sed -i '' "s|^FIRESTORE_SA_FILE=.*|FIRESTORE_SA_FILE=$$HOME/dev/svs-kpi-firestore.json|" .env; \
	  echo ".env written"; }
	@grep -q '^VERCEL_TOKEN=.' .env || { \
	  k=$$(grep '^VERCEL_TOKEN=' $$HOME/dev/s3d-kpi-vercel.env 2>/dev/null | cut -d= -f2-); \
	  if [ -n "$$k" ]; then sed -i '' "s|^VERCEL_TOKEN=.*|VERCEL_TOKEN=$$k|" .env && echo ".env: Vercel token added"; \
	  else echo "no ~/dev/s3d-kpi-vercel.env: the Website page stays empty (see README)"; fi; }

# The database lives on the external SSD (KPI_DATA_DIR, default /Volumes/Dev/Data/s3d-kpi), never
# in a Docker volume.
KPI_DATA_DIR ?= $(or $(shell grep '^KPI_DATA_DIR=' .env 2>/dev/null | cut -d= -f2-),/Volumes/Dev/Data/s3d-kpi)

data-dir:
	@test -d "$(dir $(KPI_DATA_DIR:/=))" || { echo "$(dir $(KPI_DATA_DIR:/=)) is missing: is the SSD mounted?"; exit 1; }
	@mkdir -p "$(KPI_DATA_DIR)/postgres" "$(KPI_DATA_DIR)/backups"
	@touch "$(KPI_DATA_DIR)/.metadata_never_index"

# A dump now, beside the daily ones the backup service writes.
backup:
	docker compose exec -T db pg_dump -U kpi -d kpi -Fc > "$(KPI_DATA_DIR)/backups/kpi-manual-$$(date +%Y%m%d-%H%M).dump"

# Restores the newest dump (or DUMP=path) into the running database, replacing what is there.
restore:
	@f="$${DUMP:-$$(ls -t "$(KPI_DATA_DIR)"/backups/*.dump | head -1)}"; echo "restoring $$f"; \
	docker compose stop ingest api; \
	docker compose exec -T db pg_restore -U kpi -d kpi --clean --if-exists --no-owner < "$$f"; \
	docker compose up -d ingest api

build:
	docker compose build

up: env data-dir
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f --tail=100 ingest api

# One full pass now (the loop also runs on start and every INGEST_INTERVAL_HOURS).
backfill:
	docker compose run --rm ingest python -m kpi.ingest --once

psql:
	docker compose exec db psql -U kpi -d kpi

open:
	open http://localhost:8003
