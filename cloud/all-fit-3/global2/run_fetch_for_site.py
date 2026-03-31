import argparse
import os
import subprocess
import sys
from pathlib import Path


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Run unified fetcher for one site")
    p.add_argument("--site", required=True, help="Site ID (e.g. SIRMOUR, GSNP)")
    p.add_argument("--date", default=None, help="Optional date YYYY-MM-DD")
    p.add_argument("--run-once", action="store_true", help="Run once and exit")
    return p.parse_args()


def main() -> int:
    args = _parse_args()
    root = Path(__file__).resolve().parent
    fetcher = root / "Data loader" / "Fetchdata.py"
    env = dict(os.environ)

    cmd = [sys.executable, str(fetcher), "--site", args.site]
    if args.date:
        cmd.extend(["--date", args.date])
    if args.run_once:
        cmd.append("--run-once")

    proc = subprocess.run(cmd, env=env)
    return proc.returncode


if __name__ == "__main__":
    raise SystemExit(main())
