# Hosted mode. The local serve.py is not what runs here -- see the CMD.

# ---------------------------------------------------------------- front end --
# The dashboard and the auth screens are one React app now, so the image has to
# build it. dist/ is gitignored, and building here rather than copying a local
# build keeps the image reproducible from a clean checkout.
FROM node:22-slim AS web

WORKDIR /build

# Lockfile first: this layer stays cached until the dependencies change.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig*.json vite.config.ts index.html ./
COPY src/ ./src/
RUN npm run build

# ------------------------------------------------------------------ runtime --
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv/app

# Created before the COPYs so --chown has someone to point at.
RUN groupadd --system app && useradd --system --gid app --uid 10001 --home /srv/app app

# Dependencies first: this layer stays cached until requirements.txt changes.
# argon2-cffi, cryptography and openpyxl all ship manylinux wheels, so slim
# needs no compiler. If a future pin lacks one, add a builder stage rather than
# putting gcc in the runtime image.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --chown=app:app ppcbudget/ ./ppcbudget/
COPY --chown=app:app app/ ./app/
COPY --chown=app:app web/ ./web/
COPY --chown=app:app tests/ ./tests/
# Carried along only so `docker compose exec app python run_report.py` works for
# debugging. serve.py is never the container's entrypoint, so its localhost bind
# and its webbrowser.open are unreachable here.
COPY --chown=app:app run_report.py serve.py ./

# The built SPA. app/routers/pages.py serves index.html from here for every
# client route, and /assets is mounted from dist/assets.
COPY --from=web --chown=app:app /build/dist/ ./dist/

# Scratch space for per-user uploads, writable by the non-root user.
RUN mkdir -p /srv/work && chown app:app /srv/work
ENV WORKSPACE_ROOT=/srv/work

USER app
EXPOSE 8000

# No curl in the image: the interpreter is already here and is one fewer thing
# to patch. /healthz deliberately does not touch MySQL -- see app/routers/pages.py.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3).status == 200 else 1)"]

# One worker is load-bearing: uploads and the last analysis live in this
# process's memory, so a second worker would answer half the requests without
# them. Add --proxy-headers --forwarded-allow-ips=<proxy ip> only once a trusted
# proxy is in front; with the port exposed directly, it would let a client spoof
# X-Forwarded-For and walk past the per-IP rate limits.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
