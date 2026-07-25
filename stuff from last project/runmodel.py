from lerobot.rollout import BaseStrategyConfig, RolloutConfig, build_rollout_context
from lerobot.rollout.inference import SyncInferenceConfig
from lerobot.rollout.strategies import BaseStrategy
from lerobot.cameras.opencv import OpenCVCameraConfig
from lerobot.robots.so_follower import SO101FollowerConfig
from lerobot.utils.process import ProcessSignalHandler
from lerobot.configs import PreTrainedConfig

from pathlib import Path

FPS = 15
DURATION = 60

CONFIG_DIR = Path("/Users/seth/Docs/Summer Robotics/lerobot-project/configs")
HF_MODEL_ID = "mr-mph/act-so101-test-2"  # or a local path like "outputs/train/act_so101/checkpoints/last"


camera_config = {
    "gripper": OpenCVCameraConfig(index_or_path=0, width=640, height=480, fps=30),
    "overhead": OpenCVCameraConfig(index_or_path=1, width=640, height=480, fps=30),
}

robot_config = SO101FollowerConfig(
    port="/dev/tty.usbmodem5B8E1155691",
    id="my_awesome_follower_arm",
    calibration_dir=CONFIG_DIR,
    cameras=camera_config,
)

policy_config = PreTrainedConfig.from_pretrained(HF_MODEL_ID)
policy_config.pretrained_path = HF_MODEL_ID

cfg = RolloutConfig(
    robot=robot_config,
    policy=policy_config,
    strategy=BaseStrategyConfig(),
    inference=SyncInferenceConfig(),
    fps=FPS,
    duration=DURATION,
    task="put block in bowl",
)

signal_handler = ProcessSignalHandler(use_threads=True)
ctx = build_rollout_context(
    cfg,
    signal_handler.shutdown_event,
)

strategy = BaseStrategy(cfg.strategy)
try:
    strategy.setup(ctx)
    strategy.run(ctx)
finally:
    strategy.teardown(ctx)
