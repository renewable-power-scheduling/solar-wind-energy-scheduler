from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

try:
    import boto3
except ImportError:
    boto3 = None


def build_idempotency_key(site_id: str, run_date: str, block_no: int, trigger_type: str, source_event_id: str) -> str:
    return f"{site_id}#{run_date}#{int(block_no)}#{trigger_type}#{source_event_id}"


def _local_claim_path(site_id: str, key: str) -> Path:
    safe_site = str(site_id).strip().upper()
    safe_key = str(key).replace("#", "__")
    return Path(__file__).resolve().parents[1] / "idempotency" / safe_site / f"{safe_key}.json"


def _s3_claim_key(site_id: str, key: str) -> str:
    plant_id = str(os.getenv("PLANT_ID", "vedanjay")).strip() or "vedanjay"
    safe_site = str(site_id).strip().upper()
    safe_key = str(key).replace("#", "__")
    return f"state/{plant_id}/{safe_site}/idempotency/{safe_key}.json"


def has_processed(site_id: str, key: str) -> bool:
    bucket = str(os.getenv("BUCKET", "")).strip()
    if bucket and boto3 is not None:
        try:
            boto3.client("s3").head_object(Bucket=bucket, Key=_s3_claim_key(site_id, key))
            return True
        except Exception:
            pass
    return _local_claim_path(site_id, key).exists()


def record_processed(site_id: str, key: str, payload: dict | None = None) -> None:
    body = {
        "site_id": str(site_id).strip().upper(),
        "idempotency_key": str(key),
        "processed_at_utc": datetime.now(timezone.utc).isoformat(),
        "payload": dict(payload or {}),
    }
    bucket = str(os.getenv("BUCKET", "")).strip()
    if bucket and boto3 is not None:
        try:
            boto3.client("s3").put_object(
                Bucket=bucket,
                Key=_s3_claim_key(site_id, key),
                Body=json.dumps(body, indent=2).encode("utf-8"),
                ContentType="application/json",
            )
            return
        except Exception:
            pass

    path = _local_claim_path(site_id, key)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body, indent=2), encoding="utf-8")
