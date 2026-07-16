from __future__ import annotations

import re
from typing import Any

from cloud.common.config_loader import load_site_config


_EXPLICIT_REVISION_RE = re.compile(r"_r(?P<revision>\d+)(?:\D|$)", re.IGNORECASE)
_TIMESTAMP_RE = re.compile(
    r"[-_](?P<hour>\d{2})[-:](?P<minute>\d{2})(?:[+-]\d{4})?\.csv$",
    re.IGNORECASE,
)


def _revision_from_configured_pattern(cfg: dict[str, Any], filename: str) -> int | None:
    patterns = ((cfg.get("file_patterns") or {}).get("intraday_filename_regex")) or (
        (cfg.get("file_patterns") or {}).get("intraday_filename_regexes")
    )
    if not patterns:
        return None
    if isinstance(patterns, str):
        patterns = [patterns]
    for raw_pattern in patterns:
        pattern = str(raw_pattern)
        pattern = pattern.replace("{current_date}", r"\d{4}-\d{2}-\d{2}")
        pattern = pattern.replace("{next_date}", r"\d{4}-\d{2}-\d{2}")
        pattern = pattern.replace("{date_iso}", r"\d{4}-\d{2}-\d{2}")
        pattern = pattern.replace("{date_yyyymmdd}", r"\d{8}")
        pattern = pattern.replace("{date_ddmmyy}", r"\d{6}")
        try:
            match = re.match(pattern, filename)
        except re.error:
            continue
        if not match:
            continue
        groups = match.groupdict()
        for key in ("revision", "rev", "r"):
            raw_revision = groups.get(key)
            if raw_revision:
                try:
                    return int(raw_revision)
                except ValueError:
                    return None
    return None


def resolve_intraday_revision(site_id: str, filename: str | None) -> dict[str, Any] | None:
    if not filename:
        return None

    name = str(filename).strip()
    explicit_match = _EXPLICIT_REVISION_RE.search(name)
    timestamp_match = _TIMESTAMP_RE.search(name)
    explicit_revision = int(explicit_match.group("revision")) if explicit_match else None
    file_time = (
        f"{timestamp_match.group('hour')}:{timestamp_match.group('minute')}"
        if timestamp_match
        else None
    )

    cfg = load_site_config(site_id)
    configured_revision = _revision_from_configured_pattern(cfg, name) if isinstance(cfg, dict) else None
    explicit_revision = explicit_revision if explicit_revision is not None else configured_revision
    revisions = cfg.get("intraday_revisions", []) if isinstance(cfg, dict) else []
    for item in revisions:
        try:
            revision = int(item["revision"])
            block = int(item["block"])
        except (KeyError, TypeError, ValueError):
            continue
        start = str(item.get("start") or "").strip()
        if explicit_revision == revision or (file_time and start == file_time):
            return {
                "revision": revision,
                "block": block,
                "start": start or None,
                "end": str(item.get("end") or "").strip() or None,
                "filename": name,
            }

    if explicit_revision is not None:
        return {
            "revision": explicit_revision,
            "block": None,
            "start": file_time,
            "end": None,
            "filename": name,
        }
    return None
