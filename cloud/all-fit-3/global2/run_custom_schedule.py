import argparse
import os
import subprocess
import sys
from pathlib import Path


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Run custom schedule generation for a site")
    p.add_argument("--site", required=True, help="Site ID, e.g. SIRMOUR/GSNP")
    p.add_argument("--date", required=True, help="Data date YYYY-MM-DD")
    p.add_argument("--start-block", required=True, type=int, help="Engine start block (1..96)")
    p.add_argument("--data-root", default=None, help="Optional data root override")
    p.add_argument("--output-root", default=None, help="Optional output root override")
    return p.parse_args()


def main() -> int:
    args = _parse_args()
    root = Path(__file__).resolve().parent
    engine_script = root / "run_phase9_engine.py"

    env = dict(os.environ)
    env["SITE_ID"] = args.site.upper()
    env["CUSTOM_START_BLOCK"] = str(args.start_block)
    env["DATA_DATE"] = args.date
    env["SKIP_FETCHER"] = "1"
    if args.data_root:
        env["DATA_ROOT"] = args.data_root
    if args.output_root:
        env["OUTPUT_ROOT"] = args.output_root

    proc = subprocess.run([sys.executable, str(engine_script)], env=env)
    return proc.returncode


if __name__ == "__main__":
    raise SystemExit(main())
