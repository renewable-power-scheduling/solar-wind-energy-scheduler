from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path


@dataclass(frozen=True)
class UploadResult:
    uploaded_files: int
    uploaded_logs: int = 0


def upload_recent_files(*, s3_client, bucket: str, local_root: Path, s3_prefix: str, since_ts: float) -> int:
    if not bucket or s3_client is None or not local_root.exists():
        return 0
    uploaded = 0
    for path in sorted(local_root.rglob("*")):
        if not path.is_file():
            continue
        if path.stat().st_mtime < float(since_ts):
            continue
        rel = path.relative_to(local_root).as_posix()
        key = f"{s3_prefix.rstrip('/')}/{rel}"
        s3_client.upload_file(str(path), bucket, key)
        uploaded += 1
    return uploaded


def upload_outputs_for_run(
    *,
    s3_client,
    bucket: str,
    work_root: Path,
    generated_base_prefix: str,
    run_ts_ist: datetime,
    include_next_day_da: bool = False,
    since_ts: float | None = None,
) -> int:
    since = float(since_ts or 0.0)
    total = 0
    run_date_str = run_ts_ist.date().strftime("%Y-%m-%d")
    run_root = work_root / "outputs" / run_date_str
    total += upload_recent_files(
        s3_client=s3_client,
        bucket=bucket,
        local_root=run_root,
        s3_prefix=f"{generated_base_prefix}/outputs/{run_date_str}",
        since_ts=since,
    )

    if include_next_day_da:
        next_date_str = (run_ts_ist.date() + timedelta(days=1)).strftime("%Y-%m-%d")
        da_root = work_root / "outputs" / next_date_str / "Day-ahead"
        total += upload_recent_files(
            s3_client=s3_client,
            bucket=bucket,
            local_root=da_root,
            s3_prefix=f"{generated_base_prefix}/outputs/{next_date_str}/Day-ahead",
            since_ts=since,
        )

    return total


def upload_logs_for_run(
    *,
    s3_client,
    bucket: str,
    work_root: Path,
    generated_base_prefix: str,
    since_ts: float,
) -> int:
    return upload_recent_files(
        s3_client=s3_client,
        bucket=bucket,
        local_root=work_root / "logs",
        s3_prefix=f"{generated_base_prefix}/logs",
        since_ts=since_ts,
    )


def upload_current_run_artifacts(
    *,
    s3_client,
    bucket: str,
    work_root: Path,
    generated_base_prefix: str,
    run_ts_ist: datetime,
    since_ts: float,
    include_next_day_da: bool = False,
    include_logs: bool = True,
) -> UploadResult:
    uploaded_outputs = upload_outputs_for_run(
        s3_client=s3_client,
        bucket=bucket,
        work_root=work_root,
        generated_base_prefix=generated_base_prefix,
        run_ts_ist=run_ts_ist,
        include_next_day_da=include_next_day_da,
        since_ts=since_ts,
    )
    uploaded_logs = (
        upload_logs_for_run(
            s3_client=s3_client,
            bucket=bucket,
            work_root=work_root,
            generated_base_prefix=generated_base_prefix,
            since_ts=since_ts,
        )
        if include_logs
        else 0
    )
    return UploadResult(uploaded_files=uploaded_outputs + uploaded_logs, uploaded_logs=uploaded_logs)
