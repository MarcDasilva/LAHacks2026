"""Inference runner.

Polls the sessions directory and, for each session that has been closed
(either by /close or by going idle), runs the LingBot-Map demo against
its frames and writes outputs to outputs/<session_id>/.

This is intentionally a subprocess-shelling runner rather than an
in-process import — the lingbot-map repo evolves quickly and we want to
stay decoupled from any specific Python API version. If/when we need
per-frame streaming inference (vs. per-session), swap this for a direct
import of lingbot_map's model class.
"""
from __future__ import annotations

import logging
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from . import cloud_export, config, sessions, viser_server

log = logging.getLogger("inference_runner")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

POLL_SECONDS = 2.0


def _check_environment() -> None:
    if config.DISABLE_INFERENCE:
        log.warning("INGEST_DISABLE_INFERENCE=1 — runner will idle")
        return
    if not config.LINGBOT_REPO.exists():
        log.error("lingbot-map source not found at %s", config.LINGBOT_REPO)
        sys.exit(1)
    if not config.LINGBOT_MODEL_PATH.exists():
        log.error("checkpoint not found at %s", config.LINGBOT_MODEL_PATH)
        sys.exit(1)
    try:
        import torch  # type: ignore

        if not torch.cuda.is_available():
            log.error("CUDA not available — refusing to start (set INGEST_DISABLE_INFERENCE=1 to bypass)")
            sys.exit(1)
        log.info("CUDA OK: %s", torch.cuda.get_device_name(0))
    except ImportError:
        log.error("torch not importable")
        sys.exit(1)


def _build_demo_command(frames_dir: Path, output_dir: Path) -> list[str]:
    demo = config.LINGBOT_REPO / "demo.py"
    cmd = [
        sys.executable,
        str(demo),
        "--model_path",
        str(config.LINGBOT_MODEL_PATH),
        "--image_folder",
        str(frames_dir),
        "--save_dir",
        str(output_dir),
    ]
    if config.LINGBOT_MODE == "windowed":
        cmd += ["--mode", "windowed", "--window_size", str(config.LINGBOT_WINDOW_SIZE)]
    if config.MASK_SKY:
        cmd += ["--mask_sky"]
    if config.USE_SDPA:
        cmd += ["--use_sdpa"]
    return cmd


def _claim_idle_sessions() -> None:
    """Mark recording sessions as queued if they've gone idle.

    The iOS client may crash without calling /close; this stops sessions
    from being stuck forever.
    """
    now = time.time()
    for s in sessions.list_all():
        if s.status != "recording":
            continue
        if s.last_frame_at and now - s.last_frame_at > config.SESSION_IDLE_SECONDS:
            log.info("session %s idle for %.0fs — queuing", s.session_id, now - s.last_frame_at)
            s.status = "queued"
            s.closed_at = now
            sessions.save(s)


def _run_one(session_id: str) -> None:
    state = sessions.load(session_id)
    if state is None or state.status != "queued":
        return

    frames_dir = config.session_frames_dir(session_id)
    if not frames_dir.exists() or not any(frames_dir.iterdir()):
        log.warning("session %s has no frames, marking failed", session_id)
        state.status = "failed"
        state.error = "no frames"
        sessions.save(state)
        return

    output_dir = config.session_output_dir(session_id)
    output_dir.mkdir(parents=True, exist_ok=True)

    state.status = "reconstructing"
    sessions.save(state)
    viser_server.clear_session(session_id)

    # Forward-compatible streaming hook. If a future patch to demo.py writes
    # per-frame predictions to <output_dir>/streaming/frame_NNNN.pt during
    # inference, this watcher will push them to viser as they appear. Until
    # that patch lands, the dir simply stays empty and we fall through to the
    # post-subprocess replay below.
    streaming_dir = output_dir / "streaming"
    streaming_dir.mkdir(parents=True, exist_ok=True)
    stop_watcher = threading.Event()
    watcher = threading.Thread(
        target=_watch_streaming_dir,
        args=(session_id, streaming_dir, stop_watcher),
        daemon=True,
    )
    watcher.start()

    cmd = _build_demo_command(frames_dir, output_dir)
    log.info("session %s: running %s", session_id, " ".join(cmd))

    log_path = output_dir / "demo.log"
    try:
        with log_path.open("w") as logf:
            subprocess.run(
                cmd,
                cwd=str(output_dir),
                stdout=logf,
                stderr=subprocess.STDOUT,
                check=True,
                env={**os.environ, "PYTHONUNBUFFERED": "1"},
            )
    except subprocess.CalledProcessError as e:
        stop_watcher.set()
        log.exception("session %s: demo.py failed", session_id)
        state.status = "failed"
        state.error = f"demo.py exit {e.returncode} — see {log_path}"
        sessions.save(state)
        return
    finally:
        stop_watcher.set()

    # If the streaming watcher already pushed frames, the cloud is already
    # visible in viser and we just finalize. Otherwise replay predictions.pt
    # frame-by-frame into viser as a "good-enough" progressive reveal — still
    # much better than the single jump-cut the user had before.
    if viser_server.is_running() and not _watcher_pushed_frames(session_id):
        try:
            _replay_predictions_to_viser(session_id, output_dir)
        except Exception:
            log.exception("session %s: viser replay failed (non-fatal)", session_id)

    state.status = "done"
    sessions.save(state)
    log.info("session %s: done — outputs in %s", session_id, output_dir)


_pushed_counts: dict[str, int] = {}


def _watcher_pushed_frames(session_id: str) -> bool:
    return _pushed_counts.get(session_id, 0) > 0


def _watch_streaming_dir(
    session_id: str, streaming_dir: Path, stop: threading.Event
) -> None:
    """Watch for per-frame .pt files written by a (future) patched demo.py
    and push each to viser as it lands. File naming: frame_NNNN.pt with keys
    {depth, depth_conf?, extrinsic, intrinsic, image}. Tolerates partial keys
    by skipping frames that don't deserialize cleanly.
    """
    if not viser_server.is_running():
        return
    try:
        import torch  # type: ignore
    except ImportError:
        return

    seen: set[str] = set()
    while not stop.wait(0.25):
        try:
            for p in sorted(streaming_dir.glob("frame_*.pt")):
                if p.name in seen:
                    continue
                # Only process if file appears stable (size unchanged for one tick).
                size_a = p.stat().st_size
                time.sleep(0.05)
                if p.stat().st_size != size_a:
                    continue
                seen.add(p.name)
                try:
                    payload = torch.load(p, map_location="cpu", weights_only=False)
                    idx = int(p.stem.split("_")[1])
                    pts, col = cloud_export.process_frame(
                        payload["depth"],
                        payload["extrinsic"],
                        payload["intrinsic"],
                        payload["image"],
                        payload.get("depth_conf"),
                    )
                    viser_server.add_frame_points(session_id, idx, pts, col)
                    if "extrinsic" in payload and "intrinsic" in payload:
                        viser_server.add_camera_frustum(
                            session_id, idx,
                            payload["extrinsic"], payload["intrinsic"],
                        )
                    _pushed_counts[session_id] = _pushed_counts.get(session_id, 0) + 1
                except Exception:
                    log.exception("streaming frame %s failed", p)
        except Exception:
            log.exception("streaming watcher loop error")


def _replay_predictions_to_viser(session_id: str, output_dir: Path) -> None:
    """Post-inference fallback: load predictions.pt + images.pt and push points
    to viser frame-by-frame so the user sees a progressive build-up.

    True streaming happens via _watch_streaming_dir once demo.py is patched to
    emit per-frame artifacts. This replay keeps the streaming UX visible even
    without that patch.
    """
    import numpy as np  # type: ignore
    import torch  # type: ignore

    preds_path = output_dir / "predictions.pt"
    images_path = output_dir / "images.pt"
    if not preds_path.exists() or not images_path.exists():
        return

    preds = torch.load(preds_path, map_location="cpu", weights_only=False)
    images_t = torch.load(images_path, map_location="cpu", weights_only=False)

    depth = preds["depth"]
    if depth.ndim == 4 and depth.shape[-1] == 1:
        depth = depth.squeeze(-1)
    extr = preds["extrinsic"]
    intr = preds["intrinsic"]
    conf = preds.get("depth_conf")
    colors = images_t.permute(0, 2, 3, 1).contiguous()  # (N,H,W,3)

    n = depth.shape[0]
    log.info("session %s: replaying %d frames into viser", session_id, n)
    for i in range(n):
        pts, col = cloud_export.process_frame(
            np.asarray(depth[i]),
            np.asarray(extr[i]),
            np.asarray(intr[i]),
            np.asarray(colors[i]),
            np.asarray(conf[i]) if conf is not None else None,
        )
        viser_server.add_frame_points(session_id, i, pts, col)
        viser_server.add_camera_frustum(session_id, i, np.asarray(extr[i]), np.asarray(intr[i]))


def main() -> None:
    config.ensure_dirs()
    _check_environment()
    viser_server.start()
    log.info(
        "runner up. frames=%s outputs=%s mode=%s viser=%s",
        config.FRAMES_DIR,
        config.OUTPUTS_DIR,
        config.LINGBOT_MODE,
        "on" if viser_server.is_running() else "off",
    )

    while True:
        try:
            if not config.DISABLE_INFERENCE:
                _claim_idle_sessions()
                for s in sessions.list_all():
                    if s.status == "queued":
                        _run_one(s.session_id)
        except Exception:
            log.exception("runner loop error (continuing)")
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    # Surface a clearer error if the user runs `python bridge/inference_runner.py`
    # instead of `python -m bridge.inference_runner`.
    if __package__ is None:
        sys.stderr.write("run with: python -m bridge.inference_runner\n")
        sys.exit(2)
    main()
