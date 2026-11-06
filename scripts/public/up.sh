#!/usr/bin/env bash

set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"
require_public_environment

mode=caddy
build=false
transcription=false
for argument in "$@"; do
    case "$argument" in
        --external-proxy)
            mode=external
            ;;
        --build)
            build=true
            ;;
        --transcription)
            transcription=true
            ;;
        -h|--help)
            echo "Usage: ./scripts/public/up.sh [--external-proxy] [--build] [--transcription]"
            exit 0
            ;;
        *)
            echo "Неизвестный аргумент: $argument" >&2
            exit 2
            ;;
    esac
done

if grep -Fq 'example.org' "$ENV_FILE"; then
    echo "Замените example.org в .env.production перед production-запуском." >&2
    exit 1
fi

set -a
source "$ENV_FILE"
set +a
if [[ "${QUILLUM_OIDC_ENABLED:-false}" == true ]]; then
    for variable_name in OIDC_DISCOVERY_URL OIDC_ISSUER OIDC_CLIENT_ID; do
        if [[ -z "${!variable_name:-}" ]]; then
            echo "OIDC включён, но $variable_name не задан в .env.production." >&2
            exit 1
        fi
    done
    if [[ ! -s "$PROJECT_ROOT/.secrets/oidc_client_secret" ]]; then
        echo "OIDC включён, но .secrets/oidc_client_secret пуст." >&2
        exit 1
    fi
fi

files=(--project-directory "$PROJECT_ROOT" --env-file "$ENV_FILE" -f "$PROJECT_ROOT/compose.yaml")
if [[ "$mode" == caddy ]]; then
    files+=(-f "$PROJECT_ROOT/compose.caddy.yaml")
else
    files+=(-f "$PROJECT_ROOT/compose.external-proxy.yaml")
fi
if [[ "$build" == true ]]; then
    files+=(-f "$PROJECT_ROOT/compose.build.yaml")
fi
profiles=()
if [[ "$transcription" == true ]]; then
    profiles=(--profile transcription)
fi

docker compose "${files[@]}" "${profiles[@]}" up -d
install -d "$PROJECT_ROOT/.run"
printf '%s\n' "$mode" > "$PROJECT_ROOT/.run/public-deployment-mode"
echo "Quillum запущен. Состояние: ./scripts/public/status.sh"
