import base64
import json
import logging
import os
import re
import uuid
from datetime import datetime
from io import StringIO
from typing import Any
from urllib.parse import urlparse

import boto3
import pandas as pd
from botocore.exceptions import ClientError
from zoneinfo import ZoneInfo


IST = ZoneInfo("Asia/Kolkata")
LOGGER = logging.getLogger(__name__)
LOGGER.setLevel(logging.INFO)

S3 = boto3.client("s3")

TARGET_BUCKET = os.getenv("TARGET_BUCKET") or os.getenv("BUCKET")
MANUAL_PREFIX = os.getenv("MANUAL_PREFIX", "manual-edits").strip().strip("/")


def _response(status_code: int, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Requested-With",
            "Access-Control-Allow-Methods": "POST,OPTIONS",
        },
        "body": json.dumps(payload, default=str),
    }


def _now_ist() -> str:
    return datetime.now(IST).isoformat()


def _coerce_event_body(event: dict[str, Any] | None) -> dict[str, Any]:
    if not event:
        return {}

    body = event.get("body")
    if body is None:
        return event if isinstance(event, dict) else {}

    if isinstance(body, dict):
        return body

    if isinstance(body, str):
        raw = body
        if event.get("isBase64Encoded"):
            raw = base64.b64decode(raw).decode("utf-8")
        raw = raw.strip()
        if not raw:
            return {}
        return json.loads(raw)

    raise ValueError("Unsupported request body format")


def _normalize_schedule_type(raw: Any) -> str:
    value = str(raw or "").strip().upper()
    if value in {"DA", "DAY_AHEAD", "DAY-AHEAD", "DAYAHEAD"}:
        return "DA"
    if value in {"ID", "INTRADAY", "INTRA_DAY", "INTRA-DAY"}:
        return "INTRADAY"
    raise ValueError(f"Unsupported schedule_type: {raw!r}")


def _require_str(payload: dict[str, Any], *names: str) -> str:
    for name in names:
        value = payload.get(name)
        if value is not None and str(value).strip():
            return str(value).strip()
    raise ValueError(f"Missing required field: one of {', '.join(names)}")


def _parse_s3_location(key_or_uri: str) -> tuple[str, str]:
    raw = str(key_or_uri or "").strip()
    if not raw:
        raise ValueError("baseline_schedule_s3_key is required")

    if raw.startswith("s3://"):
        parsed = urlparse(raw)
        bucket = parsed.netloc
        key = parsed.path.lstrip("/")
    else:
        bucket = TARGET_BUCKET
        key = raw.lstrip("/")

    if not bucket:
        raise ValueError("S3 bucket is not configured (set TARGET_BUCKET or BUCKET)")
    if not key:
        raise ValueError("baseline_schedule_s3_key is empty")
    return bucket, key


def _load_csv_from_s3(bucket: str, key: str) -> pd.DataFrame:
    obj = S3.get_object(Bucket=bucket, Key=key)
    raw = obj["Body"].read()
    return pd.read_csv(StringIO(raw.decode("utf-8-sig")))


def _put_json(bucket: str, key: str, payload: dict[str, Any]) -> None:
    S3.put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps(payload, indent=2, default=str).encode("utf-8"),
        ContentType="application/json",
    )


def _put_csv(bucket: str, key: str, df: pd.DataFrame) -> None:
    body = df.to_csv(index=False).encode("utf-8")
    S3.put_object(Bucket=bucket, Key=key, Body=body, ContentType="text/csv")


def _get_json_optional(bucket: str, key: str) -> dict[str, Any] | None:
    try:
        obj = S3.get_object(Bucket=bucket, Key=key)
    except ClientError as exc:
        code = (exc.response.get("Error") or {}).get("Code")
        if code in {"NoSuchKey", "404", "NotFound"}:
            return None
        raise
    raw = obj["Body"].read().decode("utf-8")
    return json.loads(raw)


def _load_overrides_map(bucket: str, key: str) -> dict[int, float]:
    payload = _get_json_optional(bucket, key)
    if not payload:
        return {}

    # Allow either {"overrides": {...}} or a plain {...} mapping
    mapping = payload.get("overrides") if isinstance(payload, dict) else None
    if mapping is None:
        mapping = payload
    if not isinstance(mapping, dict):
        raise ValueError("Invalid overrides.json format")

    out: dict[int, float] = {}
    for k, v in mapping.items():
        out[int(k)] = float(v)
    return out


def _write_overrides_map(bucket: str, key: str, overrides: dict[int, float]) -> None:
    payload = {
        "updated_at_ist": _now_ist(),
        "overrides": {str(k): float(v) for k, v in sorted(overrides.items(), key=lambda kv: kv[0])},
    }
    _put_json(bucket, key, payload)


def _apply_overrides(
    base_df: pd.DataFrame,
    overrides: dict[int, float],
    target_col: str,
) -> pd.DataFrame:
    if not overrides:
        return base_df

    if "block" not in base_df.columns:
        raise ValueError("Baseline schedule must contain a 'block' column")

    df = base_df.copy()
    df["block"] = pd.to_numeric(df["block"], errors="raise").astype(int)
    present = set(df["block"].tolist())

    missing: list[int] = []
    for block, mw in overrides.items():
        if block not in present:
            missing.append(block)
            continue
        df.loc[df["block"] == block, target_col] = float(mw)

    if missing:
        LOGGER.warning("Overrides contain blocks not present in baseline: %s", sorted(missing))

    return df


def _validate_changes(changes: Any) -> list[dict[str, Any]]:
    if not isinstance(changes, list) or not changes:
        raise ValueError("changes must be a non-empty array")

    seen: set[int] = set()
    normalized: list[dict[str, Any]] = []
    for idx, change in enumerate(changes):
        if not isinstance(change, dict):
            raise ValueError(f"changes[{idx}] must be an object")

        if "block" not in change or "mw" not in change:
            raise ValueError(f"changes[{idx}] must include block and mw")

        try:
            block = int(change["block"])
        except Exception as exc:
            raise ValueError(f"changes[{idx}].block must be an integer") from exc
        if not 1 <= block <= 96:
            raise ValueError(f"changes[{idx}].block must be between 1 and 96")

        try:
            mw = float(change["mw"])
        except Exception as exc:
            raise ValueError(f"changes[{idx}].mw must be numeric") from exc

        if block in seen:
            raise ValueError(f"Duplicate block in changes: {block}")
        seen.add(block)
        normalized.append({"block": block, "mw": mw})

    return normalized


def _resolve_target_column(df: pd.DataFrame) -> str:
    candidates = ["algo_schedule_mw", "mw", "schedule_mw", "forecast_mw"]
    for col in candidates:
        if col in df.columns:
            return col
    raise ValueError(
        f"Could not find a schedule MW column. Tried: {', '.join(candidates)}"
    )


def _safe_token(value: str) -> str:
    token = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value or "").strip())
    return token or "unknown"


def _build_state_prefix(
    plant_id: str,
    site_id: str,
    schedule_date: str,
    schedule_type: str,
    revision: str,
) -> str:
    # Keep DA overrides separate per revision to avoid mixing DA1/DA2 etc.
    base = (
        f"{MANUAL_PREFIX}/{_safe_token(plant_id)}/{_safe_token(site_id)}/"
        f"{_safe_token(schedule_date)}/{_safe_token(schedule_type)}"
    )
    if schedule_type == "DA":
        return f"{base}/{_safe_token(revision)}"
    return base


def _build_prefix(plant_id: str, site_id: str, schedule_date: str, schedule_type: str, request_id: str) -> str:
    return (
        f"{MANUAL_PREFIX}/{_safe_token(plant_id)}/{_safe_token(site_id)}/"
        f"{_safe_token(schedule_date)}/{_safe_token(schedule_type)}/{_safe_token(request_id)}"
    )


def _apply_manual_changes(
    system_df: pd.DataFrame,
    changes: list[dict[str, Any]],
    target_col: str,
) -> tuple[pd.DataFrame, dict[str, Any]]:
    if "block" not in system_df.columns:
        raise ValueError("Baseline schedule must contain a 'block' column")

    df = system_df.copy()
    df["block"] = pd.to_numeric(df["block"], errors="raise").astype(int)

    if df["block"].duplicated().any():
        dupes = df.loc[df["block"].duplicated(), "block"].tolist()
        raise ValueError(f"Baseline schedule contains duplicate block values: {dupes}")

    block_index = df.set_index("block")
    missing_blocks = [c["block"] for c in changes if c["block"] not in block_index.index]
    if missing_blocks:
        raise ValueError(f"Requested block(s) not present in baseline schedule: {missing_blocks}")

    system_df_out = df.copy()
    manual_df_out = df.copy()

    diff_rows: list[dict[str, Any]] = []
    for change in changes:
        block = int(change["block"])
        manual_mw = float(change["mw"])
        system_mw = float(block_index.loc[block, target_col])
        manual_df_out.loc[manual_df_out["block"] == block, target_col] = manual_mw
        if abs(manual_mw - system_mw) > 1e-12:
            diff_rows.append(
                {
                    "block": block,
                    "system_mw": round(system_mw, 6),
                    "manual_mw": round(manual_mw, 6),
                    "delta_mw": round(manual_mw - system_mw, 6),
                }
            )

    diff_rows.sort(key=lambda x: x["block"])

    summary = {
        "change_count": len(changes),
        "changed_block_count": len(diff_rows),
        "system_total_mw": round(float(system_df_out[target_col].astype(float).sum()), 6),
        "manual_total_mw": round(float(manual_df_out[target_col].astype(float).sum()), 6),
    }
    summary["delta_total_mw"] = round(summary["manual_total_mw"] - summary["system_total_mw"], 6)

    return manual_df_out, {"diff_rows": diff_rows, "summary": summary, "system_df": system_df_out}


def lambda_handler(event, context):
    try:
        payload = _coerce_event_body(event if isinstance(event, dict) else {})

        plant_id = _require_str(payload, "org_id", "plant_id")
        site_id = _require_str(payload, "site_id")
        schedule_date = _require_str(payload, "schedule_date")
        schedule_type = _normalize_schedule_type(payload.get("schedule_type"))
        request_id = _require_str(payload, "request_id") if payload.get("request_id") else str(uuid.uuid4())
        submitted_by = _require_str(payload, "submitted_by")
        submitted_at_ist = _require_str(payload, "submitted_at_ist") if payload.get("submitted_at_ist") else _now_ist()
        baseline_schedule_s3_key = _require_str(payload, "baseline_schedule_s3_key")
        comment = str(payload.get("comment", "")).strip()

        revision = str(payload.get("revision", "")).strip() if payload.get("revision") is not None else ""
        reference_block = payload.get("reference_block")

        if schedule_type == "DA" and not revision:
            raise ValueError("revision is required for DA edits")
        if schedule_type == "INTRADAY" and reference_block is None:
            raise ValueError("reference_block is required for INTRADAY edits")
        if reference_block is not None:
            try:
                reference_block = int(reference_block)
            except Exception as exc:
                raise ValueError("reference_block must be an integer") from exc

        changes = _validate_changes(payload.get("changes"))
        bucket, baseline_key = _parse_s3_location(baseline_schedule_s3_key)

        system_df_raw = _load_csv_from_s3(bucket, baseline_key)
        target_col = _resolve_target_column(system_df_raw)

        state_prefix = _build_state_prefix(plant_id, site_id, schedule_date, schedule_type, revision)
        overrides_key = f"{state_prefix}/overrides.json"
        latest_key = f"{state_prefix}/latest.json"

        # 1) Load cumulative overrides (previous manual edits)
        overrides = _load_overrides_map(bucket, overrides_key)

        # 2) Apply previous overrides onto the new system baseline
        system_df_effective = _apply_overrides(system_df_raw, overrides, target_col)

        # 3) Apply this request's changes on top
        manual_df, artefacts = _apply_manual_changes(system_df_effective, changes, target_col)

        # 4) Update cumulative overrides with this request (last-write-wins per block)
        for c in changes:
            overrides[int(c["block"])] = float(c["mw"])

        diff_rows = artefacts["diff_rows"]
        summary = artefacts["summary"]

        # Save the *raw* baseline as system_schedule.csv (no overrides)
        system_df_copy = system_df_raw.copy()
        if "block" in system_df_copy.columns:
            system_df_copy["block"] = pd.to_numeric(system_df_copy["block"], errors="raise").astype(int)

        # Make system_total_mw reflect the raw system baseline (not the override-applied baseline)
        summary["system_total_mw"] = round(float(system_df_copy[target_col].astype(float).sum()), 6)
        summary["delta_total_mw"] = round(summary["manual_total_mw"] - summary["system_total_mw"], 6)

        prefix = _build_prefix(plant_id, site_id, schedule_date, schedule_type, request_id)
        request_key = f"{prefix}/edit_request.json"
        system_key = f"{prefix}/system_schedule.csv"
        edited_key = f"{prefix}/edited_schedule.csv"
        diff_key = f"{prefix}/diff.json"

        normalized_payload = {
            "request_id": request_id,
            "org_id": plant_id,
            "site_id": site_id,
            "schedule_date": schedule_date,
            "schedule_type": schedule_type,
            "revision": revision or None,
            "reference_block": reference_block,
            "baseline_schedule_s3_key": baseline_schedule_s3_key,
            "submitted_by": submitted_by,
            "submitted_at_ist": submitted_at_ist,
            "comment": comment,
            "changes": changes,
            "processed_at_ist": _now_ist(),
        }

        diff_payload = {
            "request_id": request_id,
            "org_id": plant_id,
            "site_id": site_id,
            "schedule_date": schedule_date,
            "schedule_type": schedule_type,
            "revision": revision or None,
            "reference_block": reference_block,
            "baseline_schedule_s3_key": baseline_schedule_s3_key,
            "system_schedule_s3_key": system_key,
            "edited_schedule_s3_key": edited_key,
            "submitted_by": submitted_by,
            "submitted_at_ist": submitted_at_ist,
            "comment": comment,
            "summary": summary,
            "changes": diff_rows,
            "processed_at_ist": _now_ist(),
        }

        _put_json(bucket, request_key, normalized_payload)
        _put_csv(bucket, system_key, system_df_copy)
        _put_csv(bucket, edited_key, manual_df)
        _put_json(bucket, diff_key, diff_payload)

        _write_overrides_map(bucket, overrides_key, overrides)
        _put_json(
            bucket,
            latest_key,
            {
                "updated_at_ist": _now_ist(),
                "request_id": request_id,
                "baseline_schedule_s3_key": baseline_schedule_s3_key,
                "edited_schedule_s3_key": edited_key,
                "diff_s3_key": diff_key,
            },
        )

        response = {
            "ok": True,
            "plant_id": plant_id,
            "site_id": site_id,
            "schedule_date": schedule_date,
            "schedule_type": schedule_type,
            "request_id": request_id,
            "baseline_schedule_s3_bucket": bucket,
            "baseline_schedule_s3_key": baseline_key,
            "manual_prefix": prefix,
            "request_s3_key": request_key,
            "system_schedule_s3_key": system_key,
            "edited_schedule_s3_key": edited_key,
            "diff_s3_key": diff_key,
            "summary": summary,
        }
        return _response(200, response)

    except ValueError as exc:
        LOGGER.warning("Manual schedule ingest validation failed: %s", exc)
        return _response(400, {"ok": False, "error": str(exc)})
    except Exception as exc:
        LOGGER.exception("Manual schedule ingest failed")
        return _response(500, {"ok": False, "error": str(exc)})
