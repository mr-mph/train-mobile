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

"""Tests for lelab.frame_broker.FrameBroker."""

from __future__ import annotations

import threading
import time
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import numpy as np


def test_preview_pump_peeks_without_calling_read_latest() -> None:
    from lelab.frame_broker import FrameBroker

    frame = np.zeros((240, 320, 3), dtype=np.uint8)
    frame[:] = (10, 20, 30)
    lock = threading.Lock()

    cam = SimpleNamespace(
        index_or_path=0,
        frame_lock=lock,
        latest_frame=frame,
        read_latest=MagicMock(side_effect=AssertionError("must not call read_latest")),
    )
    robot = SimpleNamespace(cameras={"wrist": cam})

    broker = FrameBroker()
    with patch("lelab.camera_stream.camera_hub") as hub:
        hub.begin_relay = MagicMock()
        hub.push_relay_frame = MagicMock()
        hub.end_relay = MagicMock()

        broker.attach_robot(robot)
        deadline = time.time() + 2.0
        while time.time() < deadline and hub.push_relay_frame.call_count < 2:
            time.sleep(0.05)

        assert hub.push_relay_frame.call_count >= 2
        cam.read_latest.assert_not_called()
        broker.detach()
        hub.end_relay.assert_called_once()


def test_camera_index_from_index_or_path() -> None:
    from lelab.frame_broker import _camera_device_index

    cam = SimpleNamespace(index_or_path=2)
    assert _camera_device_index(cam) == 2
