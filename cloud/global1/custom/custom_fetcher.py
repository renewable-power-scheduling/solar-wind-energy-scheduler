import argparse
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path


FETCH_SCRIPT = Path("Data loader") / "Fetchdata.py"
CUSTOM_INPUT_ROOT = Path("custom") / "input"


def parse_args():
    parser = argparse.ArgumentParser(
        description="Fetch date-specific data into custom/input/<SITE>/<date>."
    )
    parser.add_argument(
        "--date",
        required=True,
        help="Target date in YYYY-MM-DD format.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        datetime.strptime(args.date, "%Y-%m-%d")
    except ValueError:
        print(f"Invalid --date '{args.date}'. Expected YYYY-MM-DD.", file=sys.stderr)
        return 2

    if not FETCH_SCRIPT.exists():
        print(f"Fetcher script not found: {FETCH_SCRIPT}", file=sys.stderr)
        return 2

    CUSTOM_INPUT_ROOT.mkdir(parents=True, exist_ok=True)

    env = dict(os.environ)
    env["RUN_ONCE"] = "1"
    env["FETCH_BASE_DIR"] = str(CUSTOM_INPUT_ROOT)

    proc = subprocess.run(
        [sys.executable, str(FETCH_SCRIPT), "--date", args.date],
        env=env,
    )
    return proc.returncode


if __name__ == "__main__":
    raise SystemExit(main())
