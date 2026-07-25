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

Architecture:
  - Robot cameras keep owning the USB devices (LeRobot OpenCV threads).
  - Control loop reads via cam.read_latest() → frames go into the dataset.
  - A dedicated preview pump thread also peeks those cameras and pushes
    JPEGs to CameraHub for the phone UI.

The preview pump is independent of record_loop. That matters because
``dataset.add_frame`` (image encode/write) can block the control loop for
hundreds of ms per tick — if UI frames were only published from that loop,
the phone feed freezes the moment an episode starts.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable

logger = logging.getLogger(__name__)

_PREVIEW_WIDTH = 320
_PREVIEW_HEIGHT = 240
_PREVIEW_QUALITY = 40
_PREVIEW_FPS = 15.0


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
    """Fan-out: dataset reads + independent UI preview pump."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._frames: dict[str, Any] = {}
        self._name_to_index: dict[str, int] = {}
        # (cam, method_name, original_bound_method)
        self._wrapped: list[tuple[Any, str, Any]] = []
        # Preview pump uses originals so it never depends on the control loop.
        # (name, index, original_read_latest)
        self._preview_sources: list[tuple[str, int, Callable[..., Any]]] = []
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
        """Attach to a connected robot: wrap reads + start UI preview pump."""
        from .camera_stream import camera_hub

        if self._attached:
            self.detach()

        cameras = getattr(robot, "cameras", None) or {}
        name_to_index: dict[str, int] = {}
        preview_sources: list[tuple[str, int, Callable[..., Any]]] = []

        for name, cam in cameras.items():
            idx = _camera_device_index(cam)
            if idx is None:
                logger.warning("FrameBroker: skip camera %r — no device index", name)
                continue
            name_to_index[name] = idx

            orig_latest = getattr(cam, "read_latest", None)
            if orig_latest is not None and callable(orig_latest):
                preview_sources.append((name, idx, orig_latest))

            self._wrap_camera(cam, name, idx)

        self._name_to_index = name_to_index
        self._preview_sources = preview_sources

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
                "FrameBroker attached cameras %s (preview pump @ %.0f fps)",
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
        self._preview_sources = []

        for cam, method_name, original in self._wrapped:
            try:
                setattr(cam, method_name, original)
            except Exception:
                logger.debug("FrameBroker: failed to restore %s", method_name, exc_info=True)
        self._wrapped.clear()

        with self._lock:
            self._frames.clear()
            self._name_to_index.clear()

        camera_hub.end_relay()
        self._attached = False
        logger.info("FrameBroker detached")

    def publish(self, name: str, index: int, frame: Any) -> None:
        """Store the latest raw frame (control-loop path). UI is pumped separately."""
        if frame is None:
            return
        with self._lock:
            self._frames[name] = frame

    def _push_ui(self, index: int, frame: Any) -> None:
        from .camera_stream import camera_hub

        camera_hub.push_relay_frame(index, frame, rgb=True)

    def _preview_loop(self) -> None:
        """Peek cameras on a fixed cadence — never blocked by dataset.add_frame."""
        interval = 1.0 / _PREVIEW_FPS
        while not self._stop.is_set():
            t0 = time.monotonic()
            for name, index, read_latest in self._preview_sources:
                if self._stop.is_set():
                    break
                try:
                    # Generous max_age: we only need *a* recent frame for UI.
                    frame = read_latest(max_age_ms=2000)
                except Exception:
                    # Timeout / not ready yet — skip this tick.
                    continue
                if frame is None:
                    continue
                with self._lock:
                    self._frames[name] = frame
                try:
                    self._push_ui(index, frame)
                except Exception:
                    logger.debug("FrameBroker: UI push failed for %s", name, exc_info=True)

            elapsed = time.monotonic() - t0
            self._stop.wait(timeout=max(0.0, interval - elapsed))

    def _wrap_camera(self, cam: Any, name: str, index: int) -> None:
        """Ensure control-loop reads also update the shared latest-frame store."""
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


# Process-wide singleton — recording attaches while it owns the devices.
frame_broker = FrameBroker()
