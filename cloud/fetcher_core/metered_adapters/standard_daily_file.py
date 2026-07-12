from __future__ import annotations

from datetime import datetime
from pathlib import Path

from cloud.fetcher_core.metered_adapters.base import (
    append_new_rows,
    metered_name_matches_run_date,
    pick_latest_metered_name,
    render_metered_filename,
)


def sync_standard_daily_file(*, client, cfg: dict, run_date: str, dirs: dict[str, Path], rel, logger) -> None:
    remote_dir = cfg["paths"]["remote_metered"]
    template = cfg.get("file_patterns", {}).get("metered_template")
    if not template:
        raise ValueError("file_patterns.metered_template is required")

    filename = render_metered_filename(template, run_date)
    remote_path = f"{remote_dir.rstrip('/')}/{filename}"
    local_file = dirs["metered"] / filename
    tmp_file = local_file.with_suffix(local_file.suffix + ".tmp")

    manifest = cfg.get("_fetch_manifest") if isinstance(cfg, dict) else None
    started_at = datetime.now().astimezone().isoformat()
    used_remote = remote_path
    fallback_used = False
    stale_fallback = False

    try:
        client.download(remote_path, tmp_file)
    except FileNotFoundError:
        names = client.list_names(remote_dir)
        fallback_name = pick_latest_metered_name(names, template)
        if not fallback_name:
            raise
        fallback_remote = f"{remote_dir.rstrip('/')}/{fallback_name}"
        used_remote = fallback_remote
        fallback_used = True
        stale_fallback = not metered_name_matches_run_date(fallback_name, run_date)
        if stale_fallback:
            finished_at = datetime.now().astimezone().isoformat()
            try:
                tmp_file.unlink(missing_ok=True)
            except Exception:
                logger.debug("Could not remove stale metered tmp file: %s", rel(tmp_file), exc_info=True)
            logger.warning(
                "Metered file missing for date %s (%s). Latest available %s is stale; skipping metered download.",
                run_date,
                filename,
                fallback_name,
            )
            if isinstance(manifest, dict):
                manifest.setdefault("raw_inputs", {}).setdefault("metered", []).append(
                    {
                        "requested_remote_path": remote_path,
                        "remote_path": used_remote,
                        "requested_local_path": rel(dirs["metered"] / filename),
                        "local_path": None,
                        "download_started_at_ist": started_at,
                        "download_finished_at_ist": finished_at,
                        "fallback_used": fallback_used,
                        "stale_fallback": stale_fallback,
                        "result": {"action": "skipped_stale_fallback", "appended_rows": None},
                        "size_bytes": None,
                    }
                )
            return
        logger.warning(
            "Metered file missing for date %s (%s). Falling back to latest available: %s",
            run_date,
            filename,
            fallback_name,
        )
        client.download(fallback_remote, tmp_file)

    finished_at = datetime.now().astimezone().isoformat()
    append_info = append_new_rows(tmp_file, local_file, rel=rel, logger=logger)
    if isinstance(manifest, dict):
        try:
            size_b = local_file.stat().st_size
        except Exception:
            size_b = None
        manifest.setdefault("raw_inputs", {}).setdefault("metered", []).append(
            {
                "requested_remote_path": remote_path,
                "remote_path": used_remote,
                "requested_local_path": rel(dirs["metered"] / filename),
                "local_path": rel(local_file),
                "download_started_at_ist": started_at,
                "download_finished_at_ist": finished_at,
                "fallback_used": fallback_used,
                "stale_fallback": stale_fallback,
                "result": append_info,
                "size_bytes": size_b,
            }
        )
