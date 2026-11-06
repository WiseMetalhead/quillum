# syntax=docker/dockerfile:1.7

FROM docker.io/library/node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS web-build

WORKDIR /build
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/collaboration/package.json apps/collaboration/package.json
COPY packages/editor-schema/package.json packages/editor-schema/package.json
RUN npm ci --workspace apps/web --workspace packages/editor-schema
COPY apps/web apps/web
COPY packages/editor-schema packages/editor-schema
RUN npm run web:build


FROM docker.io/library/node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS collaboration-build

WORKDIR /build
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/collaboration/package.json apps/collaboration/package.json
COPY packages/editor-schema/package.json packages/editor-schema/package.json
RUN npm ci --omit=dev --workspace apps/collaboration --workspace packages/editor-schema
COPY apps/collaboration apps/collaboration
COPY packages/editor-schema packages/editor-schema


FROM ghcr.io/astral-sh/uv:0.13.4@sha256:9f130421e930bfbdc563c00740466603f8723158e90297d07957c2294640262b AS uv-build


FROM docker.io/library/python:3.15.0-slim-bookworm@sha256:0e019bbdfb5d9874cb2389f1c2884b64aa2ac97c99960b5bc521cef978c0617d AS python-build

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /build/apps/api
COPY --from=uv-build /uv /uvx /usr/local/bin/
COPY apps/api/pyproject.toml apps/api/uv.lock ./
RUN uv sync --frozen --no-dev


FROM docker.io/library/python:3.15.0-slim-bookworm@sha256:0e019bbdfb5d9874cb2389f1c2884b64aa2ac97c99960b5bc521cef978c0617d AS runtime

ARG QUILLUM_VERSION=1.0.0
LABEL org.opencontainers.image.title="Quillum" \
      org.opencontainers.image.description="Самостоятельно размещаемая среда для работы над большими текстами" \
      org.opencontainers.image.source="https://github.com/WiseMetalhead/quillum" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.version="${QUILLUM_VERSION}"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    QUILLUM_VERSION=${QUILLUM_VERSION} \
    PATH=/app/.venv/bin:${PATH}

RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install --no-install-recommends -y \
        ca-certificates \
        curl \
        libgomp1 \
        nginx \
        tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 quillum \
    && useradd --uid 10001 --gid 10001 --home-dir /app --shell /usr/sbin/nologin quillum \
    && install -d -o quillum -g quillum \
        /app /data/media /data/models /data/beat /tmp/nginx/client-body \
        /tmp/nginx/proxy /tmp/nginx/fastcgi /tmp/nginx/uwsgi /tmp/nginx/scgi

WORKDIR /app
COPY --from=python-build /app/.venv /app/.venv
COPY --from=collaboration-build /usr/local/bin/node /usr/local/bin/node
COPY --from=collaboration-build /build/node_modules /app/node_modules
COPY --from=collaboration-build /build/apps/collaboration /app/apps/collaboration
COPY --from=collaboration-build /build/packages/editor-schema /app/packages/editor-schema
COPY apps/api /app/apps/api
COPY --from=web-build /build/apps/web/dist /app/apps/web/dist
COPY deploy /app/deploy

RUN QUILLUM_BOOTSTRAP_ADMIN_ENABLED=false \
        /app/.venv/bin/python /app/apps/api/manage.py collectstatic --noinput \
    && chown -R root:root /app \
    && chmod -R go-w /app \
    && chmod -R a+rX /app \
    && chmod +x /app/deploy/init-volumes.sh

USER 10001:10001
EXPOSE 8080 8001 8002 8003
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/.venv/bin/gunicorn", "--chdir", "/app/apps/api", "config.wsgi:application", "--bind", "0.0.0.0:8001", "--workers", "2", "--timeout", "60", "--access-logfile", "-", "--error-logfile", "-"]
