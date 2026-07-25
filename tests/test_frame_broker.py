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

import numpy as np


def test_named_slots_update_and_wait() -> None:
    from lelab.frame_broker import FrameBroker

    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    frame[:] = (40, 80, 120)
    lock = threading.Lock()
    cam = SimpleNamespace(
        index_or_path=0,
        frame_lock=lock,
        latest_frame=frame,
    )
    robot = SimpleNamespace(cameras={"gripper_cam": cam})

    broker = FrameBroker()
    assert broker.attach_robot(robot, preview_width=160, preview_height=120) == {
        "gripper_cam": 0
    }
    assert broker.attached
    assert broker.camera_names == ["gripper_cam"]

    jpeg, seq, _age = broker.wait_next_jpeg("gripper_cam", 0, timeout=2.0)
    assert jpeg is not None and jpeg[:2] == b"\xff\xd8"
    assert seq >= 1

    jpeg2, seq2, _ = broker.wait_next_jpeg("gripper_cam", seq, timeout=2.0)
    assert jpeg2 is not None
    assert seq2 > seq

    broker.detach()
    assert not broker.attached


def test_wait_unknown_camera_returns_none() -> None:
    from lelab.frame_broker import FrameBroker

    broker = FrameBroker()
    jpeg, seq, age = broker.wait_next_jpeg("missing", 0, timeout=0.05)
    assert jpeg is None and seq == 0 and age == 0
