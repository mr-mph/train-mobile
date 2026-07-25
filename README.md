# train-mobile

Phone-first LeLab for SO-101 arms: run the robot host on a Mac, control everything from an iPhone PWA over a Cloudflare Tunnel.

Forked from [LeLab](https://github.com/huggingface/leLab) / [LeRobot](https://github.com/huggingface/lerobot). Goal: configure → teleop/record → edit dataset → train on Vast.ai → rollout → save models — all from the phone.

## Architecture

| Piece                                    | Where                   |
| ---------------------------------------- | ----------------------- |
| Arms + USB cameras + OpenCV + filesystem | Mac                     |
| FastAPI (`lelab`) + Vite UI              | Mac (`localhost`)       |
| Touch UI / PWA                           | iPhone Safari           |
| Reach phone                              | Cloudflare Tunnel → Mac |

Cameras stay on the Mac and stream to the browser (MJPEG). The phone is remote control only — it does not use its camera.

**Defaults:** cameras **640×480 @ 15 fps**, configs seeded from `[stuff from last project/](stuff%20from%20last%20project/)`.

## Product loop (phone)

1. **Configure / calibrate** both arms
2. **Teleoperate + record** episodes (start/stop on phone)
3. **Visualize / edit** dataset (trim, remove episodes)
4. **Train** — pick a Vast.ai GPU, watch loss + spend on phone (no W&B required)
5. **Rollout** on the follower
6. **Resume training** if needed, or **save the model** (with an episode thumbnail)

Hugging Face Jobs remain optional; Vast is the primary cloud train path.

## Cameras (Mac → browser)

Previews stream from the Mac via MJPEG (`GET /cameras/{index}/mjpeg`), not the phone/browser camera. Defaults: **640×480 @ 15 fps**. Before record/rollout the server releases preview captures (`POST /cameras/preview/stop`).

On teleop: open the Cameras panel and switch **On**.


- macOS with SO-101 leader/follower + USB cameras
- [uv](https://docs.astral.sh/uv/)
- Node.js / npm (for `lelab --dev`)
- `ffmpeg` (`brew install ffmpeg`)
- Optional: [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) for phone access
- Tokens in `.env` (do not commit): `HF_TOKEN`, `VAST_API_KEY`

## Install with uv

```bash
cd /Users/seth/Docs/Github/train-mobile

# Skip broken Git LFS test artifacts when pulling lerobot@v0.6.0
GIT_LFS_SKIP_SMUDGE=1 uv tool install --editable . --python 3.12 --force

# Once, if `lelab` is not found
uv tool update-shell
```

### How “entering” uv works

`uv tool install` does **not** use `conda activate` / `source .venv`. It puts `lelab` on your PATH in uv’s tool bin dir. After install (and `uv tool update-shell` / new shell):

```bash
which lelab
lelab --dev
```

Useful commands:

```bash
uv tool list                 # see installed tools
uv tool dir --bin            # where the `lelab` shim lives
uv tool uninstall LeLab      # remove the tool env
```

**Project venv instead of a global tool** (optional):

```bash
uv venv --python 3.12
source .venv/bin/activate    # this is the “enter the env” step for a venv
GIT_LFS_SKIP_SMUDGE=1 uv pip install -e .
lelab --dev
```

Or without activating: `uv run lelab --dev`.

## Run (hot reload)

```bash
lelab --dev
```

- Frontend (Vite HMR): [http://127.0.0.1:8080](http://127.0.0.1:8080)
- API (uvicorn `--reload`): [http://127.0.0.1:8000](http://127.0.0.1:8000)

Production-style (serves built `frontend/dist` on `:8000` only):

```bash
lelab
```

Stuck ports:

```bash
lelab --stop
```

## Phone access (Cloudflare Tunnel)

With `--dev`, tunnel the Vite origin:

```bash
cloudflared tunnel --url http://127.0.0.1:8080
```

With production `lelab`:

```bash
cloudflared tunnel --url http://127.0.0.1:8000
```

Open the `*.trycloudflare.com` HTTPS URL on the iPhone; Add to Home Screen for PWA use (once the PWA bits land).

## Planned features (this fork)

- Server-side camera streams to the mobile UI
- Mobile-first existing LeLab pages + PWA
- Dataset viewer/editor (synced video + charts; trim; delete episodes)
- Vast.ai GPU picker, live loss from the train script, pause/resume, spend monitor
- Model library on the Mac with episode-start thumbnails
- Seed working `seth-bot` calibration/ports from last project

See the project plan for implementation detail. Upstream LeLab docs: [CLAUDE.md](CLAUDE.md).

## License

Apache-2.0 — see [LICENSE](LICENSE).
