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

"""Recording-session camera preview broker.

LeRobot owns the USB cameras. Its OpenCV capture threads keep ``latest_frame``
updated. This broker:

1. Peeks those buffers on a fixed cadence (no ``read_latest``, no wrapping)
2. JPEG-encodes a small preview copy
3. Stores name-keyed packets for ``/ws/recording-preview/{name}``

Teleop / calibration keep using ``CameraHub`` OpenCV workers. Recording UI
must use this broker — never ``/ws/cameras/{index}`` — so it cannot pin a
dead OpenCV worker across ``begin_relay`` / device handoff.
"""

from __future__ import annotations

import logging
import struct
import threading
import time
from typing import Any

logger = logging.getLogger(__name__)

_PREVIEW_WIDTH = 320
_PREVIEW_HEIGHT = 240
_PREVIEW_QUALITY = 40
_PREVIEW_FPS = 12.0
_WS_AGE_STRUCT = struct.Struct(">I")


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
    lock = getattr(cam, "frame_lock", None)
    if lock is None:
        return getattr(cam, "latest_frame", None)
    with lock:
        return getattr(cam, "latest_frame", None)


class _NamedSlot:
    """Latest JPEG for one named camera (UI consumers wait on this)."""

    def __init__(self, name: str, index: int) -> None:
        self.name = name
        self.index = index
        self._cond = threading.Condition()
        self._jpeg: bytes | None = None
        self._captured_at: float | None = None
        self._seq = 0

    def publish(self, jpeg: bytes) -> None:
        now = time.monotonic()
        with self._cond:
            self._jpeg = jpeg
            self._captured_at = now
            self._seq += 1
            self._cond.notify_all()

    def wait_next(self, after_seq: int, timeout: float) -> tuple[bytes | None, int, int]:
        deadline = time.monotonic() + timeout
        with self._cond:
            while self._seq <= after_seq:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._cond.wait(timeout=remaining)
            age_ms = 0
            if self._jpeg is not None and self._captured_at is not None:
                age_ms = max(0, int((time.monotonic() - self._captured_at) * 1000))
            return self._jpeg, self._seq, age_ms

    def latest(self) -> tuple[bytes | None, int, int]:
        with self._cond:
            age_ms = 0
            if self._jpeg is not None and self._captured_at is not None:
                age_ms = max(0, int((time.monotonic() - self._captured_at) * 1000))
            return self._jpeg, self._seq, age_ms


class FrameBroker:
    """Sidecar UI preview for an active recording session."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._slots: dict[str, _NamedSlot] = {}
        self._sources: list[tuple[str, int, Any]] = []
        self._stop = threading.Event()
        self._preview_thread: threading.Thread | None = None
        self._attached = False
        self._encode_params: list[int] | None = None
        self._width = _PREVIEW_WIDTH
        self._height = _PREVIEW_HEIGHT
        self._quality = _PREVIEW_QUALITY

    @property
    def attached(self) -> bool:
        return self._attached

    @property
    def camera_names(self) -> list[str]:
        with self._lock:
            return list(self._slots.keys())

    def attach_robot(
        self,
        robot: Any,
        *,
        preview_width: int = _PREVIEW_WIDTH,
        preview_height: int = _PREVIEW_HEIGHT,
        preview_quality: int = _PREVIEW_QUALITY,
    ) -> dict[str, int]:
        if self._attached:
            self.detach()

        self._width = preview_width
        self._height = preview_height
        self._quality = max(20, min(int(preview_quality), 85))

        cameras = getattr(robot, "cameras", None) or {}
        sources: list[tuple[str, int, Any]] = []
        slots: dict[str, _NamedSlot] = {}
        name_to_index: dict[str, int] = {}

        for name, cam in cameras.items():
            idx = _camera_device_index(cam)
            if idx is None:
                logger.warning("FrameBroker: skip camera %r — no device index", name)
                continue
            name_to_index[name] = idx
            slots[name] = _NamedSlot(name, idx)
            sources.append((name, idx, cam))

        with self._lock:
            self._slots = slots
            self._sources = sources

        if slots:
            self._stop.clear()
            self._preview_thread = threading.Thread(
                target=self._preview_loop,
                name="frame-broker-preview",
                daemon=True,
            )
            self._preview_thread.start()
            logger.info(
                "FrameBroker attached %s (peek @ %.0f fps → /ws/recording-preview)",
                name_to_index,
                _PREVIEW_FPS,
            )
        else:
            logger.warning("FrameBroker: no cameras to attach")

        self._attached = True
        return name_to_index

    def detach(self) -> None:
        self._stop.set()
        thread = self._preview_thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=2.0)
        self._preview_thread = None
        with self._lock:
            self._sources = []
            self._slots.clear()
        self._attached = False
        logger.info("FrameBroker detached")

    def wait_next_jpeg(
        self, name: str, after_seq: int, timeout: float
    ) -> tuple[bytes | None, int, int]:
        with self._lock:
            slot = self._slots.get(name)
        if slot is None:
            return None, after_seq, 0
        return slot.wait_next(after_seq, timeout)

    def latest_jpeg(self, name: str) -> tuple[bytes | None, int, int]:
        with self._lock:
            slot = self._slots.get(name)
        if slot is None:
            return None, 0, 0
        return slot.latest()

    @staticmethod
    def pack_ws_frame(jpeg: bytes, age_ms: int) -> bytes:
        return _WS_AGE_STRUCT.pack(max(0, min(age_ms, 0xFFFFFFFF))) + jpeg

    def _encode(self, frame: Any) -> bytes | None:
        import cv2
        import numpy as np

        arr = np.asarray(frame)
        if arr.ndim != 3 or arr.shape[2] not in (3, 4):
            return None
        if arr.shape[2] == 4:
            arr = arr[:, :, :3]
        # LeRobot OpenCV cameras default to RGB; JPEG encode needs BGR.
        arr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
        h, w = arr.shape[:2]
        if w != self._width or h != self._height:
            arr = cv2.resize(arr, (self._width, self._height), interpolation=cv2.INTER_AREA)
        if self._encode_params is None:
            self._encode_params = [int(cv2.IMWRITE_JPEG_QUALITY), self._quality]
        ok, buf = cv2.imencode(".jpg", arr, self._encode_params)
        if not ok:
            return None
        return buf.tobytes()

    def _preview_loop(self) -> None:
        interval = 1.0 / _PREVIEW_FPS
        while not self._stop.is_set():
            t0 = time.monotonic()
            with self._lock:
                sources = list(self._sources)
                slots = dict(self._slots)
            for name, _index, cam in sources:
                if self._stop.is_set():
                    break
                try:
                    frame = _peek_latest_frame(cam)
                except Exception:
                    continue
                if frame is None:
                    continue
                try:
                    frame = frame.copy()
                except Exception:
                    continue
                jpeg = self._encode(frame)
                if jpeg is None:
                    continue
                slot = slots.get(name)
                if slot is not None:
                    slot.publish(jpeg)

            elapsed = time.monotonic() - t0
            self._stop.wait(timeout=max(0.0, interval - elapsed))


frame_broker = FrameBroker()
