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
import time
from pathlib import Path

from . import config, sessions

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
        log.exception("session %s: demo.py failed", session_id)
        state.status = "failed"
        state.error = f"demo.py exit {e.returncode} — see {log_path}"
        sessions.save(state)
        return

    state.status = "done"
    sessions.save(state)
    log.info("session %s: done — outputs in %s", session_id, output_dir)


def main() -> None:
    config.ensure_dirs()
    _check_environment()
    log.info(
        "runner up. frames=%s outputs=%s mode=%s",
        config.FRAMES_DIR,
        config.OUTPUTS_DIR,
        config.LINGBOT_MODE,
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
