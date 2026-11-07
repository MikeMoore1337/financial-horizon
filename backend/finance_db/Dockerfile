FROM python:3.12-slim
WORKDIR /srv/financial-horizon
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
COPY backend/requirements-finance.txt /tmp/requirements-finance.txt
RUN pip install --disable-pip-version-check -r /tmp/requirements-finance.txt
COPY backend/finance_db /srv/financial-horizon/backend/finance_db
# Match the fixed postgres:17 runtime UID. Secret files are host-owned by this
# non-root UID and mode 0400; do not weaken their permissions to world-readable.
USER 999:999
CMD ["alembic", "-c", "backend/finance_db/alembic.ini", "upgrade", "head"]
