"""Idempotent patch: add --save_dir to vendor/lingbot-map/demo.py.

demo.py is viewer-oriented and doesn't write predictions to disk. We add a
small flag that pickles predictions.pt + images.pt + summary.json so the
inference runner (and the dashboard's /cloud endpoint) can pick them up.

The patch is applied to a clean copy of demo.py — if a previous patch is
detected and is out of date, the file is reset via `git checkout` before
re-applying. That way `replace()` anchors don't drift across upgrades.

Run after scripts/setup.sh:

    python scripts/patch_demo.py
"""
from __future__ import annotations

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor" / "lingbot-map"
DEMO = VENDOR / "demo.py"

# Bumped whenever the SAVE_BLOCK contents change. Embedded as a sentinel
# in the patched file so we can detect stale patches and re-apply.
PATCH_VERSION = 2

ARG_LINE = (
    f'parser.add_argument("--save_dir", type=str, default=None,\n'
    f'        help="Save predictions.pt + images.pt + summary.json here (lingbot_bridge patch v{PATCH_VERSION})")\n'
    f'    '
)

SAVE_BLOCK = f"""predictions, images_cpu = postprocess(predictions, images_for_post)
    if args.save_dir:  # lingbot_bridge patch v{PATCH_VERSION}
        import os as _os, json as _json
        _os.makedirs(args.save_dir, exist_ok=True)
        torch.save(predictions, _os.path.join(args.save_dir, "predictions.pt"))
        torch.save(images_cpu, _os.path.join(args.save_dir, "images.pt"))
        _summary = {{k: list(v.shape) if hasattr(v, "shape") else type(v).__name__ for k, v in predictions.items()}}
        _summary["num_frames"] = int(images_cpu.shape[0])
        _summary["images_shape"] = list(images_cpu.shape)
        with open(_os.path.join(args.save_dir, "summary.json"), "w") as _f:
            _json.dump(_summary, _f, indent=2)
        print(f"Saved predictions + images to {{args.save_dir}}")
"""

PATCH_MARKER = f"lingbot_bridge patch v{PATCH_VERSION}"


def _reset_demo_from_git() -> None:
    if not (VENDOR / ".git").exists():
        raise SystemExit(f"{VENDOR} is not a git checkout — re-run scripts/setup.sh")
    subprocess.run(
        ["git", "-C", str(VENDOR), "checkout", "--", "demo.py"],
        check=True,
    )
    print(f"reset demo.py from git")


def main() -> None:
    if not DEMO.exists():
        raise SystemExit(f"demo.py not found at {DEMO} — run scripts/setup.sh first")

    src = DEMO.read_text()

    if PATCH_MARKER in src:
        print(f"already patched (v{PATCH_VERSION})")
        return

    # Some older version of the patch is in there; reset before re-applying so
    # our anchors point at clean upstream source.
    if "args.save_dir" in src:
        print("detected outdated patch; resetting demo.py")
        _reset_demo_from_git()
        src = DEMO.read_text()

    needle_arg = 'parser.add_argument("--export_preprocessed"'
    if needle_arg not in src:
        raise SystemExit("could not find argparse anchor — demo.py changed upstream?")
    src = src.replace(needle_arg, ARG_LINE + needle_arg)

    needle_post = "predictions, images_cpu = postprocess(predictions, images_for_post)"
    if needle_post not in src:
        raise SystemExit("could not find postprocess anchor — demo.py changed upstream?")
    src = src.replace(needle_post, SAVE_BLOCK)

    DEMO.write_text(src)
    print(f"patched {DEMO} (v{PATCH_VERSION})")


if __name__ == "__main__":
    main()
