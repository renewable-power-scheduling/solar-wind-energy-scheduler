from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable

import pandas as pd


def write_schedule_artifacts(
    *,
    schedule_df: pd.DataFrame,
    out_file: Path,
    schedule_reason_label: str,
    schedule_reason_fields: dict,
    engine_block: int,
    window_id: int,
    importance: str | None,
    dynamic_start_block: int | None,
    now_ist: datetime,
    timezone,
    plant_status: str,
    curtailment_capacity: float | None,
    control_detail: dict,
    rel_path: Callable[[Path | None], str | None],
    logger,
) -> Path:
    schedule_df.to_csv(out_file, index=False)
    logger.info("Schedule generated: %s", rel_path(out_file))

    meta_path = out_file.with_suffix(".meta.json")
    meta_payload = {
        "schedule_file": rel_path(out_file),
        "schedule_reason": schedule_reason_label,
        "schedule_reason_category": schedule_reason_fields.get("category"),
        "schedule_reason_code": schedule_reason_fields.get("code"),
        "intraday_revision_no": schedule_reason_fields.get("intraday_revision_no"),
        "engine_block": int(engine_block),
        "submission_block": int(engine_block),
        "slot_id": int(window_id),
        "importance": importance,
        "dynamic_start_block": int(dynamic_start_block) if dynamic_start_block is not None else None,
        "run_timestamp_ist": now_ist.isoformat(),
        "effective_timestamp_ist": (now_ist + timedelta(minutes=45)).isoformat(),
        "created_at_ist": datetime.now(timezone).isoformat(),
        "plant_status": plant_status,
        "curtailment_capacity_mw": (
            float(curtailment_capacity) if curtailment_capacity is not None else None
        ),
        "control": control_detail,
        "control_mode": control_detail.get("control_mode"),
        "control_type": control_detail.get("control_type"),
        "shutdown_reduction_mw": control_detail.get("shutdown_reduction_mw"),
        "effective_control_capacity_ac_mw": control_detail.get("effective_control_capacity_ac_mw"),
        "site_ac_capacity_mw": control_detail.get("site_ac_capacity_mw"),
        "site_dc_capacity_mw": control_detail.get("site_dc_capacity_mw"),
        "dc_ac_ratio": control_detail.get("dc_ac_ratio"),
    }
    meta_path.write_text(json.dumps(meta_payload, indent=2), encoding="utf-8")
    logger.info("Schedule metadata generated: %s", rel_path(meta_path))
    return meta_path


def write_schedule_graph(
    *,
    generate_schedule_graph,
    schedule_csv: Path,
    intraday_df: pd.DataFrame,
    metered_df: pd.DataFrame,
    current_block: int,
    output_dir: Path,
    intraday_rev_token: str,
    intraday_rev_label: str,
    logger,
) -> None:
    try:
        metered_by_block = metered_df.groupby("block")["metered_mw"].mean()
        generate_schedule_graph(
            schedule_csv=schedule_csv,
            intraday_df=intraday_df,
            metered_by_block=metered_by_block,
            current_block=current_block,
            output_dir=output_dir,
            intraday_rev_token=intraday_rev_token,
            intraday_rev_label=intraday_rev_label,
        )
        logger.info("Schedule graph generated")
    except Exception:
        logger.exception("Failed to generate schedule graph")


def write_combined_csv(
    *,
    final_schedule_path: Path | None,
    df_intraday: pd.DataFrame,
    metered_df: pd.DataFrame,
    root_dir: Path,
    data_root: Path,
    combined_dir: Path,
    test_date: str,
    penalty_band_mw: float,
    rel_path: Callable[[Path | None], str | None],
    logger,
) -> None:
    try:
        if final_schedule_path is None:
            raise FileNotFoundError("No schedule file available for combined CSV")
        final_sched = pd.read_csv(final_schedule_path)
        blocks = list(range(1, 97))
        combined = pd.DataFrame({"block": blocks})
        intraday_unique = df_intraday.drop_duplicates("block", keep="first")

        combined["IntradayForecast_mw"] = combined["block"].map(
            intraday_unique.set_index("block")["forecast_mw"]
        )
        combined["BaseForecast"] = combined["block"].map(
            final_sched.set_index("block")["BaseForecast"]
        )
        if "EffectiveBaseForecast" in final_sched.columns:
            combined["EffectiveBaseForecast"] = combined["block"].map(
                final_sched.set_index("block")["EffectiveBaseForecast"]
            )
        combined["algo_schedule_mw"] = combined["block"].map(
            final_sched.set_index("block")["algo_schedule_mw"]
        )
        combined["Metered_mw"] = combined["block"].map(
            metered_df.groupby("block")["metered_mw"].mean()
        )

        submitted_path = root_dir / "submitted.csv"
        if not submitted_path.exists():
            submitted_path = data_root / "active" / "submitted.csv"

        if submitted_path.exists():
            submitted_df = pd.read_csv(submitted_path, skiprows=6)
            submitted_df.columns = ["Block", "Block Interval", "Availability", "Forecast"]
            combined["Vedanjay_Schedule"] = combined["block"].map(
                submitted_df.set_index("Block")["Forecast"]
            )
        else:
            logger.warning(
                "submitted.csv not found at %s; Vedanjay_Schedule will be empty",
                rel_path(submitted_path),
            )
            combined["Vedanjay_Schedule"] = pd.NA

        combined["Maximum tolerable schedule"] = combined["Metered_mw"] + penalty_band_mw
        combined["Minimum tolerable schedule"] = combined["Metered_mw"] - penalty_band_mw

        combined_cols = [
            "block",
            "IntradayForecast_mw",
            "BaseForecast",
        ]
        if "EffectiveBaseForecast" in combined.columns:
            combined_cols.append("EffectiveBaseForecast")
        combined_cols += [
            "algo_schedule_mw",
            "Metered_mw",
            "Vedanjay_Schedule",
            "Maximum tolerable schedule",
            "Minimum tolerable schedule",
        ]
        combined = combined[combined_cols]

        combined_dir.mkdir(parents=True, exist_ok=True)
        combined_path = combined_dir / f"{test_date}.csv"
        combined.to_csv(combined_path, index=False)
        logger.info("Combined CSV generated: %s", rel_path(combined_path))
    except Exception:
        logger.exception("Failed to generate Combined CSV")


