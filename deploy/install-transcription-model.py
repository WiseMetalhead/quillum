from __future__ import annotations

import hashlib
import os
from pathlib import Path

os.environ.setdefault("HF_HOME", "/tmp/huggingface")
os.environ.setdefault("XDG_CACHE_HOME", "/tmp/cache")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

from huggingface_hub import snapshot_download

MODEL_DIRECTORY = Path("/data/models/faster-whisper-small")
MODEL_REVISION = "536b0662742c02347bc0e980a01041f333bce120"
MODEL_SHA256 = "3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


MODEL_DIRECTORY.mkdir(parents=True, exist_ok=True)
snapshot_download(
    repo_id="Systran/faster-whisper-small",
    revision=MODEL_REVISION,
    local_dir=MODEL_DIRECTORY,
)
model_path = MODEL_DIRECTORY / "model.bin"
if sha256(model_path) != MODEL_SHA256:
    raise SystemExit("Контрольная сумма модели распознавания речи не совпадает.")
