# TrainMobile

Phone-first robot training for SO-101 arms. Run the host on a Mac; control teleop, datasets, Vast.ai training, and rollout from an iPhone PWA (Cloudflare Tunnel).

Forked from [LeLab](https://github.com/huggingface/leLab) / [LeRobot](https://github.com/huggingface/lerobot).

## Loop

1. Configure / calibrate  
2. Teleoperate + record (Mac cameras stream via MJPEG)  
3. Edit dataset (trim / remove episodes)  
4. Train — pick Vast GPU, watch loss + credit (no W&B required)  
5. Rollout → resume training or save model (with episode thumbnail)

## Install (uv)

```bash
cd train-mobile
GIT_LFS_SKIP_SMUDGE=1 uv tool install --editable . --python 3.12 --force
uv tool update-shell   # once if needed
```

`.env`: `HF_TOKEN`, `VAST_API_KEY` (optional `WANDB_API_KEY`).

Also: Node/npm, `ffmpeg` (`brew install ffmpeg`).

## Run

```bash
lelab --dev          # Vite :8000 (0.0.0.0) + API :8001 proxied (same origin)
# or
lelab                # single process on :8000
```

Phone on LAN: open `http://<mac-lan-ip>:8000` (dev or prod).

Tunnel (same for both modes):

```bash
cloudflared tunnel --url http://127.0.0.1:8000
```

Cameras default to **640×480 @ 15 fps**. `seth-bot` calib/ports are seeded from `stuff from last project/` on startup when missing.

## License

Apache-2.0 — see [LICENSE](LICENSE).
