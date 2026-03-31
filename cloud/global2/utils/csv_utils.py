# utils/csv_utils.py
import os
from pathlib import Path
import pandas as pd

from config.constants import ENERCAST_META_LINES
from utils.site_config_loader import load_site_config


def _resolve_forecast_column_candidates() -> list[str]:
    """
    Resolve site-specific forecast column name(s) from config.
    Example: enercast.forecast_column = "CME"
    """
    site_id = os.getenv("SITE_ID", "GSNP").strip()
    candidates: list[str] = []
    try:
        cfg = load_site_config(site_id)
        col_cfg = cfg.get("enercast", {}).get("forecast_column")
        if isinstance(col_cfg, str) and col_cfg.strip():
            candidates.append(col_cfg.strip())
        elif isinstance(col_cfg, list):
            for v in col_cfg:
                if isinstance(v, str) and v.strip():
                    candidates.append(v.strip())
    except Exception:
        pass

    # Backward-compatible fallbacks.
    candidates.extend(["Forecast", "SIRMOUR"])
    return candidates

# ------------------------------------------------------------
# Enercast parser for your exact format:
# - first 4 lines metadata
# - then 2 header rows
# - contains columns: BLOCK, Block Interval, Availability, Forecast
# ------------------------------------------------------------

def load_enercast_forecast_csv(path: Path):
    """
    Bulletproof Enercast parser (NO pandas).
    Assumptions (verified from your files):
    - Data rows start after metadata
    - First column = BLOCK
    - Last column = Forecast MW
    """

    if not path.exists():
        raise FileNotFoundError(f"Enercast file not found: {path}")

    rows = []

    with open(path, "r", encoding="utf-8") as f:
        lines = f.readlines()

    header = None
    forecast_idx = None
    pending_second_header = False
    forecast_candidates = [c.lower() for c in _resolve_forecast_column_candidates()]

    # Skip metadata lines
    for line in lines[ENERCAST_META_LINES:]:
        line = line.strip()
        if not line:
            continue

        parts = [p.strip() for p in line.split(",")]

        if header is None:
            header = [h.strip() for h in parts]
            header_lower = [h.lower() for h in header]
            for cand in forecast_candidates:
                if cand in header_lower:
                    forecast_idx = header_lower.index(cand)
                    break
            if forecast_idx is None:
                forecast_idx = len(header) - 1
            pending_second_header = True
            continue

        if pending_second_header:
            # Handle two-row headers: e.g. row contains "Availability,Forecast"
            pending_second_header = False
            header2_lower = [p.lower() for p in parts]
            matched = False
            for cand in forecast_candidates:
                if cand in header2_lower:
                    forecast_idx = header2_lower.index(cand)
                    matched = True
                    break
            if matched:
                continue

        # BLOCK must be numeric
        try:
            block = int(parts[0])
        except Exception:
            continue  # skip headers / garbage rows

        # Forecast from resolved column
        try:
            forecast_mw = float(parts[forecast_idx])
        except Exception:
            continue

        rows.append({
            "block": block,
            "forecast_mw": forecast_mw
        })

    if not rows:
        raise ValueError(f"No valid forecast rows found in {path}")

    import pandas as pd
    df = pd.DataFrame(rows).sort_values("block").reset_index(drop=True)
    return df
