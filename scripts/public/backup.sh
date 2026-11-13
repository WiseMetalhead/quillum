#!/usr/bin/env bash

set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"
require_public_environment
umask 077

set -a
source "$ENV_FILE"
set +a

backup_root="${1:-$PROJECT_ROOT/backups/quillum-$(date +%Y%m%d-%H%M%S)}"
install -d -m 0700 "$backup_root"
chmod 0700 "$backup_root"

mapfile -t running_services < <(
    compose_base --profile transcription ps --services --filter status=running
)

restart_services() {
    if ((${#running_services[@]} > 0)); then
        compose_base --profile transcription up -d --no-deps "${running_services[@]}" >/dev/null
    fi
}
trap restart_services EXIT

compose_base --profile transcription stop gateway api realtime collaboration worker beat transcription
compose_base exec -T postgres \
    pg_dump -U "${POSTGRES_USER:-quillum}" -d "${POSTGRES_DB:-quillum}" -Fc \
    > "$backup_root/database.dump"
compose_base run --rm --no-deps --entrypoint tar api \
    -C /data/media -czf - . > "$backup_root/media.tar.gz"
tar -C "$PROJECT_ROOT" -czf "$backup_root/configuration.tar.gz" \
    .env.production .secrets

printf 'quillum_version=%s\n' "${QUILLUM_VERSION:-1.0.1}" > "$backup_root/manifest.txt"
printf 'created_at=%s\n' "$(date --iso-8601=seconds)" >> "$backup_root/manifest.txt"
if [[ -f "$PROJECT_ROOT/.run/public-deployment-mode" ]]; then
    printf 'deployment_mode=%s\n' "$(<"$PROJECT_ROOT/.run/public-deployment-mode")" \
        >> "$backup_root/manifest.txt"
else
    printf 'deployment_mode=caddy\n' >> "$backup_root/manifest.txt"
fi
if printf '%s\n' "${running_services[@]}" | grep -Fxq transcription; then
    printf 'transcription_enabled=true\n' >> "$backup_root/manifest.txt"
else
    printf 'transcription_enabled=false\n' >> "$backup_root/manifest.txt"
fi
(
    cd "$backup_root"
    sha256sum database.dump media.tar.gz configuration.tar.gz manifest.txt > SHA256SUMS
)
chmod -R go-rwx "$backup_root"
trap - EXIT
restart_services
echo "Резервная копия создана: $backup_root"
