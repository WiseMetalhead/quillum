#!/usr/bin/env bash

set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"
require_public_environment

mode=caddy
if [[ -f "$PROJECT_ROOT/.run/public-deployment-mode" ]]; then
    mode="$(<"$PROJECT_ROOT/.run/public-deployment-mode")"
fi
if [[ "$mode" == external ]]; then
    compose_external_proxy --profile transcription ps
else
    compose_caddy --profile transcription ps
fi
