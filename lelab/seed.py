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

"""Seed working SO-101 robot config from stuff from last project/."""

from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path

from .utils.config import (
    FOLLOWER_CONFIG_PATH,
    LEADER_CONFIG_PATH,
    ROBOTS_PATH,
    save_robot_record,
)

logger = logging.getLogger(__name__)

_REPO_ROOT = Path(__file__).resolve().parent.parent
_SEED_DIR = _REPO_ROOT / "stuff from last project" / "configs"


def seed_seth_bot_if_missing() -> dict:
    """Copy last-project calib + robot record if seth-bot is not present."""
    robots = Path(ROBOTS_PATH)
    robots.mkdir(parents=True, exist_ok=True)
    robot_path = robots / "seth-bot.json"
    created = False

    Path(LEADER_CONFIG_PATH).mkdir(parents=True, exist_ok=True)
    Path(FOLLOWER_CONFIG_PATH).mkdir(parents=True, exist_ok=True)

    leader_src = _SEED_DIR / "my_awesome_leader_arm.json"
    follower_src = _SEED_DIR / "my_awesome_follower_arm.json"
    if leader_src.is_file():
        dest = Path(LEADER_CONFIG_PATH) / "seth-bot.json"
        if not dest.is_file():
            shutil.copy2(leader_src, dest)
            created = True
        # Also keep my_awesome_* names for compatibility
        awesome_l = Path(LEADER_CONFIG_PATH) / "my_awesome_leader_arm.json"
        if not awesome_l.is_file():
            shutil.copy2(leader_src, awesome_l)
    if follower_src.is_file():
        dest = Path(FOLLOWER_CONFIG_PATH) / "seth-bot.json"
        if not dest.is_file():
            shutil.copy2(follower_src, dest)
            created = True
        awesome_f = Path(FOLLOWER_CONFIG_PATH) / "my_awesome_follower_arm.json"
        if not awesome_f.is_file():
            shutil.copy2(follower_src, awesome_f)

    if not robot_path.is_file() and (_SEED_DIR / "seth-bot.json").is_file():
        raw = json.loads((_SEED_DIR / "seth-bot.json").read_text())
        cameras = []
        for cam in raw.get("cameras") or []:
            cameras.append({**cam, "width": 640, "height": 480, "fps": 15})
        save_robot_record(
            "seth-bot",
            {
                "leader_port": raw.get("leader_port", ""),
                "follower_port": raw.get("follower_port", ""),
                "leader_config": "seth-bot.json",
                "follower_config": "seth-bot.json",
                "cameras": cameras,
            },
            allow_create=True,
        )
        created = True
        logger.info("Seeded seth-bot robot record with 640x480@15 cameras")

    return {"seeded": created, "robot": "seth-bot" if robot_path.is_file() else None}
