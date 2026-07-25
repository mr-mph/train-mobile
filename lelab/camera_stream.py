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

"""Server-side OpenCV camera previews for remote browsers (MJPEG).

Browser ``getUserMedia`` only sees cameras on the machine running the browser.
When the UI is opened on a phone over a tunnel, Mac USB cameras must be opened
here and streamed. Recording / inference still need exclusive OpenCV access, so
call ``camera_hub.stop_all()`` before those paths claim the devices.
"""

from __future__ import annotations

import logging
import platform
import threading
import time
from collections.abc import Iterator
from typing import Any

logger = logging.getLogger(__name__)

_JPEG_QUALITY = 70
_DEFAULT_WIDTH = 640
_DEFAULT_HEIGHT = 480
_DEFAULT_FPS = 15.0


def _cv2_backend() -> int:
    import cv2

    system = platform.system()
    if system == "Darwin":
        return cv2.CAP_AVFOUNDATION
    if system == "Linux":
        return cv2.CAP_V4L2
    if system == "Windows":
        return cv2.CAP_DSHOW
    return cv2.CAP_ANY


class _CameraWorker:
    """Owns one OpenCV capture and keeps the latest JPEG in memory."""

    def __init__(self, index: int, width: int, height: int, fps: float) -> None:
        self.index = index
        self.width = width
        self.height = height
        self.fps = max(1.0, min(fps, 30.0))
        self._lock = threading.Lock()
        self._jpeg: bytes | None = None
        self._error: str | None = None
        self._stop = threading.Event()
        self._thread = threading.Thread(
            target=self._run,
            name=f"camera-preview-{index}",
            daemon=True,
        )
        self._clients = 0
        self._thread.start()

    def add_client(self) -> None:
        with self._lock:
            self._clients += 1

    def remove_client(self) -> int:
        with self._lock:
            self._clients = max(0, self._clients - 1)
            return self._clients

    def latest_jpeg(self) -> bytes | None:
        with self._lock:
            return self._jpeg

    def error(self) -> str | None:
        with self._lock:
            return self._error

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=3.0)

    def _run(self) -> None:
        import cv2

        backend = _cv2_backend()
        cap = cv2.VideoCapture(self.index, backend)
        if not cap.isOpened():
            with self._lock:
                self._error = f"Could not open camera index {self.index}"
            logger.warning(self._error)
            return

        try:
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, float(self.width))
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, float(self.height))
            cap.set(cv2.CAP_PROP_FPS, float(self.fps))
            interval = 1.0 / self.fps
            encode_params = [int(cv2.IMWRITE_JPEG_QUALITY), _JPEG_QUALITY]

            while not self._stop.is_set():
                t0 = time.monotonic()
                ok, frame = cap.read()
                if not ok or frame is None:
                    with self._lock:
                        self._error = f"Failed to read frame from camera {self.index}"
                    time.sleep(0.1)
                    continue
                ok, buf = cv2.imencode(".jpg", frame, encode_params)
                if ok:
                    with self._lock:
                        self._jpeg = buf.tobytes()
                        self._error = None
                elapsed = time.monotonic() - t0
                time.sleep(max(0.0, interval - elapsed))
        finally:
            cap.release()
            logger.info("Released preview capture for camera index %s", self.index)


class CameraHub:
    """Process-wide registry of preview captures."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._workers: dict[int, _CameraWorker] = {}

    def stop_all(self) -> dict[str, Any]:
        """Release every preview capture so recording/inference can open devices."""
        with self._lock:
            workers = list(self._workers.values())
            self._workers.clear()
        for worker in workers:
            worker.stop()
        logger.info("Stopped %d camera preview capture(s)", len(workers))
        return {"success": True, "stopped": len(workers)}

    def _get_or_start(self, index: int, width: int, height: int, fps: float) -> _CameraWorker:
        with self._lock:
            worker = self._workers.get(index)
            if worker is None:
                worker = _CameraWorker(index, width, height, fps)
                self._workers[index] = worker
            worker.add_client()
            return worker

    def _release_client(self, index: int, worker: _CameraWorker) -> None:
        remaining = worker.remove_client()
        if remaining > 0:
            return
        with self._lock:
            current = self._workers.get(index)
            if current is worker:
                del self._workers[index]
        worker.stop()

    def mjpeg_frames(
        self,
        index: int,
        *,
        width: int = _DEFAULT_WIDTH,
        height: int = _DEFAULT_HEIGHT,
        fps: float = _DEFAULT_FPS,
    ) -> Iterator[bytes]:
        """Yield multipart MJPEG chunks until the client disconnects."""
        worker = self._get_or_start(index, width, height, fps)
        boundary = b"--frame"
        interval = 1.0 / max(1.0, min(fps, 30.0))
        try:
            # Wait briefly for the first frame so the browser gets a real JPEG.
            deadline = time.monotonic() + 5.0
            while worker.latest_jpeg() is None and worker.error() is None:
                if time.monotonic() > deadline:
                    break
                time.sleep(0.05)

            err = worker.error()
            if err and worker.latest_jpeg() is None:
                raise RuntimeError(err)

            while True:
                jpeg = worker.latest_jpeg()
                if jpeg is None:
                    time.sleep(interval)
                    continue
                yield (
                    boundary
                    + b"\r\nContent-Type: image/jpeg\r\nContent-Length: "
                    + str(len(jpeg)).encode()
                    + b"\r\n\r\n"
                    + jpeg
                    + b"\r\n"
                )
                time.sleep(interval)
        finally:
            self._release_client(index, worker)


camera_hub = CameraHub()
