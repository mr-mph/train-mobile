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

Recording still uses the robot's configured resolution/fps. Previews capture
on a background thread and push JPEGs over HTTP poll or WebSocket. Capture
size is requested large enough for the device, then resized for encode so
odd preview sizes (e.g. 320x240) don't break AVFoundation.
"""

from __future__ import annotations

import logging
import platform
import struct
import threading
import time
from collections.abc import Iterator
from typing import Any

logger = logging.getLogger(__name__)

_JPEG_QUALITY = 40
_DEFAULT_WIDTH = 320
_DEFAULT_HEIGHT = 240
_DEFAULT_FPS = 15.0
_IDLE_STOP_S = 30.0
# Binary WS frame: 4-byte big-endian age_ms + JPEG bytes.
_WS_AGE_STRUCT = struct.Struct(">I")


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
        self._captured_at: float | None = None
        self._seq = 0
        self._fatal: str | None = None
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

    def latest_packet(self) -> tuple[bytes | None, int, int]:
        """Return (jpeg, seq, age_ms)."""
        with self._cond:
            age_ms = 0
            if self._jpeg is not None and self._captured_at is not None:
                age_ms = max(0, int((time.monotonic() - self._captured_at) * 1000))
            return self._jpeg, self._seq, age_ms

    def wait_jpeg(self, timeout: float = 5.0) -> bytes | None:
        """Block until a JPEG is available (or timeout / fatal open error)."""
        deadline = time.monotonic() + timeout
        with self._cond:
            while self._jpeg is None and self._fatal is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._cond.wait(timeout=remaining)
            return self._jpeg

    def wait_next_jpeg(self, after_seq: int, timeout: float) -> tuple[bytes | None, int, int]:
        """Wait for a frame newer than ``after_seq``. Returns jpeg, seq, age_ms."""
        deadline = time.monotonic() + timeout
        with self._cond:
            while self._seq <= after_seq and self._fatal is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._cond.wait(timeout=remaining)
            age_ms = 0
            if self._jpeg is not None and self._captured_at is not None:
                age_ms = max(0, int((time.monotonic() - self._captured_at) * 1000))
            return self._jpeg, self._seq, age_ms

    def error(self) -> str | None:
        with self._cond:
            return self._fatal

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
                self._fatal = f"Could not open camera index {self.index}"
                self._cond.notify_all()
            logger.warning(self._fatal)
            return

        try:
            # Request a common capture size; many USB/AVFoundation cams reject
            # tiny preview sizes and then return no frames.
            capture_w = max(self.width, 640)
            capture_h = max(self.height, 480)
            if platform.system() != "Darwin":
                with_fourcc = getattr(cv2, "VideoWriter_fourcc", None)
                if with_fourcc is not None:
                    cap.set(cv2.CAP_PROP_FOURCC, with_fourcc(*"MJPG"))
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, float(capture_w))
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, float(capture_h))
            cap.set(cv2.CAP_PROP_FPS, float(max(self.fps, 15.0)))
            try:
                cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            except Exception:
                pass

            interval = 1.0 / self.fps
            encode_params = [int(cv2.IMWRITE_JPEG_QUALITY), self.quality]
            consecutive_fails = 0

            # Warm up a few frames — first reads after open are often empty.
            for _ in range(5):
                cap.read()

            while not self._stop.is_set():
                t0 = time.monotonic()
                ok, frame = cap.read()
                if not ok or frame is None:
                    consecutive_fails += 1
                    if consecutive_fails == 1 or consecutive_fails % 30 == 0:
                        logger.warning(
                            "Camera %s read failed (%d consecutive)",
                            self.index,
                            consecutive_fails,
                        )
                    if consecutive_fails >= 60 and self._jpeg is None:
                        with self._cond:
                            self._fatal = f"Failed to read frame from camera {self.index}"
                            self._cond.notify_all()
                    time.sleep(0.05)
                    continue

                consecutive_fails = 0
                h, w = frame.shape[:2]
                if w != self.width or h != self.height:
                    frame = cv2.resize(
                        frame, (self.width, self.height), interpolation=cv2.INTER_AREA
                    )

                ok, buf = cv2.imencode(".jpg", frame, encode_params)
                if ok:
                    captured_at = time.monotonic()
                    with self._cond:
                        self._jpeg = buf.tobytes()
                        self._captured_at = captured_at
                        self._seq += 1
                        self._fatal = None
                        self._cond.notify_all()

                elapsed = time.monotonic() - t0
                time.sleep(max(0.0, interval - elapsed))
        finally:
            cap.release()
            logger.info("Released preview capture for camera index %s", self.index)


class _RelaySlot:
    """JPEG buffer fed by an external owner (e.g. the recording loop).

    Same consumer API as ``_CameraWorker`` so WS/HTTP preview paths work while
    OpenCV devices are held exclusively by recording/inference.
    """

    def __init__(
        self,
        index: int,
        width: int,
        height: int,
        *,
        quality: int = _JPEG_QUALITY,
    ) -> None:
        self.index = index
        self.width = width
        self.height = height
        self.fps = _DEFAULT_FPS
        self.quality = max(20, min(int(quality), 85))
        self._cond = threading.Condition()
        self._jpeg: bytes | None = None
        self._captured_at: float | None = None
        self._seq = 0
        self._fatal: str | None = None
        self._stream_clients = 0
        self._last_used = time.monotonic()
        self._encode_params: list[int] | None = None

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

    def latest_packet(self) -> tuple[bytes | None, int, int]:
        with self._cond:
            age_ms = 0
            if self._jpeg is not None and self._captured_at is not None:
                age_ms = max(0, int((time.monotonic() - self._captured_at) * 1000))
            return self._jpeg, self._seq, age_ms

    def wait_jpeg(self, timeout: float = 5.0) -> bytes | None:
        deadline = time.monotonic() + timeout
        with self._cond:
            while self._jpeg is None and self._fatal is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._cond.wait(timeout=remaining)
            return self._jpeg

    def wait_next_jpeg(self, after_seq: int, timeout: float) -> tuple[bytes | None, int, int]:
        deadline = time.monotonic() + timeout
        with self._cond:
            while self._seq <= after_seq and self._fatal is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._cond.wait(timeout=remaining)
            age_ms = 0
            if self._jpeg is not None and self._captured_at is not None:
                age_ms = max(0, int((time.monotonic() - self._captured_at) * 1000))
            return self._jpeg, self._seq, age_ms

    def error(self) -> str | None:
        with self._cond:
            return self._fatal

    def stop(self) -> None:
        with self._cond:
            self._cond.notify_all()

    def push_bgr(self, frame: Any, *, rgb: bool = False) -> None:
        """Encode a HxWx3 ndarray and publish it.

        Pass ``rgb=True`` when the frame is RGB (LeRobot OpenCV default); OpenCV
        JPEG encode expects BGR.
        """
        import cv2
        import numpy as np

        if frame is None:
            return
        arr = np.asarray(frame)
        if arr.ndim != 3 or arr.shape[2] not in (3, 4):
            return
        if arr.shape[2] == 4:
            arr = arr[:, :, :3]
        if rgb:
            arr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)

        h, w = arr.shape[:2]
        if w != self.width or h != self.height:
            arr = cv2.resize(arr, (self.width, self.height), interpolation=cv2.INTER_AREA)

        if self._encode_params is None:
            self._encode_params = [int(cv2.IMWRITE_JPEG_QUALITY), self.quality]
        ok, buf = cv2.imencode(".jpg", arr, self._encode_params)
        if not ok:
            return
        captured_at = time.monotonic()
        with self._cond:
            self._jpeg = buf.tobytes()
            self._captured_at = captured_at
            self._seq += 1
            self._fatal = None
            self._last_used = captured_at
            self._cond.notify_all()


class CameraHub:
    """Process-wide registry of preview captures."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._workers: dict[int, _CameraWorker] = {}
        self._relays: dict[int, _RelaySlot] = {}

    def stop_all(self) -> dict[str, Any]:
        """Release every preview capture so recording/inference can open devices."""
        with self._lock:
            workers = list(self._workers.values())
            self._workers.clear()
            # Keep relays — recording may still be pushing frames.
        for worker in workers:
            worker.stop()
        logger.info("Stopped %d camera preview capture(s)", len(workers))
        return {"success": True, "stopped": len(workers)}

    def begin_relay(
        self,
        camera_indices: list[int],
        *,
        width: int = _DEFAULT_WIDTH,
        height: int = _DEFAULT_HEIGHT,
        quality: int = _JPEG_QUALITY,
    ) -> None:
        """Switch listed indices to externally pushed frames (no OpenCV open)."""
        self.stop_all()
        with self._lock:
            for slot in self._relays.values():
                slot.stop()
            self._relays = {
                int(idx): _RelaySlot(int(idx), width, height, quality=quality)
                for idx in camera_indices
                if idx is not None and int(idx) >= 0
            }
        logger.info("Camera preview relay enabled for indices %s", sorted(self._relays))

    def end_relay(self) -> None:
        with self._lock:
            for slot in self._relays.values():
                slot.stop()
            self._relays.clear()
        logger.info("Camera preview relay disabled")

    def push_relay_frame(self, index: int, frame: Any, *, rgb: bool = True) -> None:
        with self._lock:
            slot = self._relays.get(index)
        if slot is not None:
            slot.push_bgr(frame, rgb=rgb)

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
    ) -> _CameraWorker | _RelaySlot:
        with self._lock:
            relay = self._relays.get(index)
            if relay is not None:
                relay.touch()
                return relay
            self._reap_idle_unlocked()
            worker = self._workers.get(index)
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
        timeout: float = 5.0,
    ) -> tuple[bytes, int]:
        """Return (jpeg_bytes, age_ms)."""
        worker = self._ensure_worker(index, width, height, fps, quality=quality)
        jpeg = worker.wait_jpeg(timeout=timeout)
        if jpeg is None:
            jpeg, _seq, age_ms = worker.latest_packet()
        else:
            _j, _seq, age_ms = worker.latest_packet()
            jpeg = jpeg or _j
        err = worker.error()
        if jpeg is None:
            raise RuntimeError(err or f"No frame from camera {index}")
        worker.touch()
        return jpeg, age_ms

    def open_stream(
        self,
        index: int,
        *,
        width: int = _DEFAULT_WIDTH,
        height: int = _DEFAULT_HEIGHT,
        fps: float = _DEFAULT_FPS,
        quality: int = _JPEG_QUALITY,
    ) -> _CameraWorker | _RelaySlot:
        worker = self._ensure_worker(index, width, height, fps, quality=quality)
        worker.add_stream_client()
        return worker

    def close_stream(self, worker: _CameraWorker | _RelaySlot) -> None:
        worker.remove_stream_client()

    def mjpeg_frames(
        self,
        index: int,
        *,
        width: int = _DEFAULT_WIDTH,
        height: int = _DEFAULT_HEIGHT,
        fps: float = _DEFAULT_FPS,
        quality: int = _JPEG_QUALITY,
    ) -> Iterator[bytes]:
        """Yield multipart MJPEG chunks until the client disconnects."""
        worker = self.open_stream(index, width=width, height=height, fps=fps, quality=quality)
        boundary = b"--frame"
        frame_timeout = max(0.15, 1.5 / max(1.0, fps))
        try:
            jpeg, _seq, _age = worker.wait_next_jpeg(0, timeout=5.0)
            if jpeg is None:
                jpeg = worker.wait_jpeg(timeout=5.0)
            err = worker.error()
            if jpeg is None:
                raise RuntimeError(err or f"No frame from camera {index}")

            seq = 0
            while True:
                jpeg, seq, _age = worker.wait_next_jpeg(seq, timeout=frame_timeout)
                if jpeg is None:
                    if worker.error() and worker.latest_jpeg() is None:
                        raise RuntimeError(worker.error())
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
            self.close_stream(worker)

    @staticmethod
    def pack_ws_frame(jpeg: bytes, age_ms: int) -> bytes:
        return _WS_AGE_STRUCT.pack(max(0, min(age_ms, 0xFFFFFFFF))) + jpeg


camera_hub = CameraHub()
