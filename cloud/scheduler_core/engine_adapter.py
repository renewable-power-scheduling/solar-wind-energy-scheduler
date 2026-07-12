from __future__ import annotations

import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class EngineRunRequest:
    site_id: str
    forced_block: int
    run_ts_ist_iso: str
    engine_script: Path
    repo_root: Path
    work_root: Path | None = None
    schedule_reason_label: str | None = None
    da_only: bool = False
    intraday_trigger_key: str | None = None
    run_context_id: str | None = None
    trigger_type: str | None = None
    strict_payload_execution: bool = False
    data_root: Path | None = None
    output_root: Path | None = None
    log_root: Path | None = None
    raw_inputs_manifest: Path | None = None
    extra_env: dict[str, str] | None = None
    skip_fetcher_default: str = "1"
    skip_combined_csv: bool = True


def build_engine_env(request: EngineRunRequest, base_env: dict[str, str] | None = None) -> dict[str, str]:
    env = dict(base_env or os.environ)
    env["SKIP_FETCHER"] = os.getenv("SKIP_FETCHER", request.skip_fetcher_default)
    env["PYTHONPATH"] = str(request.repo_root)
    env["SITE_ID"] = request.site_id
    env["SITE_NAME"] = request.site_id
    env["ENGINE_BLOCK_OVERRIDE"] = str(int(request.forced_block))
    env["ENGINE_NOW_IST"] = str(request.run_ts_ist_iso)

    if request.run_context_id:
        env["RUN_CONTEXT_ID"] = str(request.run_context_id)

    if request.da_only and request.schedule_reason_label:
        env["RUN_DA_ONLY"] = "1"
        env["DA_SCHEDULE_REASON_LABEL"] = request.schedule_reason_label
    else:
        env.pop("RUN_DA_ONLY", None)
        env.pop("DA_SCHEDULE_REASON_LABEL", None)

    if request.schedule_reason_label and not request.da_only:
        env["INTRADAY_TRIGGER_ENABLED"] = "1"
        env["INTRADAY_TRIGGER_REASON_LABEL"] = request.schedule_reason_label

    if request.intraday_trigger_key:
        env["INTRADAY_TRIGGER_KEY"] = str(request.intraday_trigger_key)

    if request.trigger_type:
        env["SCHEDULER_TRIGGER_TYPE"] = str(request.trigger_type).strip().upper()

    if request.strict_payload_execution:
        env["STRICT_PAYLOAD_EXECUTION"] = "1"

    if request.raw_inputs_manifest and request.raw_inputs_manifest.exists():
        env["RAW_INPUTS_MANIFEST"] = str(request.raw_inputs_manifest)

    if request.data_root is not None:
        env["DATA_ROOT"] = str(request.data_root)
    if request.output_root is not None:
        env["OUTPUT_ROOT"] = str(request.output_root)
    if request.log_root is not None:
        env["LOG_ROOT"] = str(request.log_root)
    if request.skip_combined_csv:
        env["SKIP_COMBINED_CSV"] = "1"

    for key, value in (request.extra_env or {}).items():
        env[str(key)] = str(value)

    return env


def run_engine(request: EngineRunRequest) -> subprocess.CompletedProcess:
    if not request.engine_script.exists():
        raise FileNotFoundError(f"Missing engine script: {request.engine_script}")

    env = build_engine_env(request)
    cwd = str(request.work_root) if request.work_root is not None else None
    return subprocess.run(
        [sys.executable, str(request.engine_script)],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
    )
