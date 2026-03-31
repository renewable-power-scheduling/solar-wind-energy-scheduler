import argparse
import os
import subprocess
import sys
from pathlib import Path

from utils.site_config_loader import list_site_ids


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Run unified fetcher for all configured sites")
    p.add_argument("--date", default=None, help="Optional date YYYY-MM-DD")
    p.add_argument("--run-once", action="store_true", help="Run once per site and exit")
    return p.parse_args()


def main() -> int:
    args = _parse_args()
    root = Path(__file__).resolve().parent
    fetcher = root / "Data loader" / "Fetchdata.py"
    env = dict(os.environ)

    sites = list_site_ids()
    if not sites:
        print("No site configs found under config/sites", file=sys.stderr)
        return 2

    rc = 0
    for site in sites:
        cmd = [sys.executable, str(fetcher), "--site", site]
        if args.date:
            cmd.extend(["--date", args.date])
        if args.run_once:
            cmd.append("--run-once")

        print(f"[fetch] site={site}")
        proc = subprocess.run(cmd, env=env)
        if proc.returncode != 0:
            rc = proc.returncode
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
