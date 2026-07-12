from __future__ import annotations

import json
import os
from pathlib import Path


def load_state(state_path: Path) -> dict:
    if not state_path.exists():
        return {}
    try:
        return json.loads(state_path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_state(state_path: Path, state: dict) -> None:
    state_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = state_path.with_suffix(state_path.suffix + ".tmp")
    payload = json.dumps(state, indent=2)
    with tmp_path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp_path, state_path)


def create_schedule_state(
    *,
    state: dict,
    source: str,
    current_block_key: str,
    dynamic_start_block: int,
    active_state_value: str,
    run_context_id: str,
    logger,
) -> bool:
    if state.get("last_schedule_block_timestamp") == current_block_key:
        logger.info(
            "Duplicate schedule guard hit | run_id=%s | block=%s",
            run_context_id,
            current_block_key,
        )
        return False

    state["schedule_exists"] = True
    state["engine_state"] = active_state_value
    state["dynamic_start_block"] = int(dynamic_start_block)
    state["last_schedule_block_timestamp"] = current_block_key
    logger.info("Schedule created: %s", source)
    return True


def regenerate_schedule_state(
    *,
    state: dict,
    source: str,
    current_block_key: str,
    active_state_value: str,
    run_context_id: str,
    logger,
) -> bool:
    if state.get("last_schedule_block_timestamp") == current_block_key:
        logger.info(
            "Duplicate schedule guard hit | run_id=%s | block=%s",
            run_context_id,
            current_block_key,
        )
        return False

    state["schedule_exists"] = True
    state["engine_state"] = active_state_value
    state["last_schedule_block_timestamp"] = current_block_key
    logger.info("Schedule regenerated: %s", source)
    return True
