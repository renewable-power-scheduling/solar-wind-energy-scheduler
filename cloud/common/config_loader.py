from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

CONFIG_ROOT = Path(__file__).resolve().parents[1] / "configs" / "sites"
CREDENTIAL_DIRS = (
    Path(__file__).resolve().parents[1] / "configs" / "credentials",
)
SITE_ID_ALIASES = {
    "anjangaon": "ANJANGOAN",
    "sawada": "SAWDA",
}


def normalize_site_id(site_id: str) -> str:
    if not site_id:
        raise ValueError("site_id is required")
    normalized = str(site_id).strip().upper()
    return SITE_ID_ALIASES.get(normalized.lower(), normalized)


def config_path_for_site(site_id: str) -> Path:
    site_token = normalize_site_id(site_id)
    return CONFIG_ROOT / f"{site_token}.json"


def _load_json(path: Path) -> dict:
    if not path.exists():
        raise FileNotFoundError(f"Site config not found: {path}")
    with path.open("r", encoding="utf-8-sig") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError(f"Site config must be a JSON object: {path}")
    return payload


def _load_credentials(site_token: str) -> dict:
    try:
        import yaml
    except Exception as exc:
        raise RuntimeError("pyyaml is required to read credential YAML files") from exc

    credential_names = {
        f"{site_token.lower()}_ftp_credentials.yaml",
    }
    if site_token == "ANJANGOAN":
        credential_names.add("anjangoan_ftp_credentials.yaml")

    for directory in CREDENTIAL_DIRS:
        for filename in credential_names:
            path = directory / filename
            if not path.exists():
                continue
            with path.open("r", encoding="utf-8") as handle:
                payload = yaml.safe_load(handle) or {}
            return payload if isinstance(payload, dict) else {}
    return {}


def _apply_env_overrides(cfg: dict) -> dict:
    site_env = os.getenv("SITE_ID")
    if site_env:
        cfg["site_id"] = normalize_site_id(site_env)

    runtime = cfg.setdefault("runtime", {})
    run_once = os.getenv("RUN_ONCE")
    if run_once is not None:
        runtime["run_continuous"] = run_once.strip().lower() not in {"1", "true", "yes"}

    retry_seconds = os.getenv("RETRY_SECONDS_ON_ERROR")
    if retry_seconds:
        try:
            runtime["retry_seconds_on_error"] = int(retry_seconds)
        except ValueError:
            pass

    fetch_base_dir = os.getenv("FETCH_BASE_DIR")
    if fetch_base_dir:
        cfg.setdefault("paths", {})["base_dir"] = fetch_base_dir

    password = os.getenv("SITE_PASSWORD")
    if password:
        cfg.setdefault("connection", {})["password"] = password

    return cfg


@lru_cache(maxsize=None)
def load_site_config(site_id: str) -> dict:
    site_token = normalize_site_id(site_id)
    cfg = _load_json(config_path_for_site(site_token))
    creds = _load_credentials(site_token)

    conn = cfg.setdefault("connection", {})
    ftp_creds = creds.get("ftp", {}) if isinstance(creds, dict) else {}
    if isinstance(ftp_creds, dict):
        if ftp_creds.get("username") and not conn.get("username"):
            conn["username"] = ftp_creds["username"]
        if ftp_creds.get("password") and not conn.get("password"):
            conn["password"] = ftp_creds["password"]

    return _apply_env_overrides(cfg)


def list_site_ids() -> list[str]:
    return sorted(path.stem.upper() for path in CONFIG_ROOT.glob("*.json"))
