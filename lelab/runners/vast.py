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

"""Vast.ai training runner for TrainMobile.

Creates a GPU instance and streams lerobot-train logs over SSH into the shared
job metrics pipeline (no W&B required).
"""

from __future__ import annotations

import json
import logging
import os
import shlex
import time
from pathlib import Path
from typing import Any

import httpx

from ..jobs import SubprocessJobRunner, TrainingMetrics
from ..train import TrainingRequest, build_training_command

logger = logging.getLogger(__name__)

VAST_API = "https://console.vast.ai/api/v0"


def _api_key() -> str:
    key = os.environ.get("VAST_API_KEY") or os.environ.get("VASTAI_API_KEY")
    if not key:
        raise RuntimeError("VAST_API_KEY is not set")
    return key.strip()


def _headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {_api_key()}"}


def search_offers(
    *,
    gpu_name: str | None = None,
    min_vram_gb: float = 16,
    limit: int = 24,
) -> list[dict[str, Any]]:
    q: dict[str, Any] = {
        "verified": {"eq": True},
        "rentable": {"eq": True},
        "cuda_max_good": {"gte": 11.8},
        "gpu_ram": {"gte": min_vram_gb * 1024},
        "order": [["dph_total", "asc"]],
        "type": "on-demand",
    }
    if gpu_name:
        q["gpu_name"] = {"eq": gpu_name}

    with httpx.Client(timeout=30.0) as client:
        r = client.get(
            f"{VAST_API}/bundles/",
            headers=_headers(),
            params={"q": json.dumps(q)},
        )
        r.raise_for_status()
        data = r.json()

    offers = data if isinstance(data, list) else data.get("offers") or data.get("bundles") or []
    out: list[dict[str, Any]] = []
    for o in offers[:limit]:
        out.append(
            {
                "id": o.get("id") or o.get("ask_id"),
                "gpu_name": o.get("gpu_name") or o.get("gpu_name_raw"),
                "num_gpus": o.get("num_gpus") or 1,
                "gpu_ram_gb": round((o.get("gpu_ram") or 0) / 1024, 1),
                "dph_total": o.get("dph_total") or o.get("dph_base"),
                "reliability": o.get("reliability2") or o.get("reliability"),
                "geolocation": o.get("geolocation") or o.get("country"),
            }
        )
    return [x for x in out if x.get("id") is not None]


def get_account_spend() -> dict[str, Any]:
    with httpx.Client(timeout=20.0) as client:
        r = client.get(f"{VAST_API}/users/current/", headers=_headers())
        r.raise_for_status()
        u = r.json()
    return {
        "credit": u.get("credit") or u.get("balance"),
        "email": u.get("email"),
    }


def destroy_instance(instance_id: int | str) -> None:
    with httpx.Client(timeout=30.0) as client:
        r = client.delete(f"{VAST_API}/instances/{instance_id}/", headers=_headers())
        if r.status_code not in (200, 204, 404):
            r.raise_for_status()


class VastJobRunner(SubprocessJobRunner):
    """Rent a Vast instance; SSH runs lerobot-train and we tail stdout locally."""

    def __init__(
        self,
        metrics: TrainingMetrics,
        log_file_path: Path,
        offer_id: int | str,
    ) -> None:
        super().__init__(metrics, log_file_path)
        self._offer_id = offer_id
        self._instance_id: int | str | None = None
        self._dph: float | None = None

    @property
    def instance_id(self) -> int | str | None:
        return self._instance_id

    @property
    def dph_total(self) -> float | None:
        return self._dph

    def start(self, job_id: str, config: TrainingRequest, output_dir: str) -> None:
        hf_token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN") or ""
        body = {
            "client_id": "me",
            "image": "huggingface/lerobot-gpu:latest",
            "env": {
                "HF_TOKEN": hf_token,
                "HUGGINGFACE_HUB_TOKEN": hf_token,
            },
            "runtype": "ssh",
            "disk": 32,
        }
        with httpx.Client(timeout=60.0) as client:
            r = client.put(
                f"{VAST_API}/asks/{self._offer_id}/",
                headers=_headers(),
                json=body,
            )
            r.raise_for_status()
            created = r.json()

        new_ids = created.get("new_contract") or created.get("instances")
        if isinstance(new_ids, list) and new_ids:
            self._instance_id = new_ids[0]
        elif isinstance(new_ids, (int, str)):
            self._instance_id = new_ids
        else:
            self._instance_id = created.get("id") or created.get("instance_id")
        if self._instance_id is None:
            raise RuntimeError(f"Vast create did not return instance id: {created}")

        ssh = self._wait_for_ssh(timeout_s=360)
        self._dph = float(ssh.get("dph_total") or 0)

        # Build train argv without HF job.target; force cuda.
        from ..jobs import JobTarget

        cmd = build_training_command(config, output_dir=output_dir, job_target=JobTarget(runner="local"))
        remote_parts: list[str] = []
        for part in cmd:
            if part.startswith("--policy.device="):
                remote_parts.append("--policy.device=cuda")
            elif part.startswith("--job.target="):
                continue
            else:
                remote_parts.append(part)
        # Default wandb off unless user enabled it
        if not any(p.startswith("--wandb.enable=") for p in remote_parts):
            remote_parts.append("--wandb.enable=false")

        remote_cmd = " ".join(shlex.quote(p) for p in remote_parts)
        remote_script = (
            "set -e; "
            f"echo TRAINMOBILE_VAST_START instance={self._instance_id} dph={self._dph}; "
            f"{remote_cmd}"
        )
        ssh_cmd = [
            "ssh",
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "UserKnownHostsFile=/dev/null",
            "-p",
            str(ssh["port"]),
            f"root@{ssh['host']}",
            remote_script,
        ]
        self._spawn(ssh_cmd, thread_name=f"vast-train-{job_id}")

    def _wait_for_ssh(self, timeout_s: float = 360) -> dict[str, Any]:
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            with httpx.Client(timeout=20.0) as client:
                r = client.get(f"{VAST_API}/instances/", headers=_headers(), params={"owner": "me"})
                r.raise_for_status()
                payload = r.json()
            instances = payload if isinstance(payload, list) else payload.get("instances") or []
            for inst in instances:
                if str(inst.get("id")) != str(self._instance_id):
                    continue
                host = inst.get("public_ipaddr") or inst.get("ssh_host")
                port = inst.get("ssh_port")
                status = str(inst.get("actual_status") or "").lower()
                if host and port and status in ("running", "success", ""):
                    return {
                        "host": host,
                        "port": port,
                        "dph_total": inst.get("dph_total") or inst.get("dph_base"),
                    }
            time.sleep(5)
        raise TimeoutError(f"Vast instance {self._instance_id} did not become SSH-ready")

    def stop(self) -> None:
        super().stop()
        if self._instance_id is not None:
            try:
                destroy_instance(self._instance_id)
            except Exception as exc:
                logger.warning("Failed to destroy Vast instance %s: %s", self._instance_id, exc)
