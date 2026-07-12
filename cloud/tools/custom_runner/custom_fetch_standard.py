import argparse
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path


FETCH_SCRIPT = Path(__file__).resolve().parents[2] / "fetcher_core" / "fetch_worker.py"
CUSTOM_INPUT_ROOT = Path(__file__).resolve().parents[2] / "custom" / "input"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch date-specific data into custom/input/<SITE>/<date>."
    )
    parser.add_argument(
        "--date",
        required=True,
        help="Target date in YYYY-MM-DD format.",
    )
    parser.add_argument(
        "--site",
        default=os.getenv("SITE_ID", "SIRMOUR"),
        help="Site ID",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        normalized_date = datetime.strptime(args.date, "%Y-%m-%d").strftime("%Y-%m-%d")
    except ValueError:
        print(f"Invalid --date '{args.date}'. Expected YYYY-MM-DD.", file=sys.stderr)
        return 2

    site_id = str(args.site or "").strip().upper()
    if not site_id:
        print("Empty --site provided.", file=sys.stderr)
        return 2

    if not FETCH_SCRIPT.exists():
        print(f"Fetcher script not found: {FETCH_SCRIPT}", file=sys.stderr)
        return 2

    CUSTOM_INPUT_ROOT.mkdir(parents=True, exist_ok=True)

    env = dict(os.environ)
    env["RUN_ONCE"] = "1"
    env["FETCH_BASE_DIR"] = str(CUSTOM_INPUT_ROOT)
    env["SITE_ID"] = site_id
    env["SITE_NAME"] = site_id
    env["FETCH_DATE"] = normalized_date
    env["FETCH_ALL_FORECAST_REVISIONS"] = "1"

    proc = subprocess.run(
        [sys.executable, str(FETCH_SCRIPT), "--site", site_id, "--date", normalized_date],
        env=env,
    )
    return proc.returncode


if __name__ == "__main__":
    raise SystemExit(main())

