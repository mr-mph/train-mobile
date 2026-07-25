from lerobot.teleoperators.so_leader import SO101LeaderConfig, SO101Leader
from lerobot.robots.so_follower import SO101FollowerConfig, SO101Follower
from lerobot.cameras.opencv import OpenCVCameraConfig
from pathlib import Path

CONFIG_DIR = Path("/Users/seth/Docs/Summer Robotics/lerobot-project/configs")

camera_config = {
    "gripper": OpenCVCameraConfig(index_or_path=0, width=1920, height=1080, fps=30),
    "overhead": OpenCVCameraConfig(index_or_path=1, width=1920, height=1080, fps=30),
}


robot_config = SO101FollowerConfig(
    port="/dev/tty.usbmodem5B8E1155691",
    id="my_awesome_follower_arm",
    calibration_dir=CONFIG_DIR,
    cameras=camera_config,
)

teleop_config = SO101LeaderConfig(
    port="/dev/tty.usbmodem5B790176171",
    id="my_awesome_leader_arm",
    calibration_dir=CONFIG_DIR,
)

robot = SO101Follower(robot_config)
teleop_device = SO101Leader(teleop_config)
robot.connect()
teleop_device.connect()

while True:
    action = teleop_device.get_action()
    robot.send_action(action)
