import json
import logging
import os
import re
import warnings
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd

try:
    import boto3
except ImportError:
    boto3 = None

try:
    from boto3.dynamodb.conditions import Key
except Exception:
    Key = None

from cloud.common.csv_utils import load_enercast_forecast_csv
from cloud.common.time_utils import block_to_timestamp
from cloud.common.graph_utils import generate_schedule_graph
from cloud.common.config_loader import load_site_config
from cloud.common.capacity import resolve_capacity_config, effective_capacity_ac_mw


SITE_ID = os.getenv("SITE_ID", "SIRMOUR").strip().upper()
IST = ZoneInfo("Asia/Kolkata")
ROOT_DIR = Path(os.getenv("PROJECT_ROOT", Path.cwd()))
DATA_ROOT = Path(os.getenv("DATA_ROOT", f"data/{SITE_ID}"))
OUTPUT_ROOT = Path(os.getenv("OUTPUT_ROOT", f"outputs/{SITE_ID}"))
LOG_ROOT = Path(os.getenv("LOG_ROOT", f"logs/{SITE_ID}"))
PLANT_ID = os.getenv("PLANT_ID", "vedanjay")
SITE_NAME = os.getenv("SITE_NAME", SITE_ID)
CONTROL_WINDOWS_TABLE = os.getenv("CONTROL_WINDOWS_TABLE")
DA_SCHEDULE_REASON_LABEL = os.getenv("DA_SCHEDULE_REASON_LABEL", "").strip()
PLANT_CAPACITY_MW = 5.10


def _load_plant_capacity_mw() -> float:
    try:
        cfg = load_site_config(SITE_ID) or {}
        return float(cfg.get("plant_capacity_mw", PLANT_CAPACITY_MW))
    except Exception:
        return float(PLANT_CAPACITY_MW)


SITE_CONFIG = load_site_config(SITE_ID) or {}
CAPACITY_CONFIG = resolve_capacity_config(SITE_CONFIG)
SITE_AC_CAPACITY_MW = float(CAPACITY_CONFIG["ac_capacity_mw"])
SITE_DC_CAPACITY_MW = float(CAPACITY_CONFIG["dc_capacity_mw"])
DC_AC_RATIO = float(CAPACITY_CONFIG["dc_ac_ratio"])
PLANT_CAPACITY_MW = SITE_AC_CAPACITY_MW or _load_plant_capacity_mw()


def _configure_engine_logger() -> logging.Logger:
    logger = logging.getLogger("global1_da_engine")
    if logger.handlers:
        return logger

    logger.setLevel(logging.INFO)
    formatter = logging.Formatter("%(asctime)s | %(levelname)s | %(message)s")

    console = logging.StreamHandler()
    console.setFormatter(formatter)

    log_path = LOG_ROOT / "engine.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    file_handler = logging.FileHandler(log_path, encoding="utf-8")
    file_handler.setFormatter(formatter)

    logger.addHandler(console)
    logger.addHandler(file_handler)
    logger.propagate = False
    return logger


logger = _configure_engine_logger()


def _rel_path(path: str | Path) -> str:
    try:
        return os.path.relpath(str(path), ROOT_DIR)
    except Exception:
        return str(path)


def _showwarning(message, category, filename, lineno, file=None, line=None):
    logger.warning("Warning %s at %s:%s: %s", category.__name__, _rel_path(filename), lineno, message)


warnings.showwarning = _showwarning


def _resolve_engine_now_ist() -> datetime:
    raw = os.getenv("ENGINE_NOW_IST", "").strip()
    if raw:
        try:
            dt = datetime.fromisoformat(raw)
            return dt.replace(tzinfo=IST) if dt.tzinfo is None else dt.astimezone(IST)
        except Exception:
            logger.warning("Invalid ENGINE_NOW_IST=%r; falling back to current IST time", raw)
    return datetime.now(IST)


def _latest_file_in_dir(dir_path: Path) -> Path | None:
    if not dir_path.exists():
        return None
    files = [p for p in dir_path.glob("*.csv") if p.is_file()]
    if not files:
        return None
    return max(files, key=lambda p: p.stat().st_mtime)


def _list_data_date_dirs(data_root: Path) -> list[Path]:
    if not data_root.exists():
        return []
    out = []
    for p in data_root.iterdir():
        if not p.is_dir():
            continue
        try:
            datetime.strptime(p.name, "%Y-%m-%d")
        except ValueError:
            continue
        out.append(p)
    return sorted(out, key=lambda p: p.name)


def _pick_data_root_for_run_date(run_date: date) -> Path:
    preferred = DATA_ROOT / run_date.strftime("%Y-%m-%d")
    preferred_dayahead = _latest_file_in_dir(preferred / "enercast_data" / "day_ahead")
    if preferred_dayahead is not None:
        return preferred

    candidates = _list_data_date_dirs(DATA_ROOT)
    for cand in reversed(candidates):
        dayahead = _latest_file_in_dir(cand / "enercast_data" / "day_ahead")
        if dayahead is not None:
            logger.warning(
                "No local day-ahead data for run date %s; falling back to latest available date %s",
                run_date.strftime("%Y-%m-%d"),
                cand.name,
            )
            return cand

    raise FileNotFoundError(f"No local day-ahead data found under {DATA_ROOT}")


def _resolve_day_ahead_source_file(
    site_id: str,
    day_ahead_dir: Path,
    current_run_date: date,
    next_date: date,
    fixed_revision_label: str | None = None,
) -> Path:
    site_upper = site_id.strip().upper()
    current_str = current_run_date.strftime("%Y-%m-%d")
    next_str = next_date.strftime("%Y-%m-%d")

    cfg = {}
    try:
        cfg = load_site_config(site_upper) or {}
    except Exception:
        cfg = {}

    fp = cfg.get("file_patterns", {}) if isinstance(cfg, dict) else {}
    patterns = fp.get("day_ahead_filename_regex") or fp.get("day_ahead_filename_regexes")
    if isinstance(patterns, str) and patterns.strip():
        patterns = [patterns.strip()]
    if isinstance(patterns, list):
        patterns = [p for p in patterns if isinstance(p, str) and p.strip()]

    def _filename_time_score(name: str) -> int:
        # Prefer timestamp embedded in filename (used by OSEPL-style Enercast names).
        # Example: essel_OSEPL_dayahead_2026-04-21-07-45+0530.csv -> 07:45 -> 465
        m = re.search(r"(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})", name)
        if not m:
            return 0
        d, hh, mm = m.group(1), m.group(2), m.group(3)
        if d != current_str:
            return 0
        try:
            return (int(hh) * 60) + int(mm)
        except Exception:
            return 0

    def _revision_score(name: str, match: "re.Match[str] | None") -> int:
        if match is not None:
            gd = match.groupdict()
            if "rev" in gd and gd.get("rev") is not None:
                try:
                    return int(str(gd.get("rev")))
                except Exception:
                    pass
            if "rev_alt" in gd and gd.get("rev_alt") is not None:
                try:
                    return int(str(gd.get("rev_alt")))
                except Exception:
                    pass
        m = re.search(r"DA(\d+)", name.upper())
        if m:
            try:
                return int(m.group(1))
            except Exception:
                return 0
        return 0

    first_rev = bool(
        fixed_revision_label
        and ("1ST" in fixed_revision_label.upper() or "FIRST" in fixed_revision_label.upper())
    )
    second_rev = bool(
        fixed_revision_label
        and ("2ND" in fixed_revision_label.upper() or "SECOND" in fixed_revision_label.upper())
    )

    if patterns:
        compiled: list[re.Pattern[str]] = []
        for raw in patterns:
            templated = raw.replace("{current_date}", current_str).replace("{next_date}", next_str)
            compiled.append(re.compile(templated))

        matches: list[tuple[Path, tuple[int, int, float]]] = []
        if day_ahead_dir.exists():
            for p in day_ahead_dir.glob("*.csv"):
                name = p.name
                best_match = None
                for rx in compiled:
                    m = rx.match(name)
                    if m:
                        best_match = m
                        break
                if best_match is None:
                    continue
                rev = _revision_score(name, best_match)
                gd = best_match.groupdict() if best_match is not None else {}
                hh = gd.get("hh")
                mm = gd.get("mm")
                time_score = 0
                if hh is not None and mm is not None:
                    try:
                        time_score = (int(str(hh)) * 60) + int(str(mm))
                    except Exception:
                        time_score = 0
                if time_score == 0:
                    time_score = _filename_time_score(name)
                matches.append((p, (rev, time_score, p.stat().st_mtime, name)))

        if matches:
            chooser = min if first_rev else max
            if second_rev:
                chooser = max
            return chooser(matches, key=lambda t: t[1])[0]

        raise FileNotFoundError(
            f"Day-ahead file not found for site={site_upper}. Tried regex={patterns} under {day_ahead_dir}"
        )

    files = [p for p in day_ahead_dir.glob("*.csv") if p.is_file()]
    if not files:
        raise FileNotFoundError(f"No day-ahead Enercast file found in {day_ahead_dir}")
    if first_rev:
        da0 = [p for p in files if "DA0" in p.name.upper()]
        pool = da0 if da0 else files
        return min(pool, key=lambda p: (_filename_time_score(p.name), p.stat().st_mtime, p.name))
    if second_rev:
        da2 = [p for p in files if "DA2" in p.name.upper()]
        pool = da2 if da2 else files
        return max(pool, key=lambda p: (_filename_time_score(p.name), p.stat().st_mtime, p.name))
    da1 = [p for p in files if "DA1" in p.name.upper()]
    pool = da1 if da1 else files
    return max(pool, key=lambda p: (_filename_time_score(p.name), p.stat().st_mtime, p.name))


def _normalize_status(status: str | None) -> str:
    if not status:
        return "NORMAL"
    status = str(status).strip().upper()
    if status in {"NORMAL", "SHUTDOWN", "CURTAILMENT"}:
        return status
    return "NORMAL"


def _normalize_control_site(site_id: str | None) -> str:
    cleaned = str(site_id or "").strip().upper()
    return cleaned or "ALL"


def _ddb_number(item: dict, key: str) -> float | None:
    attr = (item or {}).get(key)
    if attr and "N" in attr:
        try:
            return float(attr["N"])
        except Exception:
            return None
    return None


def _ddb_string(item: dict, key: str, default: str | None = None) -> str | None:
    attr = (item or {}).get(key)
    value = attr.get("S") if attr and "S" in attr else default
    if value is None:
        return None
    text = str(value).strip()
    return text or default


def _default_control_mode(status: str | None) -> str:
    normalized = _normalize_status(status)
    if normalized == "CURTAILMENT":
        return "AC"
    if normalized == "SHUTDOWN":
        return "FULL"
    return "NORMAL"

def _load_planned_windows() -> list[dict]:
    if not CONTROL_WINDOWS_TABLE:
        return []
    if boto3 is None:
        logger.warning("boto3 is not installed; skipping planned-window load")
        return []
    if Key is None:
        logger.warning("boto3 Key helper unavailable; skipping planned-window load")
        return []

    try:
        ddb = boto3.client("dynamodb")
        desc = ddb.describe_table(TableName=CONTROL_WINDOWS_TABLE)
        key_schema = desc.get("Table", {}).get("KeySchema", []) or []
        key_names = {str(k.get("AttributeName")) for k in key_schema if k.get("AttributeName")}

        items = []
        if "site_id" in key_names:
            site_token = _normalize_control_site(SITE_ID)
            query_keys = [site_token]
            if site_token != "ALL":
                query_keys.append("ALL")
            for query_key in query_keys:
                resp = ddb.query(
                    TableName=CONTROL_WINDOWS_TABLE,
                    KeyConditionExpression="#pk = :pk",
                    ExpressionAttributeNames={"#pk": "site_id"},
                    ExpressionAttributeValues={":pk": {"S": query_key}},
                    ConsistentRead=True,
                )
                items.extend(resp.get("Items", []) or [])
        else:
            resp = ddb.query(
                TableName=CONTROL_WINDOWS_TABLE,
                KeyConditionExpression="#pk = :pk",
                ExpressionAttributeNames={"#pk": "plant_id"},
                ExpressionAttributeValues={":pk": {"S": PLANT_ID}},
                ConsistentRead=True,
            )
            items = resp.get("Items", []) or []
        windows: list[dict] = []
        for item in items:
            start_raw = item.get("start_time", {}).get("S")
            end_raw = item.get("end_time", {}).get("S")
            if not start_raw or not end_raw:
                continue
            try:
                start_dt = datetime.fromisoformat(str(start_raw))
                end_dt = datetime.fromisoformat(str(end_raw))
            except Exception:
                logger.warning(
                    "Skipping planned window with invalid timestamps: start=%s end=%s",
                    start_raw,
                    end_raw,
                )
                continue
            status = _normalize_status(item.get("plant_status", {}).get("S"))
            windows.append(
                {
                    "plant_status": status,
                    "control_mode": (_ddb_string(item, "control_mode") or _default_control_mode(status)).upper(),
                    "curtailment_capacity": _ddb_number(item, "curtailment_capacity"),
                    "shutdown_reduction_mw": _ddb_number(item, "shutdown_reduction_mw"),
                    "start_time": start_dt,
                    "end_time": end_dt,
                    "site": item.get("site", {}).get("S") or item.get("site_id", {}).get("S"),
                    "window_id": item.get("window_id", {}).get("S"),
                    "active": True if item.get("active") is None else bool(item.get("active", {}).get("BOOL")),
                }
            )
        return windows
    except Exception:
        logger.exception("Failed to load planned windows from DynamoDB")
        return []


def _planned_window_for_block(block_start: datetime, windows: list[dict], site_id: str) -> tuple[str, float | None]:
    block_end = block_start + timedelta(minutes=15)
    planned_status = "NORMAL"
    planned_cap = None
    site_token = _normalize_control_site(site_id)
    partial_shutdown_seen = False

    for window in windows:
        if window.get("active") is False:
            continue
        window_site = _normalize_control_site(window.get("site"))
        if window_site not in {"ALL", site_token}:
            continue

        start_dt = window.get("start_time")
        end_dt = window.get("end_time")
        if start_dt is None or end_dt is None:
            continue
        cmp_block_start = block_start
        cmp_block_end = block_end
        if start_dt.tzinfo is not None:
            if cmp_block_start.tzinfo is None:
                cmp_block_start = cmp_block_start.replace(tzinfo=start_dt.tzinfo)
            else:
                cmp_block_start = cmp_block_start.astimezone(start_dt.tzinfo)
            if cmp_block_end.tzinfo is None:
                cmp_block_end = cmp_block_end.replace(tzinfo=start_dt.tzinfo)
            else:
                cmp_block_end = cmp_block_end.astimezone(start_dt.tzinfo)

        if end_dt <= cmp_block_start or start_dt >= cmp_block_end:
            continue

        status = _normalize_status(window.get("plant_status"))
        if status == "SHUTDOWN":
            mode = str(window.get("control_mode") or "").strip().upper()
            if mode != "DC":
                return "SHUTDOWN", None
            cap = effective_capacity_ac_mw(
                SITE_CONFIG,
                plant_status=status,
                control_mode=mode,
                shutdown_reduction_mw=window.get("shutdown_reduction_mw"),
            )
            planned_cap = cap if planned_cap is None else min(float(planned_cap), float(cap))
            planned_status = "SHUTDOWN"
            partial_shutdown_seen = True
        if status == "CURTAILMENT":
            cap = effective_capacity_ac_mw(
                SITE_CONFIG,
                plant_status=status,
                control_mode=window.get("control_mode"),
                curtailment_capacity_mw=window.get("curtailment_capacity"),
            )
            if cap is not None:
                planned_cap = cap if planned_cap is None else min(float(planned_cap), float(cap))
                if not partial_shutdown_seen:
                    planned_status = "CURTAILMENT"

    return planned_status, planned_cap

def _apply_curtailment_scale(mw: float, status: str, cap: float | None) -> float:
    normalized = _normalize_status(status)
    if normalized == "SHUTDOWN" and cap is None:
        return 0.0
    if normalized in {"CURTAILMENT", "SHUTDOWN"} and cap is not None:
        effective_cap = float(cap)
        if effective_cap > float(SITE_AC_CAPACITY_MW):
            effective_cap = float(SITE_AC_CAPACITY_MW)
        if float(SITE_AC_CAPACITY_MW) > 0:
            scale = effective_cap / float(SITE_AC_CAPACITY_MW)
            return min(mw * scale, effective_cap)
        return min(mw, effective_cap)
    return mw


def _submit_to_sldc_day_ahead(csv_path: Path, schedule_date: date) -> bool:
    try:
        from sldc_adapter import submit_to_sldc  # type: ignore
    except Exception:
        logger.warning(
            "submit_to_sldc adapter not available; skipping DA portal submit for %s",
            schedule_date.strftime("%Y-%m-%d"),
        )
        return False

    try:
        result = submit_to_sldc(
            schedule_csv=str(csv_path),
            schedule_type="day_ahead",
            schedule_date=schedule_date.strftime("%Y-%m-%d"),
            site_id=SITE_ID,
        )
        return bool(result) if result is not None else True
    except Exception:
        logger.warning("DAY_AHEAD_SUBMISSION_FAILED", exc_info=True)
        return False


def main() -> int:
    logger.info("===== GLOBAL1 DA ENGINE STARTED =====")
    now_ist = _resolve_engine_now_ist()
    run_date = now_ist.date()

    data_root = _pick_data_root_for_run_date(run_date)
    enercast_dir = data_root / "enercast_data"
    day_ahead_dir = enercast_dir / "day_ahead"
    next_date = run_date + timedelta(days=1)
    next_date_str = next_date.strftime("%Y-%m-%d")

    engine_block_raw = os.getenv("ENGINE_BLOCK_OVERRIDE", "").strip()
    if not engine_block_raw:
        raise ValueError("ENGINE_BLOCK_OVERRIDE is required for DA engine")
    try:
        engine_block = int(engine_block_raw)
    except Exception as exc:
        raise ValueError(f"ENGINE_BLOCK_OVERRIDE must be integer, got {engine_block_raw!r}") from exc
    if not (1 <= engine_block <= 96):
        raise ValueError(f"ENGINE_BLOCK_OVERRIDE must be 1..96, got {engine_block}")

    source_file = _resolve_day_ahead_source_file(
        site_id=SITE_ID,
        day_ahead_dir=day_ahead_dir,
        current_run_date=run_date,
        next_date=next_date,
        fixed_revision_label=DA_SCHEDULE_REASON_LABEL or None,
    )
    logger.info("DA SOURCE | file=%s", _rel_path(source_file))

    df_day_ahead = load_enercast_forecast_csv(source_file)
    da_map = (
        df_day_ahead.drop_duplicates("block", keep="last")
        .set_index("block")["forecast_mw"]
        .to_dict()
    )
    planned_windows = _load_planned_windows()

    da_output_dir = OUTPUT_ROOT / next_date_str / "Day-ahead"
    da_graph_dir = da_output_dir / "graphs"
    da_output_dir.mkdir(parents=True, exist_ok=True)
    da_graph_dir.mkdir(parents=True, exist_ok=True)

    jewli_morning_da_flat_blocks = (
        SITE_ID.upper() == "JEWLI"
        and (DA_SCHEDULE_REASON_LABEL or "").strip().lower() == "day-ahead 1st rev"
    )

    rows: list[dict] = []
    for b in range(1, 97):
        mw = float(da_map.get(b, 0.0) or 0.0)
        if jewli_morning_da_flat_blocks and 26 <= b <= 74:
            mw = 7.2
        start_ts = block_to_timestamp(next_date, b)
        block_status, block_cap = _planned_window_for_block(start_ts, planned_windows, SITE_ID)
        mw = _apply_curtailment_scale(mw, block_status, block_cap)
        end_ts = (pd.to_datetime(start_ts) + pd.Timedelta(minutes=15)).strftime("%Y-%m-%d %H:%M:%S")
        rows.append(
            {
                "block": b,
                "timestamp": start_ts,
                "start_time": start_ts,
                "end_time": end_ts,
                "algo_schedule_mw": round(mw, 3),
                "condition_used": "DAY_AHEAD_FORWARD",
                "BaseForecast": round(mw, 3),
                "EffectiveBaseForecast": round(mw, 3),
                "IntradayForecast_mw": round(mw, 3),
            }
        )

    da_csv_path = da_output_dir / f"schedule_from_{engine_block:02d}.csv"
    pd.DataFrame(rows).to_csv(da_csv_path, index=False)

    da_meta_path = da_csv_path.with_suffix(".meta.json")
    da_meta = {
        "schedule_file": _rel_path(da_csv_path),
        "schedule_type": "day_ahead",
        "schedule_reason": DA_SCHEDULE_REASON_LABEL or "Day-ahead",
        "engine_block": int(engine_block),
        "created_at_ist": datetime.now(IST).isoformat(),
        "source_forecast_file": source_file.name,
        "source_forecast_s3_path": (
            f"raw/{PLANT_ID}/{SITE_NAME}/{run_date.strftime('%Y-%m-%d')}/enercast_data/day_ahead/{source_file.name}"
        ),
        "schedule_for_date": next_date_str,
        "site_id": SITE_ID,
    }
    da_meta_path.write_text(json.dumps(da_meta, indent=2), encoding="utf-8")

    da_graph_target = da_graph_dir / f"schedule_from_{engine_block:02d}.html"
    try:
        generate_schedule_graph(
            schedule_csv=da_csv_path,
            intraday_df=df_day_ahead,
            metered_by_block=pd.Series(dtype=float),
            current_block=engine_block,
            output_dir=da_output_dir,
        )
        generated_default_graph = da_graph_dir / f"schedule_{engine_block:02d}.html"
        if generated_default_graph.exists() and generated_default_graph.resolve() != da_graph_target.resolve():
            generated_default_graph.replace(da_graph_target)
        elif not da_graph_target.exists():
            da_graph_target.write_text(
                "<html><body><h3>Day-ahead graph generation skipped</h3></body></html>",
                encoding="utf-8",
            )
    except Exception:
        logger.warning("Day-ahead graph generation failed; writing placeholder", exc_info=True)
        if not da_graph_target.exists():
            da_graph_target.write_text(
                "<html><body><h3>Day-ahead graph generation failed</h3></body></html>",
                encoding="utf-8",
            )

    _submit_to_sldc_day_ahead(da_csv_path, next_date)
    logger.info("Day-ahead schedule generated for %s (block=%s)", next_date_str, engine_block)
    logger.info("===== GLOBAL1 DA ENGINE COMPLETED =====")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

