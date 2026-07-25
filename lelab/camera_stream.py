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

"""Server-side OpenCV camera previews for remote browsers.

Recording still uses the robot's configured resolution/fps. Previews default
to a smaller JPEG stream (polled one frame at a time) so phones on Wi‑Fi see
lower latency than multipart MJPEG in ``<img>`` (which browsers buffer heavily).
"""

from __future__ import annotations

import logging
import platform
import threading
import time
from collections.abc import Iterator
from typing import Any

logger = logging.getLogger(__name__)

# Preview defaults — keep recording configs untouched; UI can pass higher values.
_JPEG_QUALITY = 45
_DEFAULT_WIDTH = 320
_DEFAULT_HEIGHT = 240
_DEFAULT_FPS = 10.0
_IDLE_STOP_S = 2.5


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

    def __init__(
        self,
        index: int,
        width: int,
        height: int,
        fps: float,
        *,
        quality: int = _JPEG_QUALITY,
    ) -> None:
        self.index = index
        self.width = width
        self.height = height
        self.fps = max(1.0, min(fps, 30.0))
        self.quality = max(20, min(int(quality), 85))
        self._cond = threading.Condition()
        self._jpeg: bytes | None = None
        self._seq = 0
        self._error: str | None = None
        self._stop = threading.Event()
        self._thread = threading.Thread(
            target=self._run,
            name=f"camera-preview-{index}",
            daemon=True,
        )
        self._stream_clients = 0
        self._last_used = time.monotonic()
        self._thread.start()

    def touch(self) -> None:
        with self._cond:
            self._last_used = time.monotonic()

    def add_stream_client(self) -> None:
        with self._cond:
            self._stream_clients += 1
            self._last_used = time.monotonic()

    def remove_stream_client(self) -> int:
        with self._cond:
            self._stream_clients = max(0, self._stream_clients - 1)
            self._last_used = time.monotonic()
            return self._stream_clients

    def idle_for(self) -> float:
        with self._cond:
            if self._stream_clients > 0:
                return 0.0
            return time.monotonic() - self._last_used

    def latest_jpeg(self) -> bytes | None:
        with self._cond:
            return self._jpeg

    def wait_jpeg(self, timeout: float = 2.0) -> bytes | None:
        """Block until a JPEG is available (or timeout / error)."""
        deadline = time.monotonic() + timeout
        with self._cond:
            while self._jpeg is None and self._error is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._cond.wait(timeout=remaining)
            return self._jpeg

    def wait_next_jpeg(self, after_seq: int, timeout: float) -> tuple[bytes | None, int]:
        """Wait for a frame newer than ``after_seq``."""
        deadline = time.monotonic() + timeout
        with self._cond:
            while self._seq <= after_seq and self._error is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return self._jpeg, self._seq
                self._cond.wait(timeout=remaining)
            return self._jpeg, self._seq

    def error(self) -> str | None:
        with self._cond:
            return self._error

    def stop(self) -> None:
        self._stop.set()
        with self._cond:
            self._cond.notify_all()
        self._thread.join(timeout=3.0)

    def _run(self) -> None:
        import cv2

        backend = _cv2_backend()
        cap = cv2.VideoCapture(self.index, backend)
        if not cap.isOpened():
            with self._cond:
                self._error = f"Could not open camera index {self.index}"
                self._cond.notify_all()
            logger.warning(self._error)
            return

        try:
            # Prefer MJPG on USB cams — less host-side decode before we re-encode.
            with_fourcc = getattr(cv2, "VideoWriter_fourcc", None)
            if with_fourcc is not None:
                cap.set(cv2.CAP_PROP_FOURCC, with_fourcc(*"MJPG"))
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, float(self.width))
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, float(self.height))
            cap.set(cv2.CAP_PROP_FPS, float(self.fps))
            # Critical for latency: don't queue stale frames (ignored on some backends).
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

            interval = 1.0 / self.fps
            encode_params = [int(cv2.IMWRITE_JPEG_QUALITY), self.quality]

            while not self._stop.is_set():
                t0 = time.monotonic()
                # grab+retrieve: decode only the newest grabbed frame (lower latency
                # than read() when the driver still queues despite BUFFERSIZE=1).
                if not cap.grab():
                    with self._cond:
                        self._error = f"Failed to read frame from camera {self.index}"
                        self._cond.notify_all()
                    time.sleep(0.05)
                    continue
                ok, frame = cap.retrieve()
                if not ok or frame is None:
                    with self._cond:
                        self._error = f"Failed to read frame from camera {self.index}"
                        self._cond.notify_all()
                    time.sleep(0.05)
                    continue

                h, w = frame.shape[:2]
                if w != self.width or h != self.height:
                    frame = cv2.resize(frame, (self.width, self.height), interpolation=cv2.INTER_AREA)

                ok, buf = cv2.imencode(".jpg", frame, encode_params)
                if ok:
                    with self._cond:
                        self._jpeg = buf.tobytes()
                        self._seq += 1
                        self._error = None
                        self._cond.notify_all()

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

    def _reap_idle_unlocked(self) -> None:
        stale = [
            idx
            for idx, worker in self._workers.items()
            if worker.idle_for() >= _IDLE_STOP_S
        ]
        for idx in stale:
            worker = self._workers.pop(idx)
            worker.stop()

    def _ensure_worker(
        self,
        index: int,
        width: int,
        height: int,
        fps: float,
        *,
        quality: int,
    ) -> _CameraWorker:
        with self._lock:
            self._reap_idle_unlocked()
            worker = self._workers.get(index)
            # Restart if preview geometry/quality changed (recording settings stay separate).
            if worker is not None and (
                worker.width != width
                or worker.height != height
                or abs(worker.fps - fps) > 0.1
                or worker.quality != quality
            ):
                del self._workers[index]
                worker.stop()
                worker = None
            if worker is None:
                worker = _CameraWorker(index, width, height, fps, quality=quality)
                self._workers[index] = worker
            worker.touch()
            return worker

    def get_jpeg(
        self,
        index: int,
        *,
        width: int = _DEFAULT_WIDTH,
        height: int = _DEFAULT_HEIGHT,
        fps: float = _DEFAULT_FPS,
        quality: int = _JPEG_QUALITY,
        timeout: float = 2.0,
    ) -> bytes:
        """Return the latest JPEG (starts a short-lived preview capture if needed)."""
        worker = self._ensure_worker(index, width, height, fps, quality=quality)
        jpeg = worker.wait_jpeg(timeout=timeout)
        err = worker.error()
        if jpeg is None:
            raise RuntimeError(err or f"No frame from camera {index}")
        worker.touch()
        return jpeg

    def mjpeg_frames(
        self,
        index: int,
        *,
        width: int = _DEFAULT_WIDTH,
        height: int = _DEFAULT_HEIGHT,
        fps: float = _DEFAULT_FPS,
        quality: int = _JPEG_QUALITY,
    ) -> Iterator[bytes]:
        """Yield multipart MJPEG chunks until the client disconnects.

        Prefers pushing only *new* frames (no fixed sleep after each yield) so
        latency stays closer to one capture interval.
        """
        worker = self._ensure_worker(index, width, height, fps, quality=quality)
        worker.add_stream_client()
        boundary = b"--frame"
        frame_timeout = max(0.2, 2.0 / max(1.0, fps))
        try:
            jpeg = worker.wait_jpeg(timeout=5.0)
            err = worker.error()
            if jpeg is None:
                raise RuntimeError(err or f"No frame from camera {index}")

            seq = 0
            while True:
                jpeg, seq = worker.wait_next_jpeg(seq, timeout=frame_timeout)
                if jpeg is None:
                    err = worker.error()
                    if err:
                        raise RuntimeError(err)
                    continue
                worker.touch()
                yield (
                    boundary
                    + b"\r\nContent-Type: image/jpeg\r\nContent-Length: "
                    + str(len(jpeg)).encode()
                    + b"\r\n\r\n"
                    + jpeg
                    + b"\r\n"
                )
        finally:
            worker.remove_stream_client()


camera_hub = CameraHub()
