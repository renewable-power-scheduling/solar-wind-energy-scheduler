"""
Template Transformation Pipeline

Design goals:
- Independent of legacy schedule template UI logic
- Configuration-driven per plant/template version
- Canonical internal model as the single transformation pivot
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import re
from datetime import datetime, date
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote
from urllib.request import urlopen
from xml.etree import ElementTree

from sqlalchemy.orm import Session


CANONICAL_FIELDS = [
    "block",
    "time",
    "scheduled_mw",
    "forecast_mw",
    "actual_mw",
    "condition",
]

SCHEDULE_FILE_PREFIX = "schedule_from_"
DEFAULT_OUTPUT_DIR = Path(__file__).resolve().parent.parent / "uploads" / "template-transform"


def _config_dir() -> Path:
    return Path(__file__).resolve().parent.parent / "config" / "template_pipeline"


def _load_json_config(file_name: str) -> List[Dict[str, Any]]:
    path = _config_dir() / file_name
    if not path.exists():
        raise ValueError(f"Missing pipeline config: {path}")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_pipeline_configs() -> Dict[str, List[Dict[str, Any]]]:
    return {
        "plants": _load_json_config("plants.json"),
        "template_definitions": _load_json_config("template_definitions.json"),
        "field_mappings": _load_json_config("field_mappings.json"),
    }


def get_plant_config(plant_id: int, configs: Dict[str, List[Dict[str, Any]]]) -> Dict[str, Any]:
    plant = next((p for p in configs["plants"] if int(p.get("plant_id", -1)) == int(plant_id)), None)
    if not plant:
        raise ValueError(f"No plant config found for plant_id={plant_id}")
    return plant


def get_active_template(plant_id: int, configs: Dict[str, List[Dict[str, Any]]]) -> Dict[str, Any]:
    active = [
        t for t in configs["template_definitions"]
        if int(t.get("plant_id", -1)) == int(plant_id) and bool(t.get("is_active", False))
    ]
    if not active:
        raise ValueError(f"No active template found for plant_id={plant_id}")
    # Pick highest lexical version if multiple active
    active.sort(key=lambda t: str(t.get("version", "")), reverse=True)
    return active[0]


def get_template_mappings(template_id: str, configs: Dict[str, List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    mappings = [m for m in configs["field_mappings"] if str(m.get("template_id")) == str(template_id)]
    if not mappings:
        raise ValueError(f"No field mappings found for template_id={template_id}")
    mappings.sort(key=lambda m: int(m.get("order", 9999)))
    return mappings


def _list_s3_objects(prefix: str, s3_base_url: str) -> List[Dict[str, str]]:
    url = f"{s3_base_url}/?list-type=2&prefix={quote(prefix)}"
    with urlopen(url, timeout=20) as resp:
        xml = resp.read().decode("utf-8", errors="replace")

    root = ElementTree.fromstring(xml)
    out: List[Dict[str, str]] = []
    for node in root.findall(".//{*}Contents"):
        key = node.findtext("{*}Key", default="")
        last_modified = node.findtext("{*}LastModified", default="")
        if key:
            out.append({"key": key, "last_modified": last_modified})
    return out


def list_schedule_files_for_date(target_date: date, s3_base_url: str, prefixes: List[str]) -> List[Dict[str, str]]:
    date_str = target_date.isoformat()
    date_prefixes = [f"{prefix.rstrip('/')}/{date_str}/" for prefix in prefixes]
    objects: List[Dict[str, str]] = []
    for prefix in date_prefixes:
        try:
            objects.extend(_list_s3_objects(prefix, s3_base_url))
        except Exception:
            continue

    unique = {obj["key"]: obj for obj in objects}
    filtered = [
        obj for obj in unique.values()
        if obj["key"].lower().endswith(".csv")
        and SCHEDULE_FILE_PREFIX in obj["key"].lower()
    ]
    filtered.sort(key=lambda item: item.get("last_modified", ""), reverse=True)
    return filtered


def fetch_s3_text(source_file_key: str, s3_base_url: str) -> str:
    encoded_key = "/".join(quote(segment) for segment in str(source_file_key).split("/"))
    url = f"{s3_base_url.rstrip('/')}/{encoded_key}"
    with urlopen(url, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _normalize_header(text: str) -> str:
    return "".join(ch for ch in str(text or "").strip().lower() if ch.isalnum())


HEADER_ALIASES = {
    "block": {"block", "blockno", "blocknumber"},
    "time": {"time", "timestamp", "timeslot"},
    "scheduled_mw": {"scheduledmw", "schedulemw", "scheduled", "algoschedule", "schedule"},
    "forecast_mw": {
        "forecastmw",
        "forecast",
        "declaredforecast",
        "baseforecast",
        "intradayforecast",
        "intradayforecastmw",
        "scaledenercastforecastmw",
        "dayaheadforecast",
    },
    "actual_mw": {"actualmw", "actual", "generation", "meterpower", "activepoweravgmfmoutmeterpowerkw"},
    "condition": {"condition", "conditionused", "weathercondition", "status"},
}


def _find_column_index(headers: List[str], aliases: set) -> Optional[int]:
    normalized = [_normalize_header(h) for h in headers]
    for idx, value in enumerate(normalized):
        if value in aliases:
            return idx
    return None


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        raw = str(value).strip()
        if raw == "":
            return default
        return float(raw)
    except Exception:
        return default


def _block_to_time(block: int) -> str:
    idx = max(1, int(block)) - 1
    hour = idx // 4
    minute = (idx % 4) * 15
    return f"{hour:02d}:{minute:02d}"


def _block_to_interval(block: int) -> str:
    idx = max(1, int(block)) - 1
    start_hour = idx // 4
    start_minute = (idx % 4) * 15
    end_idx = idx + 1
    end_hour = end_idx // 4
    end_minute = (end_idx % 4) * 15
    return f"{start_hour:02d}:{start_minute:02d}-{end_hour:02d}:{end_minute:02d}"


def parse_to_canonical_rows(csv_text: str) -> List[Dict[str, Any]]:
    reader = csv.reader(io.StringIO(csv_text))
    rows = [row for row in reader if any(str(cell).strip() for cell in row)]
    if not rows:
        return []

    # Some templates include meta rows before the real header row.
    # Detect the header row by looking for a row containing "Block" plus at least
    # one known data column (forecast/scheduled/actual).
    header_row_idx = 0
    for idx, row in enumerate(rows):
        candidate = [str(h).strip() for h in row]
        if _find_column_index(candidate, HEADER_ALIASES["block"]) is None:
            continue
        if (
            _find_column_index(candidate, HEADER_ALIASES["forecast_mw"]) is None
            and _find_column_index(candidate, HEADER_ALIASES["scheduled_mw"]) is None
            and _find_column_index(candidate, HEADER_ALIASES["actual_mw"]) is None
        ):
            continue
        header_row_idx = idx
        break

    headers = [str(h).strip() for h in rows[header_row_idx]]
    data_rows = rows[header_row_idx + 1 :]

    idx_block = _find_column_index(headers, HEADER_ALIASES["block"])
    idx_time = _find_column_index(headers, HEADER_ALIASES["time"])
    idx_sched = _find_column_index(headers, HEADER_ALIASES["scheduled_mw"])
    idx_forecast = _find_column_index(headers, HEADER_ALIASES["forecast_mw"])
    idx_actual = _find_column_index(headers, HEADER_ALIASES["actual_mw"])
    idx_condition = _find_column_index(headers, HEADER_ALIASES["condition"])

    canonical: List[Dict[str, Any]] = []
    for i, row in enumerate(data_rows):
        block = int(_safe_float(row[idx_block], i + 1)) if idx_block is not None and idx_block < len(row) else (i + 1)
        time_text = row[idx_time].strip() if idx_time is not None and idx_time < len(row) else _block_to_time(block)
        scheduled = _safe_float(row[idx_sched]) if idx_sched is not None and idx_sched < len(row) else 0.0
        forecast = _safe_float(row[idx_forecast]) if idx_forecast is not None and idx_forecast < len(row) else 0.0
        actual = _safe_float(row[idx_actual]) if idx_actual is not None and idx_actual < len(row) else 0.0
        condition = row[idx_condition].strip() if idx_condition is not None and idx_condition < len(row) else ""

        canonical.append(
            {
                "block": block,
                "time": time_text,
                "scheduled_mw": scheduled,
                "forecast_mw": forecast,
                "actual_mw": actual,
                "condition": condition,
            }
        )
    return canonical


def normalize_canonical_blocks(
    canonical_rows: List[Dict[str, Any]],
    *,
    expected_blocks: int = 96,
    auto_fill_missing: bool = False,
) -> Tuple[List[Dict[str, Any]], List[int]]:
    if expected_blocks <= 0:
        return canonical_rows, []

    by_block: Dict[int, Dict[str, Any]] = {}
    for row in canonical_rows:
        block = int(_safe_float(row.get("block"), 0))
        if block <= 0:
            continue
        # Keep first occurrence; duplicate handling remains in validation.
        if block not in by_block:
            by_block[block] = row

    missing = [b for b in range(1, expected_blocks + 1) if b not in by_block]
    if not auto_fill_missing:
        return canonical_rows, missing

    normalized: List[Dict[str, Any]] = []
    for block in range(1, expected_blocks + 1):
        row = by_block.get(block)
        if row is None:
            normalized.append(
                {
                    "block": block,
                    "time": _block_to_time(block),
                    "scheduled_mw": 0.0,
                    "forecast_mw": 0.0,
                    "actual_mw": 0.0,
                    "condition": "MISSING_FILLED",
                }
            )
        else:
            normalized.append(row)
    return normalized, missing


def format_missing_blocks_summary(missing_blocks: List[int]) -> str:
    if not missing_blocks:
        return ""

    sorted_blocks = sorted(set(int(b) for b in missing_blocks if int(b) > 0))
    ranges = format_block_ranges(sorted_blocks)

    return (
        f"Auto-filled {len(sorted_blocks)} missing blocks with defaults "
        f"(source file did not contain them): {ranges}"
    )


def format_block_ranges(blocks: List[int]) -> str:
    if not blocks:
        return ""

    sorted_blocks = sorted(set(int(b) for b in blocks if int(b) > 0))
    ranges: List[str] = []
    start = sorted_blocks[0]
    end = start
    for block in sorted_blocks[1:]:
        if block == end + 1:
            end = block
            continue
        ranges.append(f"{start}-{end}" if start != end else f"{start}")
        start = block
        end = block
    ranges.append(f"{start}-{end}" if start != end else f"{start}")
    return ", ".join(ranges)


def _apply_single_rule(value: Any, rule: str, row: Dict[str, Any]) -> Any:
    rule = str(rule or "").strip()
    if not rule:
        return value

    if rule == "int":
        return int(_safe_float(value))
    if rule == "uppercase":
        return str(value or "").upper()
    if rule == "lowercase":
        return str(value or "").lower()

    if rule.startswith("round(") and rule.endswith(")"):
        digits = int(rule[6:-1])
        return round(_safe_float(value), digits)
    if rule.startswith("mul(") and rule.endswith(")"):
        factor = float(rule[4:-1])
        return _safe_float(value) * factor
    if rule.startswith("div(") and rule.endswith(")"):
        divisor = float(rule[4:-1])
        return _safe_float(value) / divisor if divisor != 0 else 0
    if rule.startswith("default(") and rule.endswith(")") and (value is None or str(value).strip() == ""):
        return rule[8:-1]
    if rule.startswith("block_time("):
        block = int(_safe_float(row.get("block", 1), 1))
        return _block_to_time(block)
    if rule.startswith("block_interval("):
        block = int(_safe_float(row.get("block", 1), 1))
        return _block_to_interval(block)
    return value


def apply_rule_chain(value: Any, rule_text: str, row: Dict[str, Any]) -> Any:
    out = value
    for part in str(rule_text or "").split("|"):
        out = _apply_single_rule(out, part.strip(), row)
    return out


def transform_rows(
    canonical_rows: List[Dict[str, Any]],
    mappings: List[Dict[str, Any]],
) -> Tuple[List[str], List[Dict[str, Any]]]:
    target_columns = [str(m["target_field"]) for m in mappings]
    transformed: List[Dict[str, Any]] = []

    for row in canonical_rows:
        out_row: Dict[str, Any] = {}
        for mapping in mappings:
            source_field = str(mapping.get("source_field", "")).strip()
            target_field = str(mapping.get("target_field", "")).strip()
            default_value = mapping.get("default_value")
            transform_rule = str(mapping.get("transform_rule", "")).strip()

            value = row.get(source_field, default_value)
            if value is None and default_value is not None:
                value = default_value
            value = apply_rule_chain(value, transform_rule, row)
            out_row[target_field] = value
        transformed.append(out_row)

    return target_columns, transformed


def validate_canonical_rows(
    canonical_rows: List[Dict[str, Any]],
    plant_capacity: float,
    penalty_threshold_percent: Optional[float] = None,
    plant: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    errors: List[str] = []
    warnings: List[str] = []

    if not canonical_rows:
        errors.append("No data rows parsed from source schedule file.")
        return {"is_valid": False, "errors": errors, "warnings": warnings}

    blocks = [int(_safe_float(r.get("block"), 0)) for r in canonical_rows]
    block_set = set(blocks)
    if len(canonical_rows) != 96:
        errors.append(f"Expected 96 rows/blocks but got {len(canonical_rows)}.")
    if len(block_set) != len(blocks):
        errors.append("Duplicate block numbers detected.")

    missing_blocks = [b for b in range(1, 97) if b not in block_set]
    if missing_blocks:
        errors.append(f"Missing block numbers: {missing_blocks[:20]}")

    for idx, row in enumerate(canonical_rows, start=1):
        scheduled = _safe_float(row.get("scheduled_mw"), 0.0)
        forecast = _safe_float(row.get("forecast_mw"), 0.0)
        actual = _safe_float(row.get("actual_mw"), 0.0)

        if scheduled < 0 or forecast < 0 or actual < 0:
            errors.append(f"Row {idx}: negative numeric values are not allowed.")
            continue

        upper = max(plant_capacity * 2.0, 1.0)
        if scheduled > upper or forecast > upper or actual > upper:
            warnings.append(f"Row {idx}: value exceeds expected upper bound ({upper}).")

    threshold = _safe_float(penalty_threshold_percent, 0.0)
    is_telangana = str((plant or {}).get("state", "")).strip().lower() == "telangana"
    plant_name_key = re.sub(r"[^A-Za-z0-9]+", "", str((plant or {}).get("name", "")).upper())
    uses_forecast_as_submitted_schedule = plant_name_key in {"OSEPL", "SIRMOUR"}
    if threshold > 0:
        exceeded_blocks: List[int] = []
        for row in canonical_rows:
            block = int(_safe_float(row.get("block"), 0))
            scheduled = _safe_float(row.get("scheduled_mw"), 0.0)
            forecast = _safe_float(row.get("forecast_mw"), 0.0)
            if scheduled <= 0:
                continue
            # Telangana uses Station Schedule. OSEPL/SIRMOUR submit forecast as the schedule column,
            # so do not flag an internal forecast_mw vs scheduled_mw mismatch for those templates.
            compare_value = scheduled if (is_telangana or uses_forecast_as_submitted_schedule) else forecast
            deviation_pct = (abs(compare_value - scheduled) / scheduled) * 100.0
            if deviation_pct > threshold:
                exceeded_blocks.append(block)
        if exceeded_blocks:
            label = "schedule vs station schedule" if is_telangana else "schedule vs forecast"
            warnings.append(
                f"Penalty threshold {threshold:.1f}% exceeded in {len(exceeded_blocks)} block(s) "
                f"({label}): {format_block_ranges(exceeded_blocks)}"
            )

    return {"is_valid": len(errors) == 0, "errors": errors, "warnings": warnings}


def _render_meta_cell(
    cell: Any,
    *,
    plant: Optional[Dict[str, Any]],
    target_date: Optional[date],
    schedule_type: str = "",
    schedule_revision: Optional[int] = None,
) -> str:
    text = str(cell or "")
    plant_name = str((plant or {}).get("name", ""))
    plant_label = plant_name.upper().replace("(GSNP)", "").strip()
    date_ddmmyyyy = target_date.strftime("%d-%m-%Y") if target_date else ""
    normalized_schedule_type = str(schedule_type or "").strip().lower().replace("_", "").replace("-", "")
    normalized_plant = re.sub(r"[^A-Za-z0-9]+", "", plant_name).upper()
    mh_revision_label = "DA" if normalized_schedule_type == "dayahead" else (
        "INTRADAY" if normalized_schedule_type == "intraday" else str(schedule_type or "").strip()
    )
    if normalized_plant in {"ANDAD", "BALAKWADA", "BAMKHAL", "GUGARIYAKHEDI", "NANDGAON"} and normalized_schedule_type == "dayahead":
        revision_text = "0"
    else:
        revision_text = str(int(schedule_revision)) if isinstance(schedule_revision, int) and schedule_revision > 0 else (
            "1" if normalized_schedule_type in {"dayahead", "intraday"} else ""
        )
    replacements = {
        "{date}": target_date.isoformat() if target_date else "",
        "{date_ddmmyyyy}": date_ddmmyyyy,
        "{plant_name}": plant_name,
        "{plant_upper}": plant_label,
        "{schedule_type}": str(schedule_type or "").strip(),
        "{mh_revision}": mh_revision_label,
        "{schedule_revision}": revision_text,
    }
    for key, value in replacements.items():
        text = text.replace(key, value)
    return text


def to_csv_bytes(
    columns: List[str],
    rows: List[Dict[str, Any]],
    *,
    template: Optional[Dict[str, Any]] = None,
    plant: Optional[Dict[str, Any]] = None,
    target_date: Optional[date] = None,
    schedule_type: str = "",
    schedule_revision: Optional[int] = None,
) -> bytes:
    output_style = str((template or {}).get("output_style", "standard_csv")).strip().lower()
    if output_style == "gsnp_multiline":
        output = io.StringIO()
        writer = csv.writer(output)
        meta_rows = (template or {}).get("meta_rows", [])
        for row in meta_rows:
            writer.writerow(
                [
                    _render_meta_cell(
                        cell,
                        plant=plant,
                        target_date=target_date,
                        schedule_type=schedule_type,
                        schedule_revision=schedule_revision,
                    )
                    for cell in list(row)
                ]
            )
        for row in rows:
            writer.writerow([row.get(col, "") for col in columns])
        return output.getvalue().encode("utf-8")

    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=columns)
    writer.writeheader()
    for row in rows:
        writer.writerow(row)
    return output.getvalue().encode("utf-8")


def publish_output_file(
    file_bytes: bytes,
    plant_id: int,
    template_id: str,
    run_ts: datetime,
) -> Dict[str, str]:
    """
    Persist output artifact.
    If S3 output bucket is configured and boto3 is available, publish to S3.
    Otherwise fall back to local backend/uploads/template-transform.
    """
    file_name = f"plant_{plant_id}_{template_id}_{run_ts.strftime('%Y%m%d_%H%M%S')}.csv"
    output_bucket = os.getenv("TEMPLATE_OUTPUT_BUCKET", "").strip()
    output_prefix = os.getenv("TEMPLATE_OUTPUT_PREFIX", "generated/template-transform").strip().strip("/")

    if output_bucket:
        try:
            import boto3  # type: ignore

            key = f"{output_prefix}/{file_name}" if output_prefix else file_name
            s3 = boto3.client("s3")
            s3.put_object(
                Bucket=output_bucket,
                Key=key,
                Body=file_bytes,
                ContentType="text/csv",
            )
            region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or "ap-south-1"
            return {
                "output_file_key": key,
                "output_file_url": f"https://{output_bucket}.s3.{region}.amazonaws.com/{key}",
            }
        except Exception:
            # fall back to local persistence when S3 upload is unavailable
            pass

    DEFAULT_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    local_path = DEFAULT_OUTPUT_DIR / file_name
    local_path.write_bytes(file_bytes)
    return {
        "output_file_key": f"local/template-transform/{file_name}",
        "output_file_url": str(local_path),
    }


def build_preview_rows(rows: List[Dict[str, Any]], limit: int = 12) -> List[Dict[str, Any]]:
    return rows[:max(1, limit)]


def compute_source_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8", errors="replace")).hexdigest()


def run_preview_pipeline(
    plant_id: int,
    target_date: date,
    source_file_key: str,
    s3_base_url: str,
) -> Dict[str, Any]:
    configs = load_pipeline_configs()
    plant = get_plant_config(plant_id, configs)
    template = get_active_template(plant_id, configs)
    mappings = get_template_mappings(template["template_id"], configs)

    source_text = fetch_s3_text(source_file_key, s3_base_url)
    canonical_rows = parse_to_canonical_rows(source_text)
    expected_blocks = int(template.get("expected_blocks", 96) or 96)
    auto_fill_missing = bool(template.get("auto_fill_missing_blocks", False))
    canonical_rows, missing_blocks = normalize_canonical_blocks(
        canonical_rows,
        expected_blocks=expected_blocks,
        auto_fill_missing=auto_fill_missing,
    )
    validation = validate_canonical_rows(
        canonical_rows,
        float(plant.get("capacity", 0)),
        _safe_float(plant.get("penalty_threshold_percent"), 0.0),
        plant,
    )
    if auto_fill_missing and missing_blocks:
        validation["warnings"].append(format_missing_blocks_summary(missing_blocks))
    target_columns, transformed_rows = transform_rows(canonical_rows, mappings)

    return {
        "plant": plant,
        "template": template,
        "target_columns": target_columns,
        "validation": validation,
        "canonical_preview": build_preview_rows(canonical_rows),
        "transformed_preview": build_preview_rows(transformed_rows),
        "canonical_row_count": len(canonical_rows),
        "source_hash": compute_source_hash(source_text),
    }


def save_transform_audit_run(
    db: Session,
    *,
    plant_id: int,
    source_file_key: str,
    source_hash: str,
    template_id: str,
    template_version: str,
    status: str,
    validation_errors: List[str],
    output_file_key: Optional[str],
    output_file_url: Optional[str],
    requested_by: Optional[str],
    run_date: date,
) -> Any:
    from models import TemplateTransformRun  # local import to avoid circulars

    run = TemplateTransformRun(
        plant_id=plant_id,
        run_date=run_date,
        source_file_key=source_file_key,
        source_hash=source_hash,
        template_id=template_id,
        template_version=template_version,
        status=status,
        validation_errors=json.dumps(validation_errors),
        output_file_key=output_file_key,
        output_file_url=output_file_url,
        requested_by=requested_by,
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


def query_transform_history(
    db: Session,
    *,
    plant_id: Optional[int] = None,
    run_date: Optional[date] = None,
    status: Optional[str] = None,
    limit: int = 100,
) -> List[Any]:
    from models import TemplateTransformRun  # local import to avoid circulars

    query = db.query(TemplateTransformRun)
    if plant_id:
        query = query.filter(TemplateTransformRun.plant_id == plant_id)
    if run_date:
        query = query.filter(TemplateTransformRun.run_date == run_date)
    if status:
        query = query.filter(TemplateTransformRun.status == status)
    return query.order_by(TemplateTransformRun.created_at.desc()).limit(limit).all()


def get_transform_run_by_id(db: Session, run_id: int) -> Optional[Any]:
    from models import TemplateTransformRun  # local import to avoid circulars
    return db.query(TemplateTransformRun).filter(TemplateTransformRun.id == run_id).first()
