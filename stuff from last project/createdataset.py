from lerobot.cameras.opencv import OpenCVCameraConfig
from lerobot.datasets.lerobot_dataset import LeRobotDataset
from lerobot.utils.feature_utils import hw_to_dataset_features
from lerobot.robots.so_follower import SO101Follower, SO101FollowerConfig
from lerobot.teleoperators.so_leader.config_so_leader import SO101LeaderConfig
from lerobot.teleoperators.so_leader.so_leader import SO101Leader
from lerobot.common.control_utils import init_keyboard_listener
from lerobot.utils.utils import log_say
from lerobot.utils.visualization_utils import init_rerun
from lerobot.scripts.lerobot_record import record_loop
from lerobot.processor import make_default_processors
from pathlib import Path


NUM_EPISODES = 5
FPS = 15
EPISODE_TIME_SEC = 60
RESET_TIME_SEC = 10
TASK_DESCRIPTION = "put block in bowl"
CONFIG_DIR = Path("/Users/seth/Docs/Summer Robotics/lerobot-project/configs")


def main():
    # Create robot configuration
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

    teleop_config = SO101LeaderConfig(
        port="/dev/tty.usbmodem5B790176171",
        id="my_awesome_leader_arm",
        calibration_dir=CONFIG_DIR,
    )

    # Initialize the robot and teleoperator
    robot = SO101Follower(robot_config)
    teleop = SO101Leader(teleop_config)

    # Configure the dataset features
    action_features = hw_to_dataset_features(robot.action_features, "action")
    obs_features = hw_to_dataset_features(robot.observation_features, "observation")
    dataset_features = {**action_features, **obs_features}

    # Create the dataset
    dataset = LeRobotDataset.create(
        repo_id="mr-mph/lerobot-testing",
        fps=FPS,
        features=dataset_features,
        robot_type=robot.name,
        use_videos=True,
        image_writer_threads=4,
    )

    # Initialize the keyboard listener and rerun visualization
    _, events = init_keyboard_listener()
    init_rerun(session_name="recording")

    # Connect the robot and teleoperator
    robot.connect()
    teleop.connect()

    # Create the required processors
    teleop_action_processor, robot_action_processor, robot_observation_processor = (
        make_default_processors()
    )

    episode_idx = 0
    while episode_idx < NUM_EPISODES and not events["stop_recording"]:
        log_say(f"Recording episode {episode_idx + 1} of {NUM_EPISODES}")

        record_loop(
            robot=robot,
            events=events,
            fps=FPS,
            teleop_action_processor=teleop_action_processor,
            robot_action_processor=robot_action_processor,
            robot_observation_processor=robot_observation_processor,
            teleop=teleop,
            dataset=dataset,
            control_time_s=EPISODE_TIME_SEC,
            single_task=TASK_DESCRIPTION,
            display_data=True,
        )

        # Reset the environment if not stopping or re-recording
        if not events["stop_recording"] and (
            episode_idx < NUM_EPISODES - 1 or events["rerecord_episode"]
        ):
            log_say("Reset the environment")
            record_loop(
                robot=robot,
                events=events,
                fps=FPS,
                teleop_action_processor=teleop_action_processor,
                robot_action_processor=robot_action_processor,
                robot_observation_processor=robot_observation_processor,
                teleop=teleop,
                control_time_s=RESET_TIME_SEC,
                single_task=TASK_DESCRIPTION,
                display_data=True,
            )

        if events["rerecord_episode"]:
            log_say("Re-recording episode")
            events["rerecord_episode"] = False
            events["exit_early"] = False
            dataset.clear_episode_buffer()
            continue

        dataset.save_episode()
        episode_idx += 1

    # finalize dataset
    log_say("Finalizing dataset...")
    dataset.finalize()
    # Clean up
    log_say("Stop recording")
    robot.disconnect()
    teleop.disconnect()
    dataset.push_to_hub()


if __name__ == "__main__":
    main()
