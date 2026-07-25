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

"""Central camera frame broker for UI preview during recording.

LeRobot's OpenCV cameras already run a background capture thread that keeps
``latest_frame`` updated. The recording control loop reads that for the
dataset via ``cam.read_latest()``.

This broker does **not** wrap or re-enter those reads (that raced the control
loop and contributed to bus timeouts when an episode started). Instead it:

1. Peeks each camera's ``latest_frame`` under its ``frame_lock`` (no I/O)
2. JPEG-encodes a downscaled copy on a dedicated thread
3. Pushes into CameraHub's relay for the phone UI

Dataset path stays exactly LeRobot's; UI is a non-invasive sidecar.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

logger = logging.getLogger(__name__)

_PREVIEW_WIDTH = 320
_PREVIEW_HEIGHT = 240
_PREVIEW_QUALITY = 40
_PREVIEW_FPS = 12.0


def _camera_device_index(cam: Any) -> int | None:
    for attr in ("index", "camera_index", "index_or_path"):
        val = getattr(cam, attr, None)
        if isinstance(val, int) and val >= 0:
            return val
    cfg = getattr(cam, "config", None)
    if cfg is not None:
        for attr in ("index_or_path", "index", "camera_index"):
            val = getattr(cfg, attr, None)
            if isinstance(val, int) and val >= 0:
                return val
    return None


def _peek_latest_frame(cam: Any) -> Any | None:
    """Non-blocking peek of OpenCVCamera.latest_frame (no TimeoutError, no USB)."""
    lock = getattr(cam, "frame_lock", None)
    if lock is None:
        return getattr(cam, "latest_frame", None)
    with lock:
        return getattr(cam, "latest_frame", None)


class FrameBroker:
    """Sidecar UI preview from cameras the recording session already owns."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._frames: dict[str, Any] = {}
        self._name_to_index: dict[str, int] = {}
        # (name, index, cam)
        self._sources: list[tuple[str, int, Any]] = []
        self._stop = threading.Event()
        self._preview_thread: threading.Thread | None = None
        self._attached = False

    @property
    def attached(self) -> bool:
        return self._attached

    @property
    def name_to_index(self) -> dict[str, int]:
        return dict(self._name_to_index)

    def latest(self, name: str) -> Any | None:
        with self._lock:
            return self._frames.get(name)

    def attach_robot(
        self,
        robot: Any,
        *,
        preview_width: int = _PREVIEW_WIDTH,
        preview_height: int = _PREVIEW_HEIGHT,
        preview_quality: int = _PREVIEW_QUALITY,
    ) -> dict[str, int]:
        from .camera_stream import camera_hub

        if self._attached:
            self.detach()

        cameras = getattr(robot, "cameras", None) or {}
        name_to_index: dict[str, int] = {}
        sources: list[tuple[str, int, Any]] = []

        for name, cam in cameras.items():
            idx = _camera_device_index(cam)
            if idx is None:
                logger.warning("FrameBroker: skip camera %r — no device index", name)
                continue
            name_to_index[name] = idx
            sources.append((name, idx, cam))

        self._name_to_index = name_to_index
        self._sources = sources

        if name_to_index:
            camera_hub.begin_relay(
                list(name_to_index.values()),
                width=preview_width,
                height=preview_height,
                quality=preview_quality,
            )
            self._stop.clear()
            self._preview_thread = threading.Thread(
                target=self._preview_loop,
                name="frame-broker-preview",
                daemon=True,
            )
            self._preview_thread.start()
            logger.info(
                "FrameBroker attached cameras %s (peek preview @ %.0f fps)",
                {n: i for n, i in name_to_index.items()},
                _PREVIEW_FPS,
            )
        else:
            logger.warning("FrameBroker: no cameras to attach")

        self._attached = True
        return name_to_index

    def detach(self) -> None:
        from .camera_stream import camera_hub

        self._stop.set()
        thread = self._preview_thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=2.0)
        self._preview_thread = None
        self._sources = []

        with self._lock:
            self._frames.clear()
            self._name_to_index.clear()

        camera_hub.end_relay()
        self._attached = False
        logger.info("FrameBroker detached")

    def _preview_loop(self) -> None:
        from .camera_stream import camera_hub

        interval = 1.0 / _PREVIEW_FPS
        while not self._stop.is_set():
            t0 = time.monotonic()
            for name, index, cam in self._sources:
                if self._stop.is_set():
                    break
                try:
                    frame = _peek_latest_frame(cam)
                except Exception:
                    continue
                if frame is None:
                    continue
                # Copy so JPEG encode can't race the camera writer thread.
                try:
                    frame = frame.copy()
                except Exception:
                    continue
                with self._lock:
                    self._frames[name] = frame
                try:
                    camera_hub.push_relay_frame(index, frame, rgb=True)
                except Exception:
                    logger.debug("FrameBroker: UI push failed for %s", name, exc_info=True)

            elapsed = time.monotonic() - t0
            self._stop.wait(timeout=max(0.0, interval - elapsed))


frame_broker = FrameBroker()
