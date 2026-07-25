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
import contextlib
from pathlib import Path
from typing import Any
from collections.abc import Callable

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
    max_dph: float = 3.0,
    limit: int = 40,
) -> list[dict[str, Any]]:
    """Return rentable offers under ``max_dph`` $/hr, best ``dlperf`` first."""
    q: dict[str, Any] = {
        "verified": {"eq": True},
        "rentable": {"eq": True},
        "cuda_max_good": {"gte": 11.8},
        "gpu_ram": {"gte": min_vram_gb * 1024},
        "dph_total": {"lt": max_dph},
        "order": [["dlperf", "desc"]],
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
    for o in offers:
        dph = o.get("dph_total") if o.get("dph_total") is not None else o.get("dph_base")
        try:
            dph_f = float(dph) if dph is not None else None
        except (TypeError, ValueError):
            dph_f = None
        if dph_f is None or dph_f >= max_dph:
            continue
        dlperf = o.get("dlperf") or o.get("dlperf_per_dphtotal") or 0
        try:
            dlperf_f = float(dlperf)
        except (TypeError, ValueError):
            dlperf_f = 0.0
        out.append(
            {
                "id": o.get("id") or o.get("ask_id"),
                "gpu_name": o.get("gpu_name") or o.get("gpu_name_raw"),
                "num_gpus": o.get("num_gpus") or 1,
                "gpu_ram_gb": round((o.get("gpu_ram") or 0) / 1024, 1),
                "dph_total": dph_f,
                "dlperf": dlperf_f,
                "reliability": o.get("reliability2") or o.get("reliability"),
                "geolocation": o.get("geolocation") or o.get("country"),
            }
        )

    out = [x for x in out if x.get("id") is not None]
    out.sort(key=lambda x: (-float(x.get("dlperf") or 0), float(x.get("dph_total") or 99)))
    return out[:limit]


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


def get_instance(instance_id: int | str) -> dict[str, Any]:
    """Fetch one instance. Prefer ``GET /instances/{id}/`` (Bearer-scoped).

    Do not use ``GET /instances/?owner=me`` — that query shape returns 410 Gone.
    """
    with httpx.Client(timeout=20.0) as client:
        r = client.get(f"{VAST_API}/instances/{instance_id}/", headers=_headers())
        r.raise_for_status()
        payload = r.json()

    # show-instance returns ``{"instances": {...}}`` (object, not a list).
    inst = payload.get("instances") if isinstance(payload, dict) else None
    if isinstance(inst, dict):
        return inst
    if isinstance(inst, list):
        for item in inst:
            if isinstance(item, dict) and str(item.get("id")) == str(instance_id):
                return item
        if inst and isinstance(inst[0], dict):
            return inst[0]
    if isinstance(payload, dict) and payload.get("id") is not None:
        return payload
    raise RuntimeError(f"Unexpected Vast instance payload for {instance_id}: {payload!r}")


# Terminal statuses that will never become SSH-ready (Vast docs "poll trap").
_DEAD_STATUSES = frozenset({"exited", "unknown", "offline", "error", "failed"})


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
        # True from create until SSH train process is spawned (or start fails).
        # Keeps the registry watchdog from finalising the job mid-provision.
        self._provisioning = False
        self._on_status: Callable[[str], None] | None = None
        self._abort_code: int | None = None

    @property
    def instance_id(self) -> int | str | None:
        return self._instance_id

    @property
    def dph_total(self) -> float | None:
        return self._dph

    def set_status_callback(self, cb: Callable[[str], None] | None) -> None:
        self._on_status = cb

    def _emit_status(self, message: str) -> None:
        cb = self._on_status
        if cb is not None:
            with contextlib.suppress(Exception):
                cb(message)

    def is_running(self) -> bool:
        if self._provisioning:
            return True
        return super().is_running()

    def returncode(self) -> int | None:
        if self._process is None and self._abort_code is not None:
            return self._abort_code
        return super().returncode()

    def start(self, job_id: str, config: TrainingRequest, output_dir: str) -> None:
        self._stop_event.clear()
        self._provisioning = True
        try:
            self._start_inner(job_id, config, output_dir)
        finally:
            self._provisioning = False

    def _start_inner(self, job_id: str, config: TrainingRequest, output_dir: str) -> None:
        if self._stop_event.is_set():
            raise RuntimeError("Vast start cancelled")

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
        self._emit_status("Creating Vast instance…")
        try:
            with httpx.Client(timeout=60.0) as client:
                r = client.put(
                    f"{VAST_API}/asks/{self._offer_id}/",
                    headers=_headers(),
                    json=body,
                )
                r.raise_for_status()
                created = r.json()
        except httpx.HTTPStatusError as exc:
            detail = exc.response.text[:500]
            raise RuntimeError(
                f"Vast create instance failed ({exc.response.status_code}): {detail}"
            ) from exc

        if self._stop_event.is_set():
            raise RuntimeError("Vast start cancelled")

        new_ids = created.get("new_contract") or created.get("instances")
        if isinstance(new_ids, list) and new_ids:
            self._instance_id = new_ids[0]
        elif isinstance(new_ids, (int, str)):
            self._instance_id = new_ids
        else:
            self._instance_id = created.get("id") or created.get("instance_id")
        if self._instance_id is None:
            raise RuntimeError(f"Vast create did not return instance id: {created}")

        self._emit_status(f"Waiting for Vast SSH (instance {self._instance_id})…")
        try:
            ssh = self._wait_for_ssh(timeout_s=360)
        except Exception:
            # Avoid leaving a billed orphan if boot/SSH never came up.
            try:
                destroy_instance(self._instance_id)
            except Exception as destroy_exc:
                logger.warning(
                    "Failed to destroy Vast instance %s after boot failure: %s",
                    self._instance_id,
                    destroy_exc,
                )
            raise
        self._dph = float(ssh.get("dph_total") or 0)

        if self._stop_event.is_set():
            with contextlib.suppress(Exception):
                destroy_instance(self._instance_id)
            raise RuntimeError("Vast start cancelled")

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
        self._emit_status("Starting remote training…")
        self._spawn(ssh_cmd, thread_name=f"vast-train-{job_id}")

    def _wait_for_ssh(self, timeout_s: float = 360) -> dict[str, Any]:
        deadline = time.time() + timeout_s
        last_status = ""
        while time.time() < deadline:
            if self._stop_event.is_set():
                raise RuntimeError("Vast start cancelled")
            try:
                inst = get_instance(self._instance_id)  # type: ignore[arg-type]
            except httpx.HTTPStatusError as exc:
                raise RuntimeError(
                    f"Vast instance poll failed ({exc.response.status_code}): "
                    f"{exc.response.text[:300]}"
                ) from exc

            status_raw = inst.get("actual_status")
            status = str(status_raw).lower() if status_raw is not None else ""
            last_status = status or "null"
            if status in _DEAD_STATUSES:
                msg = inst.get("status_msg") or status
                raise RuntimeError(
                    f"Vast instance {self._instance_id} entered terminal status "
                    f"{status!r}: {msg}"
                )

            host = inst.get("public_ipaddr") or inst.get("ssh_host")
            port = inst.get("ssh_port")
            # ``running`` is the ready state; empty/null often means still provisioning.
            if host and port and status in ("running", "success"):
                return {
                    "host": host,
                    "port": port,
                    "dph_total": inst.get("dph_total") or inst.get("dph_base"),
                }
            label = last_status if last_status != "null" else "booting"
            self._emit_status(
                f"Waiting for Vast SSH (instance {self._instance_id}, {label})…"
            )
            # Interruptible sleep so Stop responds quickly during provision.
            if self._stop_event.wait(5.0):
                raise RuntimeError("Vast start cancelled")
        raise TimeoutError(
            f"Vast instance {self._instance_id} did not become SSH-ready "
            f"(last status={last_status!r})"
        )

    def stop(self) -> None:
        self._stop_event.set()
        self._provisioning = False
        if self._process is None:
            self._abort_code = 130  # interrupted before SSH train started
        super().stop()
        if self._instance_id is not None:
            try:
                destroy_instance(self._instance_id)
            except Exception as exc:
                logger.warning("Failed to destroy Vast instance %s: %s", self._instance_id, exc)
