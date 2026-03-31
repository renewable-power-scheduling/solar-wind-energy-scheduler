import argparse
import os
import subprocess
import sys
from pathlib import Path


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Run continuous schedule generation for a site")
    p.add_argument("--site", required=True, help="Site ID, e.g. SIRMOUR/GSNP")
    return p.parse_args()


def main() -> int:
    args = _parse_args()
    root = Path(__file__).resolve().parent
    runner_script = root / "run_phase9_continuous.py"

    env = dict(os.environ)
    env["SITE_ID"] = args.site.upper()
    proc = subprocess.run([sys.executable, str(runner_script)], env=env)
    return proc.returncode


if __name__ == "__main__":
    raise SystemExit(main())
