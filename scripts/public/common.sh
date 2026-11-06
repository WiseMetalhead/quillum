#!/usr/bin/env bash

set -Eeuo pipefail

PUBLIC_SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "$PUBLIC_SCRIPT_ROOT/../.." && pwd -P)"
ENV_FILE="$PROJECT_ROOT/.env.production"

require_public_environment() {
    if [[ ! -f "$ENV_FILE" ]]; then
        echo "Не найден $ENV_FILE. Сначала выполните ./scripts/public/init.sh." >&2
        exit 1
    fi
    if ! command -v docker >/dev/null 2>&1; then
        echo "Для публичного развёртывания требуется Docker с Compose v2." >&2
        exit 1
    fi
    docker compose version >/dev/null
}

compose_base() {
    docker compose \
        --project-directory "$PROJECT_ROOT" \
        --env-file "$ENV_FILE" \
        -f "$PROJECT_ROOT/compose.yaml" \
        "$@"
}

compose_caddy() {
    docker compose \
        --project-directory "$PROJECT_ROOT" \
        --env-file "$ENV_FILE" \
        -f "$PROJECT_ROOT/compose.yaml" \
        -f "$PROJECT_ROOT/compose.caddy.yaml" \
        "$@"
}

compose_external_proxy() {
    docker compose \
        --project-directory "$PROJECT_ROOT" \
        --env-file "$ENV_FILE" \
        -f "$PROJECT_ROOT/compose.yaml" \
        -f "$PROJECT_ROOT/compose.external-proxy.yaml" \
        "$@"
}
