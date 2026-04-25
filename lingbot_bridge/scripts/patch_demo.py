"""Idempotent patch: add --save_dir to vendor/lingbot-map/demo.py.

demo.py is viewer-oriented and doesn't write predictions to disk. We add a
small flag that pickles the predictions dict + a JSON summary so the
inference runner can pick them up after each session.

Run after scripts/setup.sh:

    python scripts/patch_demo.py
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEMO = ROOT / "vendor" / "lingbot-map" / "demo.py"

ARG_LINE = (
    'parser.add_argument("--save_dir", type=str, default=None,\n'
    '        help="Save predictions.pt + summary.json to this directory")\n'
    '    '
)

SAVE_BLOCK = """predictions, images_cpu = postprocess(predictions, images_for_post)
    if args.save_dir:
        import os as _os, json as _json
        _os.makedirs(args.save_dir, exist_ok=True)
        torch.save(predictions, _os.path.join(args.save_dir, "predictions.pt"))
        _summary = {k: list(v.shape) if hasattr(v, "shape") else type(v).__name__ for k, v in predictions.items()}
        _summary["num_frames"] = int(images_cpu.shape[0])
        with open(_os.path.join(args.save_dir, "summary.json"), "w") as _f:
            _json.dump(_summary, _f, indent=2)
        print(f"Saved predictions to {args.save_dir}")
"""


def main() -> None:
    if not DEMO.exists():
        raise SystemExit(f"demo.py not found at {DEMO} — run scripts/setup.sh first")

    src = DEMO.read_text()
    if "args.save_dir" in src:
        print("already patched")
        return

    needle_arg = 'parser.add_argument("--export_preprocessed"'
    if needle_arg not in src:
        raise SystemExit("could not find argparse anchor — demo.py changed upstream?")
    src = src.replace(needle_arg, ARG_LINE + needle_arg)

    needle_post = "predictions, images_cpu = postprocess(predictions, images_for_post)"
    if needle_post not in src:
        raise SystemExit("could not find postprocess anchor — demo.py changed upstream?")
    src = src.replace(needle_post, SAVE_BLOCK)

    DEMO.write_text(src)
    print(f"patched {DEMO}")


if __name__ == "__main__":
    main()
