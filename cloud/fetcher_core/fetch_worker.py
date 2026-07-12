import argparse
import logging
import os
import re
import socket
import sys
import time
import traceback
from datetime import datetime, timezone, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
import json

import pandas as pd
import requests

try:
    import boto3
except ImportError:
    boto3 = None

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
PROJECT_ROOT = REPO_ROOT / "cloud"
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from cloud.common.config_loader import load_site_config
from cloud.fetcher_core.metered_adapters.ftp_snapshot_per_block import sync_snapshot_per_block
from cloud.fetcher_core.metered_adapters.standard_daily_file import sync_standard_daily_file

IST = ZoneInfo("Asia/Kolkata")

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
logger = logging.getLogger(__name__)

BUCKET = os.getenv("BUCKET", "").strip()
PLANT_ID = os.getenv("PLANT_ID", "vedanjay").strip()
_S3_CLIENT = boto3.client("s3") if (BUCKET and boto3 is not None) else None


class RemoteClient:
    def list_names(self, remote_dir: str) -> list[str]:
        raise NotImplementedError

    def download(self, remote_path: str, local_path: Path) -> None:
        raise NotImplementedError

    def get_modified_at(self, remote_path: str) -> datetime | None:
        raise NotImplementedError

    def close(self) -> None:
        raise NotImplementedError


class SFTPClient(RemoteClient):
    def __init__(self, host: str, port: int, username: str, password: str, timeout: int):
        import paramiko

        self._ssh = paramiko.SSHClient()
        self._ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        self._ssh.connect(host, port=port, username=username, password=password, timeout=timeout)
        self._sftp = self._ssh.open_sftp()

    def list_names(self, remote_dir: str) -> list[str]:
        return self._sftp.listdir(remote_dir)

    def download(self, remote_path: str, local_path: Path) -> None:
        local_path.parent.mkdir(parents=True, exist_ok=True)
        self._sftp.get(remote_path, str(local_path))

    def get_modified_at(self, remote_path: str) -> datetime | None:
        try:
            stat = self._sftp.stat(remote_path)
        except Exception:
            return None
        try:
            return datetime.fromtimestamp(float(stat.st_mtime), tz=timezone.utc).astimezone(IST)
        except Exception:
            return None

    def close(self) -> None:
        try:
            self._sftp.close()
        finally:
            self._ssh.close()


class FTPClient(RemoteClient):
    def __init__(
        self,
        host: str,
        port: int,
        username: str,
        password: str,
        timeout: int,
        use_tls: bool,
        use_epsv: bool,
    ):
        from ftplib import FTP, FTP_TLS, parse227, parse229

        class _ReusableFTP_TLS(FTP_TLS):
            def ntransfercmd(self, cmd, rest=None):
                conn, size = FTP.ntransfercmd(self, cmd, rest)
                if self._prot_p:
                    conn = self.context.wrap_socket(conn, server_hostname=self.host, session=self.sock.session)
                return conn, size

            def makepasv(self):
                if getattr(self, "use_epsv", False):
                    resp = self.sendcmd("EPSV")
                    peer = self.sock.getpeername()
                    host2, port2 = parse229(resp, peer)
                    host2 = self.sock.getpeername()[0]
                    return host2, port2
                resp = self.sendcmd("PASV")
                return parse227(resp)

        class _ReusableFTP(FTP):
            def makepasv(self):
                if getattr(self, "use_epsv", False):
                    resp = self.sendcmd("EPSV")
                    peer = self.sock.getpeername()
                    host2, port2 = parse229(resp, peer)
                    host2 = self.sock.getpeername()[0]
                    return host2, port2
                resp = self.sendcmd("PASV")
                return parse227(resp)

        self._ftp = _ReusableFTP_TLS(timeout=timeout) if use_tls else _ReusableFTP(timeout=timeout)
        self._ftp.connect(host, port)
        self._ftp.login(username, password)
        if use_tls:
            self._ftp.prot_p()
        self._ftp.use_epsv = use_epsv
        self._ftp.set_pasv(True)

    def list_names(self, remote_dir: str) -> list[str]:
        self._ftp.cwd(remote_dir)
        return self._ftp.nlst()

    def download(self, remote_path: str, local_path: Path) -> None:
        local_path.parent.mkdir(parents=True, exist_ok=True)
        with local_path.open("wb") as fh:
            self._ftp.retrbinary(f"RETR {remote_path}", fh.write)

    def get_modified_at(self, remote_path: str) -> datetime | None:
        try:
            response = self._ftp.sendcmd(f"MDTM {remote_path}")
        except Exception:
            return None
        parts = response.split()
        if not parts:
            return None
        stamp = parts[-1].strip()
        try:
            dt = datetime.strptime(stamp, "%Y%m%d%H%M%S")
        except Exception:
            return None
        return dt.replace(tzinfo=timezone.utc).astimezone(IST)

    def close(self) -> None:
        self._ftp.quit()


def _rel(path: Path) -> str:
    try:
        return str(path.relative_to(PROJECT_ROOT))
    except Exception:
        return str(path)


def _ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def _build_data_dirs(base_dir: Path, site_id: str, run_date: str) -> dict[str, Path]:
    root = base_dir / site_id.upper() / run_date
    out = {
        "root": root,
        "enercast": root / "enercast_data",
        "intraday": root / "enercast_data" / "intraday",
        "dayahead": root / "enercast_data" / "day_ahead",
        "metered": root / "metered_data",
    }
    for p in out.values():
        _ensure_dir(p)
    return out


def _raw_s3_key(site_id: str, run_date: str, category: str, fname: str) -> str:
    return f"raw/{PLANT_ID}/{site_id.upper()}/{run_date}/enercast_data/{category}/{fname}"


def _s3_object_exists(key: str) -> bool:
    if not BUCKET or _S3_CLIENT is None:
        return False
    try:
        _S3_CLIENT.head_object(Bucket=BUCKET, Key=key)
        return True
    except Exception:
        return False


def _normalize_arrival_timestamp(remote_modified_at: datetime | None, arrival_timezone: str | None) -> datetime | None:
    if remote_modified_at is None:
        return None
    if str(arrival_timezone or "").strip().upper() == "UTC":
        return remote_modified_at.replace(tzinfo=timezone.utc).astimezone(IST)
    return remote_modified_at


def _resolve_arrival_timestamp(remote_modified_at: datetime | None, fname: str, arrival_timezone: str | None) -> tuple[datetime, str]:
    if remote_modified_at is not None:
        if str(arrival_timezone or "").strip().upper() == "UTC":
            return remote_modified_at.replace(tzinfo=timezone.utc).astimezone(IST), "remote_changed_timestamp_utc_to_ist"
        return remote_modified_at, "remote_changed_timestamp"
    raise RuntimeError(f"Remote changed timestamp unavailable for forecast file: {fname}")


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Unified multi-site data fetcher")
    parser.add_argument("--site", default=os.getenv("SITE_ID", "ANJANGAON"), help="Site ID for the illios_power tree")
    parser.add_argument("--date", default=os.getenv("FETCH_DATE"), help="Target date YYYY-MM-DD")
    parser.add_argument("--run-once", action="store_true", help="Run once and exit")
    return parser.parse_args()


def _resolve_run_date(date_arg: str | None) -> str:
    if not date_arg:
        return datetime.now(IST).strftime("%Y-%m-%d")
    parsed = datetime.strptime(date_arg.strip(), "%Y-%m-%d")
    return parsed.strftime("%Y-%m-%d")


def _build_remote_client(cfg: dict) -> RemoteClient:
    import ftplib

    conn = cfg.get("connection", {})
    protocol = str(cfg.get("protocol", "sftp")).strip().lower()

    host = conn.get("host")
    port = int(conn.get("port", 22 if protocol == "sftp" else 21))
    username = conn.get("username")
    password = conn.get("password")
    timeout = int(conn.get("timeout", 30))

    if not host or not username or not password:
        raise ValueError("connection.host, connection.username and password are required")

    if protocol == "sftp":
        return SFTPClient(host, port, username, password, timeout)

    if protocol in {"ftp", "ftps"}:
        use_tls = bool(conn.get("tls", protocol == "ftps"))
        use_epsv = bool(conn.get("epsv", True))
        try:
            return FTPClient(
                host,
                port,
                username,
                password,
                timeout,
                use_tls=use_tls,
                use_epsv=use_epsv,
            )
        except ftplib.error_perm as exc:
            # Some FTP servers require explicit TLS and reject cleartext login.
            msg = str(exc).lower()
            if (not use_tls) and ("must use encryption" in msg or "secure" in msg):
                logger.warning("FTP server requires encryption; retrying with TLS enabled")
                return FTPClient(
                    host,
                    port,
                    username,
                    password,
                    timeout,
                    use_tls=True,
                    use_epsv=use_epsv,
                )
            raise

    raise ValueError(f"Unsupported protocol: {protocol}")


def _parse_forecast_meta(name: str, regex: re.Pattern[str], run_date: str) -> dict | None:
    m = regex.search(name)
    if not m:
        return None

    groups = m.groups()
    if len(groups) == 2:
        date_s, rev_s = groups
        if date_s != run_date:
            return None
        rev = int(rev_s)
        kind = "dayahead" if rev == 0 else "intraday"
        return {"kind": kind, "sort": rev, "name": name}

    # Pattern style can be either:
    #   (kind, date, revision) OR (date, kind, revision)
    # Examples:
    #   kothagudem_Intraday_2026-03-13_REMC_r1.csv
    #   kothagudem_2026-03-13_Intraday_REMC_r1.csv
    #   kothagudem_2026-03-13_dayahead_DA1.csv
    if len(groups) == 3:
        g1, g2, rev_s = groups
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(g1)):
            date_s, kind_raw = str(g1), str(g2)
        elif re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(g2)):
            kind_raw, date_s = str(g1), str(g2)
        else:
            return None
        if date_s != run_date:
            return None
        kind = str(kind_raw).strip().lower()
        rev = int(rev_s)
        return {"kind": kind, "sort": rev, "name": name}

    if len(groups) >= 4:
        kind_raw, date_s, hh, mm = groups[0], groups[1], groups[2], groups[3]
        if date_s != run_date:
            return None
        kind = str(kind_raw).strip().lower()
        ts = datetime.strptime(f"{date_s} {hh}:{mm}", "%Y-%m-%d %H:%M")
        return {"kind": kind, "sort": ts, "name": name}

    return None


def _parse_forecast_meta_fuzzy(name: str, run_date: str, site_id: str) -> dict | None:
    """
    Fallback matcher when regex does not fit exact remote naming.
    Requires:
      - site token in filename
      - date token (YYYY-MM-DD or YYYYMMDD)
      - intraday/dayahead keyword
    """
    lower = name.lower()
    site_token = str(site_id or "").strip().lower()
    if site_token and site_token not in lower:
        return None

    date_token_hyphen = run_date
    date_token_compact = run_date.replace("-", "")
    if date_token_hyphen not in lower and date_token_compact not in lower:
        return None

    if "intraday" in lower:
        kind = "intraday"
        # Prefer known revision suffixes: REMC_rN / rN
        m = re.search(r"(?:remc_r|_r|r)(\d+)", lower)
        if m:
            sort = int(m.group(1))
        else:
            # Last number in filename as weak fallback
            nums = re.findall(r"(\d+)", lower)
            sort = int(nums[-1]) if nums else 0
        return {"kind": kind, "sort": sort, "name": name}

    if "dayahead" in lower:
        kind = "dayahead"
        m = re.search(r"(?:_da|da)(\d+)", lower)
        sort = int(m.group(1)) if m else 0
        return {"kind": kind, "sort": sort, "name": name}

    return None


def _sync_forecasts(client: RemoteClient, cfg: dict, run_date: str, dirs: dict[str, Path]) -> None:
    remote_dir = cfg["paths"]["remote_forecasts"]
    pattern_cfg = cfg.get("file_patterns", {})

    # New config model: two explicit regexes (intraday + day-ahead).
    # Keep legacy `forecast_regex` as a fallback for older site configs.
    intraday_pat = pattern_cfg.get("intraday_filename_regex")
    dayahead_pat = pattern_cfg.get("day_ahead_filename_regex")
    legacy_pat = pattern_cfg.get("forecast_regex")

    next_date = (datetime.strptime(run_date, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")

    def _compile(pat: str) -> re.Pattern[str]:
        """
        Only substitute known date placeholders.
        Do not call str.format() here because regex quantifiers like {2}
        would be treated as positional placeholders and crash.
        """
        templated = (
            pat.replace("{current_date}", run_date)
               .replace("{next_date}", next_date)
        )
        return re.compile(templated, re.IGNORECASE)

    intraday_regex = _compile(intraday_pat) if isinstance(intraday_pat, str) and intraday_pat.strip() else None
    dayahead_regex = _compile(dayahead_pat) if isinstance(dayahead_pat, str) and dayahead_pat.strip() else None
    forecast_regex = re.compile(legacy_pat, re.IGNORECASE) if isinstance(legacy_pat, str) and legacy_pat.strip() else None

    names = client.list_names(remote_dir)
    matches: list[dict] = []
    for name in names:
        parsed = None

        # Preferred path: explicit patterns per kind.
        if intraday_regex is not None:
            m = intraday_regex.search(name)
            if m:
                gd = m.groupdict()
                if "rev" in gd and gd.get("rev") is not None:
                    sort = int(str(gd["rev"]))
                elif "rev_alt" in gd and gd.get("rev_alt") is not None:
                    sort = int(str(gd["rev_alt"]))
                elif "hh" in gd and "mm" in gd and gd.get("hh") and gd.get("mm"):
                    sort = datetime.strptime(f"{run_date} {gd['hh']}:{gd['mm']}", "%Y-%m-%d %H:%M")
                else:
                    # Fallback: try to parse revision from common intraday suffix.
                    mm2 = re.search(r"(?:remc_r|_r|r)(\d+)", name.lower())
                    sort = int(mm2.group(1)) if mm2 else 0
                parsed = {"kind": "intraday", "sort": sort, "name": name}

        if parsed is None and dayahead_regex is not None:
            m = dayahead_regex.search(name)
            if m:
                gd = m.groupdict()
                if "rev" in gd and gd.get("rev") is not None:
                    sort = int(str(gd["rev"]))
                elif "rev_alt" in gd and gd.get("rev_alt") is not None:
                    sort = int(str(gd["rev_alt"]))
                elif "hh" in gd and "mm" in gd and gd.get("hh") and gd.get("mm"):
                    sort = datetime.strptime(f"{run_date} {gd['hh']}:{gd['mm']}", "%Y-%m-%d %H:%M")
                else:
                    mm2 = re.search(r"DA(\d+)", name.upper())
                    sort = int(mm2.group(1)) if mm2 else 0
                parsed = {"kind": "dayahead", "sort": sort, "name": name}

        # Legacy fallback: single combined regex.
        if parsed is None and forecast_regex is not None:
            parsed = _parse_forecast_meta(name, forecast_regex, run_date)
            if not parsed:
                parsed = _parse_forecast_meta_fuzzy(name, run_date, str(cfg.get("site_id", "")))

        if parsed:
            matches.append(parsed)

    if not matches:
        logger.warning("No forecast files matched for site=%s date=%s", cfg.get("site_id"), run_date)
        return

    fetch_all_forecast_revisions = os.getenv("FETCH_ALL_FORECAST_REVISIONS", "").strip().lower() in {
        "1",
        "true",
        "yes",
    }
    latest_by_kind: dict[str, dict] = {}
    for item in matches:
        kind = item["kind"]
        prev = latest_by_kind.get(kind)
        if prev is None or item["sort"] > prev["sort"]:
            latest_by_kind[kind] = item

    manifest = cfg.get("_fetch_manifest") if isinstance(cfg, dict) else None

    def _write_forecast_sidecar_meta(
        *,
        fname: str,
        local_path: Path,
        arrival_timestamp: datetime,
    ) -> None:
        meta_path = local_path.with_suffix(".meta.json")
        payload = {"arrival_timestamp_ist": arrival_timestamp.isoformat()}
        try:
            meta_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        except Exception:
            logger.exception("Failed to write forecast meta: %s", _rel(meta_path))

    site_id = str(cfg.get("site_id", "UNKNOWN")).upper()

    for item in sorted(matches, key=lambda x: x["sort"]):
        kind = item["kind"]
        fname = item["name"]
        local_dir = dirs["dayahead"] if kind == "dayahead" else dirs["intraday"]
        local_path = local_dir / fname
        remote_path = f"{remote_dir.rstrip('/')}/{fname}"
        remote_modified_at = client.get_modified_at(remote_path)
        arrival_timezone = str(cfg.get("intraday_arrival_timezone", "Asia/Kolkata"))
        arrival_timestamp, arrival_source = _resolve_arrival_timestamp(remote_modified_at, fname, arrival_timezone)
        category = "day_ahead" if kind == "dayahead" else "intraday"
        s3_key = _raw_s3_key(site_id, run_date, category, fname)
        if local_path.exists() or _s3_object_exists(s3_key):
            action = "skipped_exists" if local_path.exists() else "skipped_existing_s3"
            if local_path.exists():
                _write_forecast_sidecar_meta(
                    fname=fname,
                    local_path=local_path,
                    arrival_timestamp=arrival_timestamp,
                )
            logger.info("Forecast %s already exists (%s), skipping", kind, fname)
            if isinstance(manifest, dict):
                manifest.setdefault("raw_inputs", {}).setdefault("enercast", {}).setdefault(
                    "day_ahead" if kind == "dayahead" else "intraday", []
                ).append(
                    {
                        "action": action,
                        "remote_dir": remote_dir,
                        "filename": fname,
                        "local_path": _rel(local_path) if local_path.exists() else None,
                        "s3_key": s3_key,
                        "changed_at_ist": arrival_timestamp.isoformat(),
                        "changed_at_display": arrival_timestamp.strftime("%d-%m-%Y %H:%M"),
                        "recorded_at_ist": datetime.now(IST).isoformat(),
                    }
                )
            continue
        started_at = datetime.now(IST).isoformat()
        client.download(remote_path, local_path)
        finished_at = datetime.now(IST).isoformat()
        logger.info("Downloaded forecast (%s): %s", kind, _rel(local_path))
        _write_forecast_sidecar_meta(
            fname=fname,
            local_path=local_path,
            arrival_timestamp=arrival_timestamp,
        )
        if isinstance(manifest, dict):
            try:
                size_b = local_path.stat().st_size
            except Exception:
                size_b = None
            manifest.setdefault("raw_inputs", {}).setdefault("enercast", {}).setdefault(
                "day_ahead" if kind == "dayahead" else "intraday", []
            ).append(
                {
                    "action": "downloaded",
                    "remote_path": remote_path,
                    "filename": fname,
                    "local_path": _rel(local_path),
                    "s3_key": s3_key,
                    "changed_at_ist": arrival_timestamp.isoformat(),
                    "changed_at_display": arrival_timestamp.strftime("%d-%m-%Y %H:%M"),
                    "download_started_at_ist": started_at,
                    "download_finished_at_ist": finished_at,
                    "size_bytes": size_b,
                }
            )

    for kind, item in latest_by_kind.items():
        logger.info("Latest %s forecast: %s", kind, item["name"])


def _sync_metered(client: RemoteClient, cfg: dict, run_date: str, dirs: dict[str, Path]) -> None:
    metered_cfg = cfg.get("metered", {}) if isinstance(cfg, dict) else {}
    metered_enabled = metered_cfg.get("enabled", True)
    if isinstance(metered_enabled, str):
        metered_enabled = metered_enabled.strip().lower() not in {"0", "false", "no", "off"}
    if not metered_enabled:
        manifest = cfg.get("_fetch_manifest") if isinstance(cfg, dict) else None
        if isinstance(manifest, dict):
            manifest.setdefault("raw_inputs", {}).setdefault("metered", []).append(
                {
                    "source": "metered_sync",
                    "status": "disabled",
                    "reason": "metered_disabled_in_config",
                }
            )
        logger.info("Metered sync disabled in config for site=%s", cfg.get("site_id"))
        return
    filename_mode = str(metered_cfg.get("filename_mode", "")).strip().lower()
    if filename_mode in {"disabled", "none", "skip"}:
        manifest = cfg.get("_fetch_manifest") if isinstance(cfg, dict) else None
        if isinstance(manifest, dict):
            manifest.setdefault("raw_inputs", {}).setdefault("metered", []).append(
                {
                    "source": "metered_sync",
                    "status": "disabled",
                    "reason": f"metered_filename_mode_{filename_mode}",
                }
            )
        logger.info("Metered sync skipped for site=%s due to filename_mode=%s", cfg.get("site_id"), filename_mode)
        return
    if filename_mode == "ftp_snapshot_per_block":
        sync_snapshot_per_block(
            client=client,
            cfg=cfg,
            run_date=run_date,
            dirs=dirs,
            ensure_dir=_ensure_dir,
            rel=_rel,
            logger=logger,
        )
        return
    sync_standard_daily_file(
        client=client,
        cfg=cfg,
        run_date=run_date,
        dirs=dirs,
        rel=_rel,
        logger=logger,
    )


def _iter_candidate_enercast_files(enercast_root: Path) -> list[Path]:
    out = []
    if not enercast_root.exists():
        return out
    for p in enercast_root.rglob("*.csv"):
        if p.is_file():
            out.append(p)
    return sorted(out, key=lambda x: x.stat().st_mtime, reverse=True)


def _normalize_date(raw: str, formats: list[str]) -> str | None:
    value = raw.strip()
    for fmt in formats:
        try:
            return datetime.strptime(value, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def _sync_once(cfg: dict, run_date: str) -> None:
    _sync_once_with_client(cfg, run_date, client=None)


def _sync_once_with_client(cfg: dict, run_date: str, client: RemoteClient | None = None) -> None:
    site_id = str(cfg.get("site_id", "UNKNOWN")).upper()
    base_dir = Path(
        os.getenv(
            "FETCH_BASE_DIR",
            cfg.get("paths", {}).get("base_dir", str(PROJECT_ROOT / "data")),
        )
    )
    if not base_dir.is_absolute():
        base_dir = (PROJECT_ROOT / base_dir).resolve()

    dirs = _build_data_dirs(base_dir, site_id, run_date)

    # Attach a fetch manifest into cfg (keeps signatures simple for now).
    manifest = {
        "site_id": site_id,
        "run_date": run_date,
        "manifest_created_at_ist": datetime.now(IST).isoformat(),
        "raw_inputs": {
            "enercast": {"day_ahead": [], "intraday": []},
            "metered": [],
        },
    }
    cfg["_fetch_manifest"] = manifest

    owns_client = client is None
    active_client: RemoteClient | None = client
    try:
        if active_client is None:
            active_client = _build_remote_client(cfg)
        _sync_forecasts(active_client, cfg, run_date, dirs)
        try:
            _sync_metered(active_client, cfg, run_date, dirs)
        except Exception as metered_exc:
            logger.exception(
                "Metered sync failed for site=%s date=%s; continuing with forecasts/weather fallback: %s",
                site_id,
                run_date,
                metered_exc,
            )
            manifest.setdefault("raw_inputs", {}).setdefault("metered", []).append(
                {
                    "source": "metered_sync",
                    "status": "failed",
                    "error": str(metered_exc),
                }
            )
    finally:
        if owns_client and active_client is not None:
            active_client.close()

    # Persist manifest inside the raw date root so scheduler can log it later.
    try:
        manifest_path = dirs["root"] / "fetch_manifest.json"
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        logger.info("Fetch manifest written: %s", _rel(manifest_path))
    except Exception:
        logger.exception("Failed to write fetch manifest")


def _seconds_until_next_15_minute() -> int:
    now = datetime.now(IST)
    total_seconds = now.minute * 60 + now.second
    return ((total_seconds // 900) + 1) * 900 - total_seconds


def main() -> None:
    args = _parse_args()
    cfg = load_site_config(args.site)
    runtime = cfg.get("runtime", {})

    run_continuous = bool(runtime.get("run_continuous", True))
    if os.getenv("RUN_ONCE", "").strip().lower() in {"1", "true", "yes"}:
        run_continuous = False
    if args.run_once:
        run_continuous = False

    retry_seconds = int(runtime.get("retry_seconds_on_error", 60))
    run_date = _resolve_run_date(args.date)

    while True:
        try:
            _sync_once(cfg, run_date)
            logger.info("Data sync complete for site=%s date=%s", cfg.get("site_id"), run_date)
        except Exception as exc:
            logger.exception("Data sync failed for site=%s date=%s: %s", cfg.get("site_id"), run_date, exc)
            traceback.print_exc()
            if not run_continuous:
                raise
            time.sleep(retry_seconds)
            continue

        if not run_continuous:
            break

        wait_s = _seconds_until_next_15_minute()
        logger.info("Sleeping %s seconds until next 15-minute boundary", wait_s)
        time.sleep(wait_s)


if __name__ == "__main__":
    main()
