from __future__ import annotations

import csv
import fnmatch
import re
from datetime import datetime
from pathlib import Path

from cloud.fetcher_core.metered_adapters.base import (
    infer_last_metered_snapshot_from_csv,
    parse_snapshot_dt_from_name,
    read_first_snapshot_row,
    render_metered_filename,
    render_metered_pattern,
    snapshot_block_fields,
)


def build_snapshot_metered_master(
    local_file: Path,
    ordered_remote_names: list[str],
    downloaded_files: dict[str, Path],
    *,
    power_col: str,
    power_unit: str,
    rel,
    logger,
) -> dict:
    header = ["site_code", "date", "block_no", "block_start", "block_end", "metered_mw", "source_file"]
    merged_rows: list[dict[str, str]] = []
    seen_blocks: set[tuple[str, int]] = set()
    scale = 1.0 if str(power_unit).strip().upper() in {"MW", "MEGAWATT", "MEGAWATTS"} else 0.001
    last_accepted_source = infer_last_metered_snapshot_from_csv(local_file, rel=rel, logger=logger)

    if local_file.exists():
        try:
            with local_file.open("r", newline="", encoding="utf-8-sig") as fh:
                reader = csv.DictReader(fh)
                for row in reader:
                    date_key = str(row.get("date") or row.get("block_end") or "")[:10]
                    raw_block = str(row.get("block_no") or "").strip()
                    try:
                        block_no = int(float(raw_block))
                    except ValueError:
                        continue
                    if not date_key:
                        continue
                    dedupe_key = (date_key, block_no)
                    if dedupe_key in seen_blocks:
                        continue
                    seen_blocks.add(dedupe_key)
                    merged_rows.append({name: str(row.get(name) or "") for name in header})
        except Exception:
            logger.warning("Failed to read existing metered master; rebuilding from snapshots: %s", rel(local_file))
            merged_rows = []
            seen_blocks = set()
            last_accepted_source = None

    candidate_remote_names = ordered_remote_names
    if last_accepted_source:
        if last_accepted_source in ordered_remote_names:
            candidate_remote_names = ordered_remote_names[ordered_remote_names.index(last_accepted_source) + 1 :]
        else:
            last_dt = parse_snapshot_dt_from_name(last_accepted_source)
            if last_dt is not None:
                candidate_remote_names = [
                    name
                    for name in ordered_remote_names
                    if (parse_snapshot_dt_from_name(name) or datetime.min) > last_dt
                ]

    for remote_name in candidate_remote_names:
        snapshot_path = downloaded_files[remote_name]
        _, row = read_first_snapshot_row(snapshot_path)
        if row is None:
            continue
        snapshot_dt = parse_snapshot_dt_from_name(remote_name)
        if snapshot_dt is None:
            continue
        lower_map = {str(name).strip().lower(): name for name in row.keys()}
        resolved_power_col = lower_map.get(str(power_col).strip().lower())
        if resolved_power_col is None:
            continue
        raw_power = str(row.get(resolved_power_col, "")).strip()
        try:
            metered_mw = float(raw_power) * scale
        except ValueError:
            continue

        site_match = re.match(r"([A-Z0-9]+)_", remote_name, re.IGNORECASE)
        site_code = site_match.group(1).upper() if site_match else "UNKNOWN"
        block_start, block_end, block_no = snapshot_block_fields(snapshot_dt)
        day_key = block_end[:10]
        dedupe_key = (day_key, block_no)
        if dedupe_key in seen_blocks:
            continue
        seen_blocks.add(dedupe_key)
        merged_rows.append(
            {
                "site_code": site_code,
                "date": day_key,
                "block_no": block_no,
                "block_start": block_start,
                "block_end": block_end,
                "metered_mw": round(metered_mw, 6),
                "source_file": remote_name,
            }
        )

    merged_rows.sort(key=lambda row: (row["date"], int(row["block_no"])))
    local_file.parent.mkdir(parents=True, exist_ok=True)
    with local_file.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=header)
        writer.writeheader()
        writer.writerows(merged_rows)

    skipped_late = max(0, len(ordered_remote_names) - len(candidate_remote_names))
    logger.info(
        "Metered snapshots consolidated: rows=%s new_candidates=%s skipped_previously_closed=%s -> %s",
        len(merged_rows),
        len(candidate_remote_names),
        skipped_late,
        rel(local_file),
    )
    return {
        "action": "appended_from_snapshots" if last_accepted_source else "rebuilt_from_snapshots",
        "snapshot_files": len(ordered_remote_names),
        "new_snapshot_candidates": len(candidate_remote_names),
        "skipped_previously_closed_snapshots": skipped_late,
        "consolidated_rows": len(merged_rows),
    }


def sync_snapshot_per_block(*, client, cfg: dict, run_date: str, dirs: dict[str, Path], ensure_dir, rel, logger) -> None:
    remote_dir = cfg["paths"]["remote_metered"]
    template = cfg.get("file_patterns", {}).get("metered_template")
    if not template:
        raise ValueError("file_patterns.metered_template is required")

    metered_cfg = cfg.get("metered", {}) if isinstance(cfg, dict) else {}
    source_power_col = str(
        metered_cfg.get("source_power_col")
        or metered_cfg.get("raw_power_col")
        or metered_cfg.get("power_col", "MW")
    ).strip()

    snapshot_glob = cfg.get("file_patterns", {}).get("metered_snapshot_glob", template)
    local_file = dirs["metered"] / render_metered_filename(template, run_date)
    manifest = cfg.get("_fetch_manifest") if isinstance(cfg, dict) else None
    started_at = datetime.now().astimezone().isoformat()
    names = client.list_names(remote_dir)
    pattern = render_metered_pattern(snapshot_glob, run_date)
    matched_names = [n for n in names if fnmatch.fnmatch(n, pattern)]
    if not matched_names:
        raise FileNotFoundError(f"No metered snapshot files matched pattern {pattern!r} in {remote_dir}")

    ordered_names = sorted(matched_names, key=lambda n: (parse_snapshot_dt_from_name(n) or datetime.min, n))
    tmp_dir = local_file.parent / ".metered_tmp" / Path(local_file.stem)
    ensure_dir(tmp_dir)
    downloaded_files: dict[str, Path] = {}
    for remote_name in ordered_names:
        remote_path = f"{remote_dir.rstrip('/')}/{remote_name}"
        tmp_path = tmp_dir / Path(remote_name).name
        client.download(remote_path, tmp_path)
        downloaded_files[remote_name] = tmp_path

    finished_at = datetime.now().astimezone().isoformat()
    append_info = build_snapshot_metered_master(
        local_file,
        ordered_names,
        downloaded_files,
        power_col=source_power_col,
        power_unit="KW",
        rel=rel,
        logger=logger,
    )
    for tmp_path in downloaded_files.values():
        tmp_path.unlink(missing_ok=True)
    try:
        tmp_dir.rmdir()
    except OSError:
        pass

    if isinstance(manifest, dict):
        try:
            size_b = local_file.stat().st_size
        except Exception:
            size_b = None
        manifest.setdefault("raw_inputs", {}).setdefault("metered", []).append(
            {
                "remote_dir": remote_dir,
                "remote_pattern": pattern,
                "local_path": rel(local_file),
                "download_started_at_ist": started_at,
                "download_finished_at_ist": finished_at,
                "result": append_info,
                "size_bytes": size_b,
            }
        )
