#!/usr/bin/env bash

set -Eeuo pipefail

if (($# != 2)) || [[ "$2" != "--confirm-empty-target" ]]; then
    echo "Usage: ./scripts/public/restore.sh BACKUP_DIRECTORY --confirm-empty-target" >&2
    exit 2
fi

PUBLIC_SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "$PUBLIC_SCRIPT_ROOT/../.." && pwd -P)"
backup_root="$(cd "$1" && pwd -P)"

for required in SHA256SUMS database.dump media.tar.gz configuration.tar.gz manifest.txt; do
    if [[ ! -f "$backup_root/$required" ]]; then
        echo "В резервной копии отсутствует $required." >&2
        exit 1
    fi
done
(
    cd "$backup_root"
    sha256sum --check SHA256SUMS
)

tar -C "$PROJECT_ROOT" -xzf "$backup_root/configuration.tar.gz"
source "$PUBLIC_SCRIPT_ROOT/common.sh"
require_public_environment
set -a
source "$ENV_FILE"
set +a

compose_base --profile transcription stop gateway api realtime collaboration worker beat transcription
compose_base up -d postgres redis
compose_base exec -T postgres \
    psql -U "${POSTGRES_USER:-quillum}" -d "${POSTGRES_DB:-quillum}" \
    -v ON_ERROR_STOP=1 -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
compose_base exec -T postgres \
    pg_restore -U "${POSTGRES_USER:-quillum}" -d "${POSTGRES_DB:-quillum}" \
    --no-owner --no-privileges < "$backup_root/database.dump"
compose_base run --rm --no-deps --entrypoint /bin/sh init-volumes \
    -c 'find /data/media -mindepth 1 -delete \
        && tar --no-same-owner --no-same-permissions --touch -C /data/media -xzf - \
        && chown -R 10001:10001 /data/media' \
    < "$backup_root/media.tar.gz"
compose_base run --rm --no-deps init-volumes
compose_base run --rm migrate
deployment_mode="$(sed -n 's/^deployment_mode=//p' "$backup_root/manifest.txt" | tail -1)"
transcription_enabled="$(sed -n 's/^transcription_enabled=//p' "$backup_root/manifest.txt" | tail -1)"
profile=()
if [[ "$transcription_enabled" == true ]]; then
    profile=(--profile transcription)
fi
install -d "$PROJECT_ROOT/.run"
if [[ "$deployment_mode" == external ]]; then
    compose_external_proxy "${profile[@]}" up -d
    printf 'external\n' > "$PROJECT_ROOT/.run/public-deployment-mode"
else
    compose_caddy "${profile[@]}" up -d
    printf 'caddy\n' > "$PROJECT_ROOT/.run/public-deployment-mode"
fi
echo "Восстановление завершено. Проверьте состояние через ./scripts/public/status.sh."
