from pathlib import Path
import os

import pandas as pd

from cloud.common.config_constants import (
    ENERCAST_META_LINES,
    METERED_POWER_COL,
    METERED_TS_COL,
    CLAMP_NEGATIVE_METERED_TO_ZERO,
)
from cloud.common.time_utils import timestamp_to_block
from cloud.common.config_loader import load_site_config


def _norm_header_token(x: str) -> str:
    return str(x).strip().lower().replace(".", "").replace(" ", "").replace("_", "")


def _get_site_forecast_column_normalized() -> str | None:
    site_id = os.getenv("SITE_ID", "").strip().upper()
    if not site_id:
        return None
    try:
        cfg = load_site_config(site_id)
        col = (cfg.get("enercast", {}) or {}).get("forecast_column")
        if col:
            return _norm_header_token(str(col))
    except Exception:
        return None
    return None


def load_enercast_forecast_csv(path: Path):
    if not path.exists():
        raise FileNotFoundError(f"Enercast file not found: {path}")

    rows = []

    with open(path, "r", encoding="utf-8") as f:
        lines = [ln.strip() for ln in f.readlines() if ln.strip()]

    if not lines:
        raise ValueError(f"Enercast file is empty: {path}")

    def _norm(x: str) -> str:
        return _norm_header_token(x)

    def _looks_like_header(parts: list[str]) -> bool:
        if not parts:
            return False
        first = _norm(parts[0])
        has_time = any(_norm(p) in {"from", "to"} for p in parts)
        has_forecast_col = any(
            _norm(p) in {"forecast", "schmw", "schedule", "declaredforecast"} for p in parts
        )
        if first in {"block", "blkno", "blk", "sno"}:
            return True
        return has_time and has_forecast_col

    header_idx = None
    for i, line in enumerate(lines):
        parts = [p.strip() for p in line.split(",")]
        if _looks_like_header(parts):
            header_idx = i
            break

    if header_idx is None:
        header_idx = min(ENERCAST_META_LINES, max(0, len(lines) - 1))

    header = [p.strip() for p in lines[header_idx].split(",")]
    header_norm = [_norm(h) for h in header]

    forecast_idx = None
    strict_forecast_col = _get_site_forecast_column_normalized()
    if strict_forecast_col:
        for idx, h in enumerate(header_norm):
            if h == strict_forecast_col:
                forecast_idx = idx
                break

    preferred = {"forecast", "schmw", "schedule", "declaredforecast"}
    if forecast_idx is None:
        for idx, h in enumerate(header_norm):
            if h in preferred:
                forecast_idx = idx
                break

    data_start = header_idx + 1

    if data_start < len(lines):
        h2 = [p.strip() for p in lines[data_start].split(",")]
        h2_norm = [_norm(h) for h in h2]
        if strict_forecast_col and strict_forecast_col in h2_norm:
            forecast_idx = h2_norm.index(strict_forecast_col)
            data_start += 1
        elif any(h in preferred for h in h2_norm):
            for idx, h in enumerate(h2_norm):
                if h in preferred:
                    forecast_idx = idx
                    break
            data_start += 1

    if forecast_idx is None:
        availability_idx = None
        for idx, h in enumerate(header_norm):
            if "availability" in h or h in {"avcmw", "availcap", "availabilitycapacity"}:
                availability_idx = idx
                break
        if availability_idx is not None and availability_idx > 0:
            forecast_idx = availability_idx - 1
        else:
            forecast_idx = len(header) - 1

    for line in lines[data_start:]:
        parts = [p.strip() for p in line.split(",")]
        if not parts:
            continue
        try:
            block = int(parts[0])
        except Exception:
            continue
        if forecast_idx >= len(parts):
            continue
        try:
            forecast_mw = float(parts[forecast_idx])
        except Exception:
            continue

        rows.append({"block": block, "forecast_mw": forecast_mw, "_row_order": len(rows)})

    if not rows:
        raise ValueError(f"No valid forecast rows found in {path}")

    # Some site files contain two complete 1-96 sections in one CSV. Keep the
    # first occurrence from the file, then sort back to block order.
    df = pd.DataFrame(rows)
    df = (
        df.sort_values("_row_order")
        .drop_duplicates("block", keep="first")
        .sort_values("block")
        .drop(columns=["_row_order"])
        .reset_index(drop=True)
    )
    return df


def load_metered_csv(path: Path) -> pd.DataFrame:
    if not path.exists():
        raise FileNotFoundError(f"Metered file not found: {path}")

    df = pd.read_csv(path)

    if METERED_TS_COL not in df.columns:
        raise ValueError(f"Metered CSV missing Timestamp column: {METERED_TS_COL}")
    if METERED_POWER_COL not in df.columns:
        raise ValueError(f"Metered CSV missing power column: {METERED_POWER_COL}")

    out = df[[METERED_TS_COL, METERED_POWER_COL]].copy()
    out.columns = ["timestamp", "metered_kw"]

    out["timestamp"] = pd.to_datetime(out["timestamp"], errors="coerce")
    out["metered_kw"] = pd.to_numeric(out["metered_kw"], errors="coerce")

    out = out.dropna(subset=["timestamp"]).copy()
    out["metered_mw"] = out["metered_kw"] / 1000.0

    if CLAMP_NEGATIVE_METERED_TO_ZERO:
        out.loc[out["metered_mw"] < 0, "metered_mw"] = 0.0

    out["block"] = out["timestamp"].apply(timestamp_to_block).astype(int)

    out = out[["block", "timestamp", "metered_mw"]].sort_values("timestamp").reset_index(drop=True)
    return out



