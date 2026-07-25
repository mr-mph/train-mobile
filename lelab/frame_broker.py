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

"""Central camera frame broker.

One capture path feeds both:
  - the dataset / robot control loop (unchanged ndarray returned from cam.read*)
  - the phone UI preview (JPEG via CameraHub relay)

Attach after robot cameras are connected; detach before disconnect.
"""

from __future__ import annotations

import logging
import threading
from typing import Any

logger = logging.getLogger(__name__)

_PREVIEW_WIDTH = 320
_PREVIEW_HEIGHT = 240
_PREVIEW_QUALITY = 40
_PREVIEW_MIN_INTERVAL_S = 1.0 / 15.0


def _camera_device_index(cam: Any) -> int | None:
    """Best-effort OpenCV device index from a live camera or its config."""
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


class FrameBroker:
    """Stores the latest frame per camera and mirrors JPEGs to the UI hub."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._frames: dict[str, Any] = {}
        self._name_to_index: dict[str, int] = {}
        self._wrapped: list[tuple[Any, str, Any]] = []
        self._last_ui_push: dict[int, float] = {}
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
        """Wrap each robot camera so every read publishes into this broker.

        Returns the name→device-index map that was attached.
        """
        from .camera_stream import camera_hub

        if self._attached:
            self.detach()

        cameras = getattr(robot, "cameras", None) or {}
        name_to_index: dict[str, int] = {}
        for name, cam in cameras.items():
            idx = _camera_device_index(cam)
            if idx is None:
                logger.warning("FrameBroker: skip camera %r — no device index", name)
                continue
            name_to_index[name] = idx
            self._wrap_camera(cam, name, idx)

        self._name_to_index = name_to_index
        if name_to_index:
            camera_hub.begin_relay(
                list(name_to_index.values()),
                width=preview_width,
                height=preview_height,
                quality=preview_quality,
            )
            logger.info(
                "FrameBroker attached cameras %s",
                {n: i for n, i in name_to_index.items()},
            )
        else:
            logger.warning("FrameBroker: no cameras to attach")

        self._attached = True
        return name_to_index

    def detach(self) -> None:
        from .camera_stream import camera_hub

        for cam, method_name, original in self._wrapped:
            try:
                setattr(cam, method_name, original)
            except Exception:
                logger.debug("FrameBroker: failed to restore %s", method_name, exc_info=True)
        self._wrapped.clear()
        with self._lock:
            self._frames.clear()
            self._last_ui_push.clear()
            self._name_to_index.clear()
        camera_hub.end_relay()
        self._attached = False
        logger.info("FrameBroker detached")

    def publish(self, name: str, index: int, frame: Any) -> None:
        """Record a frame for dataset consumers and push a UI JPEG."""
        import time

        if frame is None:
            return

        with self._lock:
            self._frames[name] = frame

        now = time.monotonic()
        last = self._last_ui_push.get(index, 0.0)
        if now - last < _PREVIEW_MIN_INTERVAL_S:
            return
        self._last_ui_push[index] = now

        from .camera_stream import camera_hub

        camera_hub.push_relay_frame(index, frame, rgb=True)

    def _wrap_camera(self, cam: Any, name: str, index: int) -> None:
        for method_name in ("read_latest", "read"):
            original = getattr(cam, method_name, None)
            if original is None or not callable(original):
                continue

            def make_wrapper(orig: Any, cam_name: str, cam_index: int):
                def wrapped(*args: Any, **kwargs: Any):
                    frame = orig(*args, **kwargs)
                    self.publish(cam_name, cam_index, frame)
                    return frame

                return wrapped

            setattr(cam, method_name, make_wrapper(original, name, index))
            self._wrapped.append((cam, method_name, original))


# Process-wide singleton — recording / teleop attach while they own the devices.
frame_broker = FrameBroker()
