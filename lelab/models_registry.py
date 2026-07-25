# Copyright 2025 The HuggingFace Inc. team. All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Saved policy library for TrainMobile (Mac filesystem)."""

from __future__ import annotations

import json
import logging
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

from .utils.config import _atomic_write_text

logger = logging.getLogger(__name__)

MODELS_ROOT = Path.home() / ".cache" / "huggingface" / "lerobot" / "trainmobile_models"
REGISTRY_PATH = MODELS_ROOT / "registry.json"
ARTIFACTS_DIR = MODELS_ROOT / "artifacts"


class ModelRecord(BaseModel):
    id: str
    name: str
    policy_ref: str
    source: Literal["local", "hf", "vast", "import"] = "local"
    job_id: str | None = None
    dataset_repo_id: str | None = None
    steps: int | None = None
    thumbnail_path: str | None = None
    created_at: float = Field(default_factory=time.time)
    active: bool = False


def _ensure_dirs() -> None:
    MODELS_ROOT.mkdir(parents=True, exist_ok=True)
    ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)


def _load() -> list[ModelRecord]:
    _ensure_dirs()
    if not REGISTRY_PATH.is_file():
        return []
    try:
        raw = json.loads(REGISTRY_PATH.read_text())
        return [ModelRecord.model_validate(item) for item in raw]
    except Exception as exc:
        logger.warning("Failed to read model registry: %s", exc)
        return []


def _save(records: list[ModelRecord]) -> None:
    _ensure_dirs()
    payload = json.dumps([r.model_dump() for r in records], indent=2)
    _atomic_write_text(str(REGISTRY_PATH), payload)


def list_models() -> list[ModelRecord]:
    return _load()


def get_model(model_id: str) -> ModelRecord | None:
    for r in _load():
        if r.id == model_id:
            return r
    return None


def get_active_model() -> ModelRecord | None:
    for r in _load():
        if r.active:
            return r
    return None


def activate_model(model_id: str) -> ModelRecord:
    records = _load()
    found = None
    for r in records:
        r.active = r.id == model_id
        if r.active:
            found = r
    if found is None:
        raise KeyError(model_id)
    _save(records)
    return found


def delete_model(model_id: str) -> None:
    records = _load()
    keep: list[ModelRecord] = []
    removed: ModelRecord | None = None
    for r in records:
        if r.id == model_id:
            removed = r
        else:
            keep.append(r)
    if removed is None:
        raise KeyError(model_id)
    art = ARTIFACTS_DIR / model_id
    if art.is_dir():
        shutil.rmtree(art, ignore_errors=True)
    _save(keep)


def save_model(
    *,
    name: str,
    policy_ref: str,
    source: Literal["local", "hf", "vast", "import"] = "local",
    job_id: str | None = None,
    dataset_repo_id: str | None = None,
    steps: int | None = None,
    thumbnail_path: str | None = None,
    activate: bool = True,
) -> ModelRecord:
    """Register a checkpoint. Copies thumbnail into artifacts if provided."""
    _ensure_dirs()
    model_id = uuid.uuid4().hex[:12]
    art = ARTIFACTS_DIR / model_id
    art.mkdir(parents=True, exist_ok=True)

    stored_thumb: str | None = None
    if thumbnail_path:
        src = Path(thumbnail_path)
        if src.is_file():
            dest = art / "thumbnail.jpg"
            shutil.copy2(src, dest)
            stored_thumb = str(dest)

    # If policy_ref is a local dir, copy lightly via symlink when possible.
    policy_path = Path(policy_ref)
    stored_ref = policy_ref
    if policy_path.is_dir():
        link = art / "checkpoint"
        try:
            if link.exists() or link.is_symlink():
                link.unlink()
            link.symlink_to(policy_path.resolve())
            stored_ref = str(link)
        except OSError:
            stored_ref = str(policy_path.resolve())

    record = ModelRecord(
        id=model_id,
        name=name,
        policy_ref=stored_ref,
        source=source,
        job_id=job_id,
        dataset_repo_id=dataset_repo_id,
        steps=steps,
        thumbnail_path=stored_thumb,
        active=False,
    )
    records = _load()
    if activate:
        for r in records:
            r.active = False
        record.active = True
    records.insert(0, record)
    _save(records)
    return record


def model_public_dict(r: ModelRecord) -> dict[str, Any]:
    d = r.model_dump()
    if r.thumbnail_path:
        d["thumbnail_url"] = f"/models/{r.id}/thumbnail"
    else:
        d["thumbnail_url"] = None
    return d
