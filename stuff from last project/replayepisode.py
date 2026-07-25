import time

from lerobot.datasets import LeRobotDataset
from lerobot.robots.so_follower import SO101Follower, SO101FollowerConfig
from lerobot.utils.robot_utils import precise_sleep
from lerobot.utils.utils import log_say
from pathlib import Path


CONFIG_DIR = Path("/Users/seth/Docs/Summer Robotics/lerobot-project/configs")


episode_idx = 2

robot_config = SO101FollowerConfig(
    port="/dev/tty.usbmodem5B8E1155691",
    id="my_awesome_follower_arm",
    calibration_dir=CONFIG_DIR,
)

robot = SO101Follower(robot_config)
robot.connect()

dataset = LeRobotDataset("mr-mph/lerobot-testing", episodes=[episode_idx])
actions = dataset.select_columns("action")

log_say(f"Replaying episode {episode_idx}")
for idx in range(dataset.num_frames):
    t0 = time.perf_counter()

    action = {
        name: float(actions[idx]["action"][i])
        for i, name in enumerate(dataset.features["action"]["names"])
    }
    robot.send_action(action)

    precise_sleep(max(1.0 / dataset.fps - (time.perf_counter() - t0), 0.0))

robot.disconnect()
