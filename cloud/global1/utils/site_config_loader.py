import json
import os
from pathlib import Path


_THIS_FILE = Path(__file__).resolve()
_PROJECT_ROOT = _THIS_FILE.parents[1]
_SITES_DIR = _PROJECT_ROOT / "config" / "sites"
_CREDENTIALS_DIR = _PROJECT_ROOT / "config" / "credentials"


def _normalize_site_id(site_id: str) -> str:
    if not site_id:
        raise ValueError("site_id is required")
    return site_id.strip().lower()


def _load_json(path: Path) -> dict:
    if not path.exists():
        raise FileNotFoundError(f"Site config not found: {path}")
    with path.open("r", encoding="utf-8-sig") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ValueError(f"Site config must be a JSON object: {path}")
    return data


def _load_credentials(site_key: str) -> dict:
    """
    Optional YAML credentials file:
      config/credentials/<site_key>_ftp_credentials.yaml
    """
    cred_path = _CREDENTIALS_DIR / f"{site_key}_ftp_credentials.yaml"
    if not cred_path.exists():
        return {}

    try:
        import yaml
    except Exception as exc:
        raise RuntimeError("pyyaml is required to read credential YAML files") from exc

    with cred_path.open("r", encoding="utf-8") as fh:
        payload = yaml.safe_load(fh) or {}
    return payload if isinstance(payload, dict) else {}


def _apply_env_overrides(cfg: dict) -> dict:
    # Keep this deliberately narrow: only known keys are overridden.
    site_env = os.getenv("SITE_ID")
    if site_env:
        cfg["site_id"] = site_env.strip().upper()

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


def load_site_config(site_id: str) -> dict:
    site_key = _normalize_site_id(site_id)
    cfg = _load_json(_SITES_DIR / f"{site_key}.json")
    creds = _load_credentials(site_key)

    conn = cfg.setdefault("connection", {})
    ftp_creds = creds.get("ftp", {}) if isinstance(creds, dict) else {}
    if isinstance(ftp_creds, dict):
        if ftp_creds.get("username") and not conn.get("username"):
            conn["username"] = ftp_creds["username"]
        if ftp_creds.get("password") and not conn.get("password"):
            conn["password"] = ftp_creds["password"]

    return _apply_env_overrides(cfg)


def list_site_ids() -> list[str]:
    if not _SITES_DIR.exists():
        return []
    out = []
    for path in sorted(_SITES_DIR.glob("*.json")):
        out.append(path.stem.upper())
    return out
