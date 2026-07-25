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

"""Local LeRobot dataset viewer/editor helpers for TrainMobile."""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from .utils.config import _atomic_write_text

logger = logging.getLogger(__name__)


def _cache_root() -> Path:
    return Path(os.environ.get("HF_LEROBOT_HOME", "~/.cache/huggingface/lerobot")).expanduser()


def dataset_root(repo_id: str) -> Path:
    root = _cache_root() / repo_id
    if not (root / "meta" / "info.json").is_file():
        raise FileNotFoundError(f"Local dataset not found: {repo_id}")
    return root


def _edits_path(root: Path) -> Path:
    return root / "meta" / "trainmobile_edits.json"


def _load_edits(root: Path) -> dict[str, Any]:
    path = _edits_path(root)
    if not path.is_file():
        return {"deleted": [], "trims": {}}
    try:
        return json.loads(path.read_text())
    except Exception:
        return {"deleted": [], "trims": {}}


def _save_edits(root: Path, edits: dict[str, Any]) -> None:
    _atomic_write_text(str(_edits_path(root)), json.dumps(edits, indent=2))


def _read_info(root: Path) -> dict[str, Any]:
    return json.loads((root / "meta" / "info.json").read_text())


def _episode_table(root: Path):
    import pandas as pd
    import pyarrow.parquet as pq

    files = sorted((root / "meta" / "episodes").rglob("*.parquet"))
    if not files:
        return pd.DataFrame()
    tables = [pq.read_table(f) for f in files]
    import pyarrow as pa

    return pa.concat_tables(tables).to_pandas()


def get_dataset_meta(repo_id: str) -> dict[str, Any]:
    root = dataset_root(repo_id)
    info = _read_info(root)
    edits = _load_edits(root)
    deleted = set(int(x) for x in edits.get("deleted", []))
    trims = {str(k): v for k, v in (edits.get("trims") or {}).items()}

    image_keys = [
        k
        for k, v in (info.get("features") or {}).items()
        if isinstance(v, dict) and v.get("dtype") in ("video", "image")
    ]
    # Prefer observation.images.* keys
    cameras = [k.split(".")[-1] for k in image_keys if "images" in k]
    if not cameras:
        cameras = [k.split(".")[-1] for k in image_keys]

    episodes: list[dict[str, Any]] = []
    df = _episode_table(root)
    if not df.empty and "episode_index" in df.columns:
        for _, row in df.iterrows():
            ep = int(row["episode_index"])
            if ep in deleted:
                continue
            length = int(row.get("length", 0))
            trim = trims.get(str(ep))
            episodes.append(
                {
                    "episode_index": ep,
                    "length": length,
                    "tasks": row.get("tasks"),
                    "trim": trim,
                }
            )

    return {
        "repo_id": repo_id,
        "fps": info.get("fps"),
        "total_episodes": info.get("total_episodes"),
        "total_frames": info.get("total_frames"),
        "robot_type": info.get("robot_type"),
        "cameras": cameras,
        "image_keys": image_keys,
        "episodes": episodes,
        "deleted_count": len(deleted),
    }


def get_episode_video_info(repo_id: str, episode: int, camera: str) -> dict[str, Any]:
    root = dataset_root(repo_id)
    info = _read_info(root)
    image_keys = [
        k
        for k in (info.get("features") or {})
        if camera in k and ("images" in k or k.endswith(camera))
    ]
    if not image_keys:
        # try exact feature key
        key = f"observation.images.{camera}"
        if key not in (info.get("features") or {}):
            raise KeyError(f"Camera '{camera}' not found")
        image_key = key
    else:
        image_key = image_keys[0]

    df = _episode_table(root)
    row = df[df["episode_index"] == episode]
    if row.empty:
        raise KeyError(f"Episode {episode} not found")
    r = row.iloc[0]
    chunk = int(r[f"videos/{image_key}/chunk_index"])
    file_i = int(r[f"videos/{image_key}/file_index"])
    t0 = float(r[f"videos/{image_key}/from_timestamp"])
    t1 = float(r[f"videos/{image_key}/to_timestamp"])

    edits = _load_edits(root)
    trim = (edits.get("trims") or {}).get(str(episode))
    fps = float(info.get("fps") or 15)
    if trim:
        t0 = t0 + float(trim.get("start_frame", 0)) / fps
        end_f = trim.get("end_frame")
        if end_f is not None:
            t1 = float(r[f"videos/{image_key}/from_timestamp"]) + float(end_f) / fps

    rel = f"videos/{image_key}/chunk-{chunk:03d}/file-{file_i:03d}.mp4"
    path = root / rel
    if not path.is_file():
        raise FileNotFoundError(rel)
    return {
        "path": str(path),
        "from_timestamp": t0,
        "to_timestamp": t1,
        "fps": fps,
        "image_key": image_key,
    }


def get_episode_timeseries(repo_id: str, episode: int, max_points: int = 400) -> dict[str, Any]:
    root = dataset_root(repo_id)
    info = _read_info(root)
    df = _episode_table(root)
    row = df[df["episode_index"] == episode]
    if row.empty:
        raise KeyError(f"Episode {episode} not found")
    r = row.iloc[0]
    start = int(r["dataset_from_index"])
    end = int(r["dataset_to_index"])

    edits = _load_edits(root)
    trim = (edits.get("trims") or {}).get(str(episode))
    if trim:
        start = start + int(trim.get("start_frame", 0))
        if trim.get("end_frame") is not None:
            start0 = int(r["dataset_from_index"])
            end = start0 + int(trim["end_frame"])

    import pandas as pd
    import pyarrow.parquet as pq

    data_files = sorted((root / "data").rglob("*.parquet"))
    frames: list[pd.DataFrame] = []
    for f in data_files:
        table = pq.read_table(f)
        pdf = table.to_pandas()
        if "index" not in pdf.columns:
            continue
        chunk = pdf[(pdf["index"] >= start) & (pdf["index"] < end)]
        if not chunk.empty:
            frames.append(chunk)
    if not frames:
        return {"episode_index": episode, "fps": info.get("fps"), "points": []}
    data = pd.concat(frames, ignore_index=True).sort_values("index")

    # Downsample
    if len(data) > max_points:
        step = max(1, len(data) // max_points)
        data = data.iloc[::step]

    points = []
    for _, fr in data.iterrows():
        action = fr.get("action")
        state = fr.get("observation.state")
        points.append(
            {
                "frame": int(fr.get("frame_index", fr["index"] - start)),
                "timestamp": float(fr.get("timestamp", 0)),
                "action": action.tolist() if hasattr(action, "tolist") else action,
                "state": state.tolist() if hasattr(state, "tolist") else state,
            }
        )
    return {"episode_index": episode, "fps": info.get("fps"), "points": points}


class TrimBody(BaseModel):
    start_frame: int = Field(ge=0)
    end_frame: int = Field(ge=1)


def delete_episode(repo_id: str, episode: int) -> dict[str, Any]:
    root = dataset_root(repo_id)
    edits = _load_edits(root)
    deleted = set(int(x) for x in edits.get("deleted", []))
    deleted.add(int(episode))
    edits["deleted"] = sorted(deleted)
    trims = edits.get("trims") or {}
    trims.pop(str(episode), None)
    edits["trims"] = trims
    _save_edits(root, edits)
    return {"success": True, "deleted": sorted(deleted)}


def trim_episode(repo_id: str, episode: int, body: TrimBody) -> dict[str, Any]:
    if body.end_frame <= body.start_frame:
        raise ValueError("end_frame must be greater than start_frame")
    root = dataset_root(repo_id)
    edits = _load_edits(root)
    if int(episode) in set(int(x) for x in edits.get("deleted", [])):
        raise ValueError("Episode is deleted")
    trims = edits.get("trims") or {}
    trims[str(episode)] = {"start_frame": body.start_frame, "end_frame": body.end_frame}
    edits["trims"] = trims
    _save_edits(root, edits)
    return {"success": True, "episode_index": episode, "trim": trims[str(episode)]}


def kept_episode_indices(repo_id: str) -> list[int]:
    meta = get_dataset_meta(repo_id)
    return [e["episode_index"] for e in meta["episodes"]]


def extract_thumbnail(repo_id: str, episode: int = 0, camera: str | None = None) -> Path:
    """Grab first frame of an episode camera as JPEG under /tmp for model save."""
    import cv2

    meta = get_dataset_meta(repo_id)
    cams = meta["cameras"]
    if not cams:
        raise RuntimeError("Dataset has no cameras")
    cam = camera or cams[0]
    info = get_episode_video_info(repo_id, episode, cam)
    cap = cv2.VideoCapture(info["path"])
    # Seek roughly to from_timestamp
    fps = float(info["fps"] or 15)
    frame_i = int(info["from_timestamp"] * fps)
    cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, frame_i))
    ok, frame = cap.read()
    cap.release()
    if not ok or frame is None:
        raise RuntimeError("Could not read thumbnail frame")
    out = Path("/tmp") / f"trainmobile_thumb_{repo_id.replace('/', '_')}_{episode}.jpg"
    cv2.imwrite(str(out), frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
    return out
