# Stage 1: the dashboard
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# Stage 2: ingest + API
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/kpi ./kpi
COPY backend/sql ./sql
COPY --from=web /web/dist ./static
EXPOSE 8000
CMD ["uvicorn", "kpi.api:app", "--host", "0.0.0.0", "--port", "8000"]
