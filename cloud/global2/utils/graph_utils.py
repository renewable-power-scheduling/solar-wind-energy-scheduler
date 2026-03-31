from pathlib import Path
import os

import pandas as pd

from utils.site_config_loader import load_site_config

DEFAULT_PLANT_CAPACITY_MW = 5.10
DEFAULT_PENALTY_BAND_PCT = 0.10


def _normalize_penalty_band_fraction(raw_pct: float) -> float:
    return raw_pct / 100.0 if raw_pct > 1.0 else raw_pct


def _resolve_band_mw() -> float:
    site_id = os.getenv("SITE_ID", "GSNP").strip().upper()
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
    site_id = os.getenv("SITE_ID", "GSNP").strip().upper()
    try:
        cfg = load_site_config(site_id)
        return str(cfg.get("site_id", site_id)).strip().upper() or site_id
    except Exception:
        return site_id


def generate_schedule_graph(
    schedule_csv: Path,
    intraday_df: pd.DataFrame,
    current_block: int,
    output_dir: Path,
):
    """
    Create a line graph with:
      - Generated schedule
      - Intraday forecast (all blocks)
      - Tolerance bands around algo schedule and intraday forecast
    Saves an interactive HTML file under output_dir/graphs/.
    """
    try:
        import plotly.graph_objects as go
    except Exception:
        # Plotly not installed; skip graph generation
        return

    sched_df = pd.read_csv(schedule_csv)
    band_mw = _resolve_band_mw()

    # Title timestamp from schedule for the current block (12-hour format)
    title_suffix = f"Block {current_block}"
    if "timestamp" in sched_df.columns:
        ts_row = sched_df.loc[sched_df["block"] == current_block, "timestamp"]
        if not ts_row.empty and pd.notna(ts_row.iloc[0]):
            ts = pd.to_datetime(ts_row.iloc[0])
            date_str = ts.strftime("%b %d, %Y")
            time_str = ts.strftime("%I:%M %p").lstrip("0")
            title_suffix = f"{date_str} {time_str}"

    fig = go.Figure()

    fig.add_trace(
        go.Scatter(
            x=sched_df["block"],
            y=sched_df["algo_schedule_mw"],
            mode="lines+markers",
            name="Generated Schedule",
            line=dict(width=2.5, color="#1f77b4"),
        )
    )

    # Prefer schedule CSV intraday columns when available so graph always reflects
    # the exact values used by the engine.
    if "IntradayForecastRaw_mw" in sched_df.columns:
        fig.add_trace(
            go.Scatter(
                x=sched_df["block"],
                y=sched_df["IntradayForecastRaw_mw"],
                mode="lines+markers",
                name="Intraday Forecast (Raw)",
                line=dict(width=1.8, color="#9467bd"),
            )
        )

    if "IntradayForecastScaled_mw" in sched_df.columns:
        fig.add_trace(
            go.Scatter(
                x=sched_df["block"],
                y=sched_df["IntradayForecastScaled_mw"],
                mode="lines+markers",
                name="Intraday Forecast (Scaled)",
                line=dict(width=2.0, color="#ff7f0e"),
            )
        )
    else:
        fig.add_trace(
            go.Scatter(
                x=intraday_df["block"],
                y=intraday_df["forecast_mw"],
                mode="lines+markers",
                name="Enercast Intraday Forecast",
                line=dict(width=2.0, color="#ff7f0e"),
            )
        )

    if "IntradayForecast_mw" in sched_df.columns:
        intraday_series = sched_df["IntradayForecast_mw"].astype(float)
    elif "IntradayForecastScaled_mw" in sched_df.columns:
        intraday_series = sched_df["IntradayForecastScaled_mw"].astype(float)
    elif "IntradayForecastRaw_mw" in sched_df.columns:
        intraday_series = sched_df["IntradayForecastRaw_mw"].astype(float)
    else:
        intraday_series = sched_df["block"].map(intraday_df.set_index("block")["forecast_mw"]).astype(float)

    algo_series = sched_df["algo_schedule_mw"].astype(float)
    algo_max_tolerable = algo_series + band_mw
    algo_min_tolerable = algo_series - band_mw
    intraday_max_tolerable = intraday_series + band_mw
    intraday_min_tolerable = intraday_series - band_mw

    fig.add_trace(
        go.Scatter(
            x=sched_df["block"],
            y=algo_max_tolerable,
            mode="lines",
            name="Max Tolerable (Algo +/- Band)",
            line=dict(width=1.2, dash="dot", color="#7f7f7f"),
        )
    )

    fig.add_trace(
        go.Scatter(
            x=sched_df["block"],
            y=algo_min_tolerable,
            mode="lines",
            name="Min Tolerable (Algo +/- Band)",
            line=dict(width=1.2, dash="dot", color="#7f7f7f"),
        )
    )

    fig.add_trace(
        go.Scatter(
            x=sched_df["block"],
            y=intraday_max_tolerable,
            mode="lines",
            name="Max Tolerable (Intraday +/- Band)",
            line=dict(width=1.0, dash="dot", color="#8B4513"),
        )
    )

    fig.add_trace(
        go.Scatter(
            x=sched_df["block"],
            y=intraday_min_tolerable,
            mode="lines",
            name="Min Tolerable (Intraday +/- Band)",
            line=dict(width=1.0, dash="dot", color="#8B4513"),
        )
    )

    if "BaseForecast" in sched_df.columns:
        fig.add_trace(
            go.Scatter(
                x=sched_df["block"],
                y=sched_df["BaseForecast"],
                mode="lines+markers",
                name="Base Forecast (Raw)",
                line=dict(width=2.0, color="#2ca02c"),
            )
        )

    if "EffectiveBaseForecast" in sched_df.columns and "BaseForecast" in sched_df.columns:
        # Show only when curtailment/shutdown changed base values.
        eff_diff = (
            sched_df["EffectiveBaseForecast"].astype(float)
            - sched_df["BaseForecast"].astype(float)
        ).abs()
        should_plot_effective = bool((eff_diff > 1e-6).any())
    else:
        should_plot_effective = False

    if should_plot_effective:
        fig.add_trace(
            go.Scatter(
                x=sched_df["block"],
                y=sched_df["EffectiveBaseForecast"],
                mode="lines+markers",
                name="Base Forecast (Curtailment Applied)",
                line=dict(width=2.2, color="#d62728"),
            )
        )

    plant_label = _resolve_plant_label()
    fig.update_layout(
        title=dict(
            text=f"<b>{plant_label}</b> | Schedule vs Intraday ({title_suffix})",
            x=0.01,
            xanchor="left",
        ),
        xaxis_title="Block",
        yaxis_title="Power (MW)",
        hovermode="x unified",
        xaxis=dict(tickmode="linear", dtick=1),
        margin=dict(t=95),
    )
    fig.add_vline(
        x=current_block,
        line_width=2,
        line_dash="dash",
        line_color="#8c564b",
        annotation_text=f"Schedule block {current_block}",
        annotation_position="top left",
    )

    current_sched = sched_df.loc[sched_df["block"] == current_block, "algo_schedule_mw"]
    if not current_sched.empty and pd.notna(current_sched.iloc[0]):
        fig.add_trace(
            go.Scatter(
                x=[current_block],
                y=[float(current_sched.iloc[0])],
                mode="markers",
                name="Schedule Start Block",
                marker=dict(symbol="diamond", size=12, color="#8c564b"),
            )
        )

    graphs_dir = output_dir / "graphs"
    graphs_dir.mkdir(parents=True, exist_ok=True)
    out_html = graphs_dir / f"schedule_{current_block:02d}.html"
    fig.write_html(out_html, include_plotlyjs="cdn")
