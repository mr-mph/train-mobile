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

"""Unit tests for Vast.ai instance parsing helpers."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest


def test_get_instance_unwraps_object_payload() -> None:
    from lelab.runners import vast as vast_mod

    payload = {
        "instances": {
            "id": 42,
            "actual_status": "running",
            "public_ipaddr": "1.2.3.4",
            "ssh_port": 22,
        }
    }
    response = MagicMock()
    response.raise_for_status = MagicMock()
    response.json.return_value = payload

    mock_client = MagicMock()
    mock_client.__enter__.return_value = mock_client
    mock_client.get.return_value = response

    with patch.object(vast_mod.httpx, "Client", return_value=mock_client):
        with patch.object(vast_mod, "_headers", return_value={"Authorization": "Bearer x"}):
            inst = vast_mod.get_instance(42)

    assert inst["id"] == 42
    mock_client.get.assert_called_once()
    called_url = mock_client.get.call_args.args[0]
    assert called_url.endswith("/instances/42/")
    assert "owner" not in (mock_client.get.call_args.kwargs.get("params") or {})


def test_wait_for_ssh_fails_on_terminal_status() -> None:
    from lelab.jobs import TrainingMetrics
    from lelab.runners.vast import VastJobRunner
    from pathlib import Path

    runner = VastJobRunner(TrainingMetrics(), Path("/tmp/vast-test.log"), offer_id=1)
    runner._instance_id = 99

    with patch(
        "lelab.runners.vast.get_instance",
        return_value={"id": 99, "actual_status": "exited", "status_msg": "boom"},
    ):
        with pytest.raises(RuntimeError, match="terminal status"):
            runner._wait_for_ssh(timeout_s=1)


def test_wait_for_ssh_returns_when_running() -> None:
    from lelab.jobs import TrainingMetrics
    from lelab.runners.vast import VastJobRunner
    from pathlib import Path

    runner = VastJobRunner(TrainingMetrics(), Path("/tmp/vast-test.log"), offer_id=1)
    runner._instance_id = 7

    with patch(
        "lelab.runners.vast.get_instance",
        return_value={
            "id": 7,
            "actual_status": "running",
            "public_ipaddr": "10.0.0.1",
            "ssh_port": 22022,
            "dph_total": 0.5,
        },
    ):
        ssh = runner._wait_for_ssh(timeout_s=5)

    assert ssh == {"host": "10.0.0.1", "port": 22022, "dph_total": 0.5}
