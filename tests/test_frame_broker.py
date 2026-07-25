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

import time
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import numpy as np


def test_preview_pump_pushes_ui_independently_of_control_loop() -> None:
    """UI frames must keep flowing even if the control loop never reads."""
    from lelab.frame_broker import FrameBroker

    frame = np.zeros((240, 320, 3), dtype=np.uint8)
    frame[:] = (10, 20, 30)

    cam = SimpleNamespace(
        index_or_path=0,
        config=SimpleNamespace(index_or_path=0),
        read_latest=MagicMock(return_value=frame),
        read=MagicMock(return_value=frame),
    )
    robot = SimpleNamespace(cameras={"wrist": cam})

    broker = FrameBroker()
    with patch("lelab.camera_stream.camera_hub") as hub:
        hub.begin_relay = MagicMock()
        hub.push_relay_frame = MagicMock()
        hub.end_relay = MagicMock()

        mapping = broker.attach_robot(robot, preview_width=160, preview_height=120)
        assert mapping == {"wrist": 0}
        hub.begin_relay.assert_called_once()

        # Wait for the preview pump — do NOT call cam.read_latest from "control".
        deadline = time.time() + 2.0
        while time.time() < deadline and hub.push_relay_frame.call_count < 2:
            time.sleep(0.05)

        assert hub.push_relay_frame.call_count >= 2, (
            "preview pump should push UI frames without control-loop reads"
        )
        args, kwargs = hub.push_relay_frame.call_args
        assert args[0] == 0
        assert kwargs.get("rgb") is True

        broker.detach()
        hub.end_relay.assert_called_once()


def test_control_loop_read_still_returns_frame() -> None:
    from lelab.frame_broker import FrameBroker

    frame = np.zeros((240, 320, 3), dtype=np.uint8)
    cam = SimpleNamespace(
        index_or_path=1,
        read_latest=MagicMock(return_value=frame),
        read=MagicMock(return_value=frame),
    )
    robot = SimpleNamespace(cameras={"front": cam})
    broker = FrameBroker()
    with patch("lelab.camera_stream.camera_hub") as hub:
        hub.begin_relay = MagicMock()
        hub.push_relay_frame = MagicMock()
        hub.end_relay = MagicMock()
        broker.attach_robot(robot)
        out = cam.read_latest(max_age_ms=500)
        assert out is frame
        assert broker.latest("front") is frame
        broker.detach()


def test_camera_index_from_index_or_path() -> None:
    from lelab.frame_broker import _camera_device_index

    cam = SimpleNamespace(index_or_path=2, config=SimpleNamespace(index_or_path=9))
    assert _camera_device_index(cam) == 2
