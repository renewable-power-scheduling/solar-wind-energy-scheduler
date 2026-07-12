from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

try:
    import boto3
except ImportError:  # pragma: no cover - Lambda image has boto3
    boto3 = None

from cloud.common.config_loader import load_site_config, normalize_site_id
from cloud.fetcher_core.fetch_worker import _build_remote_client

IST = ZoneInfo("Asia/Kolkata")
DEFAULT_SITES = ("KOTHAGUDEM", "KASIPET", "BHUPALPALLY", "OSEPL")
BUCKET = os.getenv("BUCKET", "").strip()
PLANT_ID = os.getenv("PLANT_ID", "vedanjay").strip() or "vedanjay"
WORK_ROOT = Path(os.getenv("WEEK_AHEAD_WORK_ROOT", "/tmp/week_ahead"))

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)
if not logger.handlers:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")


def _s3_client():
    if not BUCKET:
        raise RuntimeError("BUCKET env var is required for week-ahead downloads")
    if boto3 is None:
        raise RuntimeError("boto3 is required for week-ahead downloads")
    return boto3.client("s3")


def _run_date(event: dict[str, Any]) -> str:
    raw = str(event.get("run_date") or os.getenv("RUN_DATE", "")).strip()
    if raw:
        datetime.strptime(raw, "%Y-%m-%d")
        return raw
    return datetime.now(IST).strftime("%Y-%m-%d")


def _sites(event: dict[str, Any]) -> list[str]:
    raw = event.get("sites") or os.getenv("WEEK_AHEAD_SITES", "")
    if isinstance(raw, str) and raw.strip():
        tokens = [item.strip() for item in raw.split(",")]
    elif isinstance(raw, list):
        tokens = [str(item).strip() for item in raw]
    else:
        tokens = list(DEFAULT_SITES)
    out: list[str] = []
    for token in tokens:
        if not token:
            continue
        site_id = normalize_site_id(token)
        if site_id not in DEFAULT_SITES:
            logger.warning("Ignoring unsupported week-ahead site: %s", site_id)
            continue
        if site_id not in out:
            out.append(site_id)
    return out


def _compile_pattern(pattern: str, run_date: str) -> re.Pattern[str]:
    next_date = (datetime.strptime(run_date, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
    templated = pattern.replace("{current_date}", run_date).replace("{next_date}", next_date)
    return re.compile(templated, re.IGNORECASE)


def _sort_value(match: re.Match[str], name: str) -> tuple[int, str]:
    groups = match.groupdict()
    hh = groups.get("hh")
    mm = groups.get("mm")
    if hh is not None and mm is not None:
        try:
            return (int(hh) * 60 + int(mm), name)
        except ValueError:
            pass
    return (0, name)


def _metadata_payload(*, site_id: str, run_date: str, filename: str, remote_path: str, action: str) -> dict[str, Any]:
    now_ist = datetime.now(IST).isoformat()
    return {
        "site_id": site_id,
        "run_date": run_date,
        "forecast_type": "week_ahead",
        "filename": filename,
        "remote_path": remote_path,
        "action": action,
        "recorded_at_ist": now_ist,
    }


def _download_site(site_id: str, run_date: str, s3) -> dict[str, Any]:
    cfg = load_site_config(site_id)
    patterns = cfg.get("file_patterns", {}) if isinstance(cfg, dict) else {}
    pattern = str(patterns.get("week_ahead_filename_regex") or "").strip()
    if not pattern:
        return {"site_id": site_id, "ok": False, "reason": "missing_week_ahead_filename_regex"}

    remote_dir = str(((cfg.get("paths") or {}).get("remote_forecasts")) or "").strip()
    if not remote_dir:
        return {"site_id": site_id, "ok": False, "reason": "missing_remote_forecasts_path"}

    regex = _compile_pattern(pattern, run_date)
    client = _build_remote_client(cfg)
    try:
        names = client.list_names(remote_dir)
        matches: list[tuple[tuple[int, str], str, re.Match[str]]] = []
        for name in names:
            m = regex.search(str(name))
            if m:
                matches.append((_sort_value(m, str(name)), str(name), m))
        if not matches:
            return {"site_id": site_id, "ok": True, "downloaded": 0, "skipped_existing": 0, "matches": 0}

        matches.sort(key=lambda item: item[0])
        selected_name = matches[-1][1]
        remote_path = f"{remote_dir.rstrip('/')}/{selected_name}"
        s3_key = f"raw/{PLANT_ID}/{site_id}/{run_date}/enercast_data/week_ahead/{selected_name}"
        meta_key = f"{s3_key}.meta.json"

        try:
            s3.head_object(Bucket=BUCKET, Key=s3_key)
            exists = True
        except Exception:
            exists = False

        if exists:
            metadata = _metadata_payload(
                site_id=site_id,
                run_date=run_date,
                filename=selected_name,
                remote_path=remote_path,
                action="skipped_existing_s3",
            )
            s3.put_object(Bucket=BUCKET, Key=meta_key, Body=json.dumps(metadata, indent=2).encode("utf-8"))
            return {
                "site_id": site_id,
                "ok": True,
                "downloaded": 0,
                "skipped_existing": 1,
                "matches": len(matches),
                "filename": selected_name,
                "s3_key": s3_key,
            }

        local_path = WORK_ROOT / site_id / run_date / selected_name
        local_path.parent.mkdir(parents=True, exist_ok=True)
        client.download(remote_path, local_path)
        s3.upload_file(str(local_path), BUCKET, s3_key)
        metadata = _metadata_payload(
            site_id=site_id,
            run_date=run_date,
            filename=selected_name,
            remote_path=remote_path,
            action="downloaded",
        )
        try:
            metadata["size_bytes"] = local_path.stat().st_size
        except Exception:
            pass
        s3.put_object(Bucket=BUCKET, Key=meta_key, Body=json.dumps(metadata, indent=2).encode("utf-8"))
        return {
            "site_id": site_id,
            "ok": True,
            "downloaded": 1,
            "skipped_existing": 0,
            "matches": len(matches),
            "filename": selected_name,
            "s3_key": s3_key,
        }
    finally:
        try:
            client.close()
        except Exception:
            logger.exception("Failed to close remote client for site=%s", site_id)


def run(event: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = dict(event or {})
    run_date = _run_date(payload)
    selected_sites = _sites(payload)
    s3 = _s3_client()

    results: list[dict[str, Any]] = []
    for site_id in selected_sites:
        try:
            result = _download_site(site_id, run_date, s3)
        except Exception as exc:
            logger.exception("Week-ahead download failed for site=%s date=%s", site_id, run_date)
            result = {"site_id": site_id, "ok": False, "error": str(exc)}
        results.append(result)

    ok = all(bool(item.get("ok")) for item in results)
    return {
        "ok": ok,
        "run_date": run_date,
        "sites": selected_sites,
        "downloaded": sum(int(item.get("downloaded") or 0) for item in results),
        "skipped_existing": sum(int(item.get("skipped_existing") or 0) for item in results),
        "results": results,
    }


def main() -> int:
    result = run({})
    print(json.dumps(result, indent=2, default=str))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
