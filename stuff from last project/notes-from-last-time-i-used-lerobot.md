followed:
[https://huggingface.co/docs/lerobot/main/en/so101](https://huggingface.co/docs/lerobot/main/en/so101)
[https://huggingface.co/docs/lerobot/main/en/getting_started_real_world_robot](https://huggingface.co/docs/lerobot/main/en/getting_started_real_world_robot)

full lerobot install script:

```sh
wget "https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-$(uname)-$(uname -m).sh"
bash Miniforge3-$(uname)-$(uname -m).sh
conda create -y -n lerobot python=3.12
conda activate lerobot
conda install ffmpeg -c conda-forge
git clone https://github.com/huggingface/lerobot.git
cd lerobot
pip install -e .
cd ..
pip install 'lerobot[feetech]'
```

activate cmd: `conda activate lerobot`

ran: `lerobot-find-port`
follower tty: `/dev/tty.usbmodem5B8E1155691`
leader tty: `/dev/tty.usbmodem5B790176171`

setup follower servos:

```sh
lerobot-setup-motors \
--robot.type=so101_follower \
--robot.port=/dev/tty.usbmodem5B8E1155691
```

setup leader servos:

```sh
lerobot-setup-motors \
--teleop.type=so101_leader \
--teleop.port=/dev/tty.usbmodem5B790176171
```

calibrater follower:

```sh
lerobot-calibrate \
--robot.type=so101_follower \
--robot.port=/dev/tty.usbmodem5B8E1155691 \
--robot.id=my_awesome_follower_arm
```

follower data:

```
-------------------------------------------
NAME            |    MIN |    POS |    MAX
shoulder_pan    |   1085 |   2035 |   3389
shoulder_lift   |    841 |    847 |   3184
elbow_flex      |    876 |   3090 |   3092
wrist_flex      |    828 |   2841 |   3109
gripper         |   1794 |   1795 |   3232
```

calibrate leader:

```sh
lerobot-calibrate \
--teleop.type=so101_leader \
--teleop.port=/dev/tty.usbmodem5B790176171 \
--teleop.id=my_awesome_leader_arm
```

leader data:

```
-------------------------------------------
NAME            |    MIN |    POS |    MAX
shoulder_pan    |    779 |   1918 |   3470
shoulder_lift   |    802 |    819 |   3164
elbow_flex      |    927 |   3141 |   3151
wrist_flex      |    855 |   2548 |   3141
gripper         |   1798 |   1808 |   3022
```

teleop command:

```sh
lerobot-teleoperate \
--robot.type=so101_follower \
--robot.port=/dev/tty.usbmodem5B8E1155691 \
--robot.id=my_awesome_follower_arm \
--teleop.type=so101_leader \
--teleop.port=/dev/tty.usbmodem5B790176171 \
--teleop.id=my_awesome_leader_arm
```

find cameras:
`lerobot-find-cameras opencv`

```
--- Detected Cameras ---
Camera #0:
  Name: OpenCV Camera @ 0
  Type: OpenCV
  Id: 0
  Backend api: AVFOUNDATION
  Default stream profile:
    Format: 16.0
    Fourcc:
    Width: 1920
    Height: 1080
    Fps: 5.0
--------------------
Camera #1:
  Name: OpenCV Camera @ 1
  Type: OpenCV
  Id: 1
  Backend api: AVFOUNDATION
  Default stream profile:
    Format: 16.0
    Fourcc:
    Width: 1920
    Height: 1080
    Fps: 25.0
--------------------
Camera #2:
  Name: OpenCV Camera @ 2
  Type: OpenCV
  Id: 2
  Backend api: AVFOUNDATION
  Default stream profile:
    Format: 16.0
    Fourcc:
    Width: 1920
    Height: 1080
    Fps: 60.0
--------------------
Camera #3:
  Name: OpenCV Camera @ 3
  Type: OpenCV
  Id: 3
  Backend api: AVFOUNDATION
  Default stream profile:
    Format: 16.0
    Fourcc:
    Width: 1920
    Height: 1080
    Fps: 24.0
--------------------
Camera #4:
  Name: OpenCV Camera @ 4
  Type: OpenCV
  Id: 4
  Backend api: AVFOUNDATION
  Default stream profile:
    Format: 16.0
    Fourcc:
    Width: 1280
    Height: 720
    Fps: 30.0
--------------------
```

# training

to create a dataset run: `python createdataset.py`

- use left arrow to reset current episode
- use right arrow to finish current episode

upload dataset to huggingface with:

`hf auth login` (key: <HF_TOKEN>)

```sh
hf upload mr-mph/lerobot-testing ~/.cache/huggingface/lerobot/mr-mph/lerobot-testing --repo-type dataset
```

if it isn't tagged, tag it with `python tagdataset.py`

and visualize it in [https://huggingface.co/spaces/lerobot/visualize_dataset](https://huggingface.co/spaces/lerobot/visualize_dataset)

replay a certain episode with `python replayepisode.py`

to train an act model on mac run:

```sh
lerobot-train \
  --dataset.repo_id=mr-mph/lerobot-testing \
  --policy.type=act \
  --output_dir=outputs/train/act-so101-test \
  --job_name=act-so101-test \
  --policy.device=mps \
  --wandb.enable=true \
  --policy.repo_id=mr-mph/act-so101-test \
  --batch_size=8 \
  --steps=20000
```

(mps for mac gpu, cuda for nvidia)

sign into wandb with: `wandb login` (key: <WANDB_API_KEY>)

run on hugginface hardware:

- check available gpus with `hf jobs hardware`

```sh
lerobot-train \
  --dataset.repo_id=mr-mph/lerobot-testing \
  --policy.type=act \
  --output_dir=outputs/train/act-so101-test \
  --job_name=act-so101-test \
  --policy.device=cuda \
  --wandb.enable=true \
  --policy.repo_id=mr-mph/act-so101-test \
  --batch_size=8 \
  --steps=20000 \
  --job.target=a10g-small
```

check on it with

```sh
hf jobs logs <job-id>
hf jobs cancel <job-id>
```

to run that on google colab use [https://colab.research.google.com/github/huggingface/notebooks/blob/main/lerobot/training-act.ipynb](https://colab.research.google.com/github/huggingface/notebooks/blob/main/lerobot/training-act.ipynb#scrollTo=riBSIGoFw9iZ)

to run it in vast.ai, run: `vastai search offers`
find offer, then:

```sh
vastai create instance <OFFER_ID> --image huggingface/lerobot-gpu:latest --env '-e WANDB_API_KEY=<WANDB_API_KEY> -e HF_TOKEN=<HF_TOKEN>' --onstart-cmd 'lerobot-train \;--dataset.repo_id=mr-mph/lerobot-testing \;--policy.type=act \;--output_dir=outputs/train/act-so101-test \;--job_name=act-so101-test \;--policy.device=mps \;--wandb.enable=true \;--policy.repo_id=mr-mph/act-so101-test-2 \;--batch_size=8 \;--steps=20000' --disk 8 --jupyter --ssh --direct

```

# lelab

install:

```sh
git clone https://github.com/huggingface/leLab.git
cd leLab
pip install -e .
cd ..
```

set configs for lelab:

```sh
cp configs/seth-bot.json  ~/.cache/huggingface/lerobot/robots/seth-bot.json
cp configs/my_awesome_follower_arm.json  ~/.cache/huggingface/lerobot/calibration/robots/so_follower/seth-bot.json
cp configs/my_awesome_leader_arm.json  ~/.cache/huggingface/lerobot/calibration/teleoperators/so_leader/seth-bot.json

```

then just run `lelab`
