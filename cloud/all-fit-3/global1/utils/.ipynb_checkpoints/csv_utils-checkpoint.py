# utils/csv_utils.py
from pathlib import Path
import pandas as pd

from config.constants import (
    ENERCAST_META_LINES,
    METERED_POWER_COL,
    METERED_TS_COL,
    CLAMP_NEGATIVE_METERED_TO_ZERO
)
from utils.time_utils import timestamp_to_block

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

    # Skip metadata lines
    for line in lines[ENERCAST_META_LINES:]:
        line = line.strip()
        if not line:
            continue

        parts = [p.strip() for p in line.split(",")]

        # BLOCK must be numeric
        try:
            block = int(parts[0])
        except Exception:
            continue  # skip headers / garbage rows

        # Forecast is last column
        try:
            forecast_mw = float(parts[-1])
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





# ------------------------------------------------------------
# Metered parser for your exact format:
# - Timestamp column
# - Active Power-avg ... (kW) column
# ------------------------------------------------------------

def load_metered_csv(path: Path) -> pd.DataFrame:
    """
    Returns dataframe with:
    block (int), metered_mw (float), timestamp (datetime)
    """
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

    # Convert to MW
    out["metered_mw"] = out["metered_kw"] / 1000.0

    # Clamp negative noise
    if CLAMP_NEGATIVE_METERED_TO_ZERO:
        out.loc[out["metered_mw"] < 0, "metered_mw"] = 0.0

    # Create block
    out["block"] = out["timestamp"].apply(timestamp_to_block).astype(int)

    out = out[["block", "timestamp", "metered_mw"]].sort_values("timestamp").reset_index(drop=True)
    return out
