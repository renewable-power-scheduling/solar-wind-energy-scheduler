from __future__ import annotations

import os
from pathlib import Path
from typing import Any

try:
    import boto3
except ImportError:
    boto3 = None

from cloud.common.intraday_revision import resolve_intraday_revision


def discover_latest_intraday_source(
    site_id: str,
    run_date: str,
    current_block: int,
) -> dict[str, Any] | None:
    bucket = str(os.getenv("BUCKET", "")).strip()
    plant_id = str(os.getenv("PLANT_ID", "vedanjay")).strip() or "vedanjay"
    if not bucket or boto3 is None:
        return None

    prefix = (
        f"raw/{plant_id}/{str(site_id).strip().upper()}/{run_date}/"
        "enercast_data/intraday/"
    )
    candidates: list[dict[str, Any]] = []
    paginator = boto3.client("s3").get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for item in page.get("Contents", []) or []:
            key = str(item.get("Key") or "").strip()
            if not key.lower().endswith(".csv"):
                continue
            name = Path(key).name
            revision_info = resolve_intraday_revision(site_id, name)
            if not revision_info:
                continue
            configured_block = revision_info.get("block")
            if configured_block is None or int(configured_block) > int(current_block):
                continue
            candidates.append(
                {
                    "name": name,
                    "s3_key": key,
                    "revision": int(revision_info["revision"]),
                    "configured_block": int(configured_block),
                    "last_modified": item.get("LastModified"),
                }
            )

    if not candidates:
        return None
    return max(
        candidates,
        key=lambda item: (
            int(item["revision"]),
            int(item["configured_block"]),
            str(item.get("last_modified") or ""),
        ),
    )
