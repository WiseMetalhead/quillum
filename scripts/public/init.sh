#!/usr/bin/env bash

set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

umask 077
install -d -m 0700 "$PROJECT_ROOT/.secrets"

if [[ ! -f "$ENV_FILE" ]]; then
    install -m 0600 "$PROJECT_ROOT/.env.example" "$ENV_FILE"
    echo "Создан $ENV_FILE. Замените example.org на публичный домен перед запуском."
fi

generate_secret() {
    local destination="$1"
    local bytes="$2"
    if [[ ! -f "$destination" ]]; then
        openssl rand -hex "$bytes" > "$destination"
        chmod 0600 "$destination"
    fi
}

generate_secret "$PROJECT_ROOT/.secrets/django_secret_key" 48
generate_secret "$PROJECT_ROOT/.secrets/collaboration_internal_secret" 32
generate_secret "$PROJECT_ROOT/.secrets/postgres_password" 24
generate_secret "$PROJECT_ROOT/.secrets/bootstrap_admin_password" 18

if [[ ! -f "$PROJECT_ROOT/.secrets/oidc_client_secret" ]]; then
    install -m 0600 /dev/null "$PROJECT_ROOT/.secrets/oidc_client_secret"
fi

if grep -Fq 'example.org' "$ENV_FILE"; then
    echo "Установка подготовлена, но запуск заблокирован до настройки домена в .env.production."
else
    echo "Установка подготовлена. Запустите ./scripts/public/up.sh."
fi
echo "Первичный пароль администратора хранится в .secrets/bootstrap_admin_password."
