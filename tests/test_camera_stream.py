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

"""Tests for lelab.camera_stream.CameraHub (no real OpenCV devices)."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest


def test_stop_all_on_empty_hub() -> None:
    from lelab.camera_stream import CameraHub

    hub = CameraHub()
    assert hub.stop_all() == {"success": True, "stopped": 0}


def test_stop_all_stops_running_workers() -> None:
    from lelab.camera_stream import CameraHub

    hub = CameraHub()
    worker = MagicMock()
    hub._workers[0] = worker
    result = hub.stop_all()
    assert result["stopped"] == 1
    worker.stop.assert_called_once()
    assert hub._workers == {}


def test_preview_stop_endpoint(client) -> None:
    response = client.post("/cameras/preview/stop")
    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True


@patch("lelab.camera_stream._CameraWorker")
def test_mjpeg_endpoint_returns_503_when_open_fails(mock_worker_cls, client) -> None:
    worker = MagicMock()
    worker.latest_jpeg.return_value = None
    worker.error.return_value = "Could not open camera index 99"
    worker.add_client = MagicMock()
    worker.remove_client.return_value = 0
    mock_worker_cls.return_value = worker

    # Force hub path: patch camera_hub methods used by the route.
    from lelab import camera_stream

    def boom(*_a, **_k):
        raise RuntimeError("Could not open camera index 99")

    with patch.object(camera_stream.camera_hub, "mjpeg_frames", side_effect=boom):
        response = client.get("/cameras/99/mjpeg")
    assert response.status_code == 503


def test_get_jpeg_raises_when_no_frame() -> None:
    from lelab.camera_stream import CameraHub

    hub = CameraHub()
    worker = MagicMock()
    worker.wait_jpeg.return_value = None
    worker.error.return_value = "Could not open camera index 0"
    worker.touch = MagicMock()
    with patch.object(hub, "_ensure_worker", return_value=worker):
        with pytest.raises(RuntimeError, match="Could not open"):
            hub.get_jpeg(0)
