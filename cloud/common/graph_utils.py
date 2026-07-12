from pathlib import Path
import os

import pandas as pd

from cloud.common.config_loader import load_site_config

DEFAULT_PLANT_CAPACITY_MW = 5.10
DEFAULT_PENALTY_BAND_PCT = 0.10


def _normalize_penalty_band_fraction(raw_pct: float) -> float:
    return raw_pct / 100.0 if raw_pct > 1.0 else raw_pct


def _resolve_band_mw() -> float:
    site_id = os.getenv("SITE_ID", "SIRMOUR").strip().upper()
    try:
        cfg = load_site_config(site_id)
    except Exception:
        return float(DEFAULT_PLANT_CAPACITY_MW) * float(DEFAULT_PENALTY_BAND_PCT)

    band_mw = cfg.get("penalty_band_mw")
    if band_mw is not None:
        return float(band_mw)

    plant_capacity = float(cfg.get("plant_capacity_mw", DEFAULT_PLANT_CAPACITY_MW))
    penalty_band_pct_raw = float(cfg.get("penalty_band_pct", DEFAULT_PENALTY_BAND_PCT))
    penalty_band_frac = _normalize_penalty_band_fraction(penalty_band_pct_raw)
    return plant_capacity * penalty_band_frac


def _resolve_plant_label() -> str:
    site_id = os.getenv("SITE_ID", "SIRMOUR").strip().upper()
    try:
        cfg = load_site_config(site_id)
        return str(cfg.get("site_id", site_id)).strip().upper() or site_id
    except Exception:
        return site_id


def generate_schedule_graph(
    schedule_csv: Path,
    intraday_df: pd.DataFrame,
    metered_by_block: pd.Series | None,
    current_block: int,
    output_dir: Path,
    intraday_rev_token: str | None = None,
    intraday_rev_label: str | None = None,
):
    try:
        import plotly.graph_objects as go
    except Exception:
        return

    sched_df = pd.read_csv(schedule_csv)

    if "block" not in intraday_df.columns and not intraday_df.empty:
        block_col = next((col for col in ("block", "Block", "BLOCK") if col in intraday_df.columns), None)
        forecast_col = next((col for col in ("forecast_mw", "forecast", "SchMW", "schmw", "schedule", "declaredForecast") if col in intraday_df.columns), None)
        if block_col is not None and forecast_col is not None:
            intraday_df = intraday_df[[block_col, forecast_col]].copy()
            intraday_df.columns = ["block", "forecast_mw"]
    if "block" not in intraday_df.columns:
        intraday_df = pd.DataFrame(columns=["block", "forecast_mw"])
    else:
        intraday_df = intraday_df.drop_duplicates("block", keep="first").sort_values("block")

    if metered_by_block is None:
        metered_by_block = pd.Series(dtype=float)
    elif not isinstance(metered_by_block, pd.Series):
        metered_by_block = pd.Series(metered_by_block, dtype=float)

    metered_series = sched_df["block"].map(metered_by_block)
    metered_before = metered_series.where(sched_df["block"] <= current_block)
    metered_after = metered_series.where(sched_df["block"] > current_block)

    band_mw = _resolve_band_mw()
    algo_series = sched_df["algo_schedule_mw"].astype(float)
    algo_max_tolerable = algo_series + band_mw
    algo_min_tolerable = algo_series - band_mw

    intraday_series = sched_df["block"].map(intraday_df.set_index("block")["forecast_mw"]).astype(float)
    intraday_max_tolerable = intraday_series + band_mw
    intraday_min_tolerable = intraday_series - band_mw

    title_suffix = f"Block {current_block}"
    if "timestamp" in sched_df.columns:
        ts_row = sched_df.loc[sched_df["block"] == current_block, "timestamp"]
        if not ts_row.empty and pd.notna(ts_row.iloc[0]):
            ts = pd.to_datetime(ts_row.iloc[0])
            date_str = ts.strftime("%b %d, %Y")
            time_str = ts.strftime("%I:%M %p").lstrip("0")
            title_suffix = f"{date_str} {time_str}"

    fig = go.Figure()

    fig.add_trace(go.Scatter(x=sched_df["block"], y=sched_df["algo_schedule_mw"], mode="lines+markers", name="Generated Schedule", line=dict(width=2.5, color="#1f77b4")))
    fig.add_trace(go.Scatter(x=intraday_df["block"], y=intraday_df["forecast_mw"], mode="lines+markers", name="Enercast Intraday Forecast", line=dict(width=2.0, color="#ff7f0e")))

    if metered_series.notna().any():
        fig.add_trace(go.Scatter(x=sched_df["block"], y=metered_before, mode="lines+markers", name="Metered up to revision", line=dict(width=2.0, color="#d62728")))
        fig.add_trace(go.Scatter(x=sched_df["block"], y=metered_after, mode="lines+markers", name="Metered after revision", line=dict(width=2.0, color="#000000")))

    if "BaseForecast" in sched_df.columns:
        fig.add_trace(go.Scatter(x=sched_df["block"], y=sched_df["BaseForecast"], mode="lines+markers", name="Base Forecast (Raw)", line=dict(width=2.0, color="#2ca02c")))

    if "EffectiveBaseForecast" in sched_df.columns and "BaseForecast" in sched_df.columns:
        eff_diff = (
            sched_df["EffectiveBaseForecast"].astype(float)
            - sched_df["BaseForecast"].astype(float)
        ).abs()
        should_plot_effective = bool((eff_diff > 1e-6).any())
    else:
        should_plot_effective = False

    if should_plot_effective:
        fig.add_trace(go.Scatter(x=sched_df["block"], y=sched_df["EffectiveBaseForecast"], mode="lines+markers", name="Base Forecast (Curtailment Applied)", line=dict(width=2.2, color="#d62728")))

    fig.add_trace(go.Scatter(x=sched_df["block"], y=algo_max_tolerable, mode="lines", name="Max Tolerable (Algo +/- Band)", line=dict(width=1.2, dash="dot", color="#7f7f7f")))
    fig.add_trace(go.Scatter(x=sched_df["block"], y=algo_min_tolerable, mode="lines", name="Min Tolerable (Algo +/- Band)", line=dict(width=1.2, dash="dot", color="#7f7f7f")))
    fig.add_trace(go.Scatter(x=sched_df["block"], y=intraday_max_tolerable, mode="lines", name="Max Tolerable (Intraday +/- Band)", line=dict(width=1.0, dash="dot", color="#8B4513")))
    fig.add_trace(go.Scatter(x=sched_df["block"], y=intraday_min_tolerable, mode="lines", name="Min Tolerable (Intraday +/- Band)", line=dict(width=1.0, dash="dot", color="#8B4513")))

    out_of_range = (
        (sched_df["algo_schedule_mw"] > intraday_max_tolerable)
        | (sched_df["algo_schedule_mw"] < intraday_min_tolerable)
    ) & intraday_max_tolerable.notna() & intraday_min_tolerable.notna()

    if out_of_range.any():
        fig.add_trace(go.Scatter(x=sched_df.loc[out_of_range, "block"], y=sched_df.loc[out_of_range, "algo_schedule_mw"], mode="markers", name="Out of Tolerance", marker=dict(symbol="x", size=10, color="#d62728")))

    plant_label = _resolve_plant_label()
    rev_text = ""
    if intraday_rev_label:
        rev_text = str(intraday_rev_label).strip()
    elif intraday_rev_token:
        rev_text = str(intraday_rev_token).strip()
    rev_suffix = f" | Intraday Revision: {rev_text}" if rev_text else ""

    fig.update_layout(
        title=dict(text=f"<b>{plant_label}</b> | Schedule vs Metered vs Intraday ({title_suffix}){rev_suffix}", x=0.01, xanchor="left"),
        xaxis_title="Block",
        yaxis_title="Power (MW)",
        hovermode="x unified",
        xaxis=dict(tickmode="linear", dtick=1),
        margin=dict(t=95),
    )
    fig.add_vline(x=current_block, line_width=2, line_dash="dash", line_color="#8c564b", annotation_text=f"Meter cutoff & schedule block {current_block}", annotation_position="top left")

    current_sched = sched_df.loc[sched_df["block"] == current_block, "algo_schedule_mw"]
    if not current_sched.empty and pd.notna(current_sched.iloc[0]):
        fig.add_trace(go.Scatter(x=[current_block], y=[float(current_sched.iloc[0])], mode="markers", name="Schedule Start Block", marker=dict(symbol="diamond", size=12, color="#8c564b")))

    graphs_dir = output_dir / "graphs"
    graphs_dir.mkdir(parents=True, exist_ok=True)
    suffix = ""
    if intraday_rev_token:
        safe = str(intraday_rev_token).strip()
        if safe:
            suffix = f"_{safe}"
    out_html = graphs_dir / f"schedule_{current_block:02d}{suffix}.html"
    fig.write_html(out_html, include_plotlyjs="cdn")


