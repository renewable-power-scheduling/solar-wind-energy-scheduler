import argparse
import csv
import fnmatch
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

import openmeteo_requests
import pandas as pd
import requests
import requests_cache
from retry_requests import retry

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from utils.site_config_loader import load_site_config

IST = ZoneInfo("Asia/Kolkata")

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
logger = logging.getLogger(__name__)


class RemoteClient:
    def list_names(self, remote_dir: str) -> list[str]:
        raise NotImplementedError

    def download(self, remote_path: str, local_path: Path) -> None:
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
        "weather": root / "weather_data",
    }
    for p in out.values():
        _ensure_dir(p)
    return out


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Unified multi-site data fetcher")
    parser.add_argument("--site", default=os.getenv("SITE_ID", "SIRMOUR"), help="Site ID, e.g. SIRMOUR or GSNP")
    parser.add_argument("--date", default=os.getenv("FETCH_DATE"), help="Target date YYYY-MM-DD")
    parser.add_argument("--run-once", action="store_true", help="Run once and exit")
    return parser.parse_args()


def _resolve_run_date(date_arg: str | None) -> str:
    if not date_arg:
        return datetime.now(IST).strftime("%Y-%m-%d")
    datetime.strptime(date_arg.strip(), "%Y-%m-%d")
    return date_arg.strip()


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

    latest_by_kind: dict[str, dict] = {}
    for item in matches:
        kind = item["kind"]
        prev = latest_by_kind.get(kind)
        if prev is None or item["sort"] > prev["sort"]:
            latest_by_kind[kind] = item

    manifest = cfg.get("_fetch_manifest") if isinstance(cfg, dict) else None

    for item in sorted(matches, key=lambda x: x["sort"]):
        kind = item["kind"]
        fname = item["name"]
        local_dir = dirs["dayahead"] if kind == "dayahead" else dirs["intraday"]
        local_path = local_dir / fname
        if local_path.exists():
            if isinstance(manifest, dict):
                manifest.setdefault("raw_inputs", {}).setdefault("enercast", {}).setdefault(
                    "day_ahead" if kind == "dayahead" else "intraday", []
                ).append(
                    {
                        "action": "skipped_exists",
                        "remote_dir": remote_dir,
                        "filename": fname,
                        "local_path": _rel(local_path),
                        "recorded_at_ist": datetime.now(IST).isoformat(),
                    }
                )
            continue
        remote_path = f"{remote_dir.rstrip('/')}/{fname}"
        started_at = datetime.now(IST).isoformat()
        client.download(remote_path, local_path)
        finished_at = datetime.now(IST).isoformat()
        logger.info("Downloaded forecast (%s): %s", kind, _rel(local_path))
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
                    "download_started_at_ist": started_at,
                    "download_finished_at_ist": finished_at,
                    "size_bytes": size_b,
                }
            )

    for kind, item in latest_by_kind.items():
        logger.info("Latest %s forecast: %s", kind, item["name"])


def _render_metered_filename(template: str, run_date: str) -> str:
    dt = datetime.strptime(run_date, "%Y-%m-%d")
    return template.format(
        date_iso=run_date,
        date_yyyymmdd=dt.strftime("%Y%m%d"),
        date_yyyy_mm_dd=dt.strftime("%Y_%m_%d"),
    )


def _metered_template_to_glob(template: str) -> str:
    pattern = template
    for token in ("{date_iso}", "{date_yyyymmdd}", "{date_yyyy_mm_dd}"):
        pattern = pattern.replace(token, "*")
    return pattern


def _pick_latest_metered_name(names: list[str], template: str) -> str | None:
    pattern = _metered_template_to_glob(template)
    candidates = [n for n in names if fnmatch.fnmatch(n, pattern)]
    if not candidates:
        candidates = [n for n in names if n.lower().endswith(".csv")]
    if not candidates:
        return None
    # For date-formatted filenames, lexicographic max usually means latest.
    return max(candidates)


def _append_new_rows(tmp_file: Path, local_file: Path) -> dict:
    if not local_file.exists():
        tmp_file.replace(local_file)
        logger.info("Metered file initialized: %s", _rel(local_file))
        return {"action": "initialized", "appended_rows": None}

    with local_file.open("r", newline="", encoding="utf-8", errors="ignore") as lf:
        existing_rows = sum(1 for _ in lf)

    with tmp_file.open("r", newline="", encoding="utf-8", errors="ignore") as tf:
        reader = list(csv.reader(tf))
    new_rows = reader[existing_rows:]

    if new_rows:
        with local_file.open("a", newline="", encoding="utf-8") as lf:
            writer = csv.writer(lf)
            writer.writerows(new_rows)
        logger.info("Appended %s metered rows: %s", len(new_rows), _rel(local_file))
    tmp_file.unlink(missing_ok=True)
    return {"action": "appended" if new_rows else "no_change", "appended_rows": len(new_rows)}


def _sync_metered(client: RemoteClient, cfg: dict, run_date: str, dirs: dict[str, Path]) -> None:
    remote_dir = cfg["paths"]["remote_metered"]
    template = cfg.get("file_patterns", {}).get("metered_template")
    if not template:
        raise ValueError("file_patterns.metered_template is required")

    filename = _render_metered_filename(template, run_date)
    remote_path = f"{remote_dir.rstrip('/')}/{filename}"
    local_file = dirs["metered"] / filename
    tmp_file = local_file.with_suffix(local_file.suffix + ".tmp")

    manifest = cfg.get("_fetch_manifest") if isinstance(cfg, dict) else None
    started_at = datetime.now(IST).isoformat()
    used_remote = remote_path

    try:
        client.download(remote_path, tmp_file)
    except FileNotFoundError:
        names = client.list_names(remote_dir)
        fallback_name = _pick_latest_metered_name(names, template)
        if not fallback_name:
            raise
        fallback_remote = f"{remote_dir.rstrip('/')}/{fallback_name}"
        used_remote = fallback_remote
        logger.warning(
            "Metered file missing for date %s (%s). Falling back to latest available: %s",
            run_date,
            filename,
            fallback_name,
        )
        client.download(fallback_remote, tmp_file)

    finished_at = datetime.now(IST).isoformat()
    append_info = _append_new_rows(tmp_file, local_file)
    if isinstance(manifest, dict):
        try:
            size_b = local_file.stat().st_size
        except Exception:
            size_b = None
        manifest.setdefault("raw_inputs", {}).setdefault("metered", []).append(
            {
                "remote_path": used_remote,
                "local_path": _rel(local_file),
                "download_started_at_ist": started_at,
                "download_finished_at_ist": finished_at,
                "result": append_info,
                "size_bytes": size_b,
            }
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


def _resolve_weather_date(run_date: str, cfg: dict, enercast_root: Path) -> str:
    labels = [str(x).upper() for x in cfg.get("enercast", {}).get("date_row_labels", ["DATE:"])]
    formats = [str(x) for x in cfg.get("enercast", {}).get("date_formats", ["%Y-%m-%d", "%Y%m%d"])]

    for path in _iter_candidate_enercast_files(enercast_root):
        with path.open("r", newline="", encoding="utf-8", errors="ignore") as fh:
            reader = csv.reader(fh)
            for idx, row in enumerate(reader):
                if idx > 40:
                    break
                if not row:
                    continue
                label = str(row[0]).strip().upper()
                if label in labels and len(row) > 1:
                    normalized = _normalize_date(str(row[1]), formats)
                    if normalized:
                        logger.info("Weather date from enercast: %s -> %s", _rel(path), normalized)
                        return normalized
    logger.warning("No enercast DATE row found, using run_date for weather: %s", run_date)
    return run_date


def _get_openmeteo_client() -> openmeteo_requests.Client:
    cache_session = requests_cache.CachedSession(str(SCRIPT_DIR / ".cache"), expire_after=3600)
    retry_session = retry(cache_session, retries=5, backoff_factor=0.2)
    return openmeteo_requests.Client(session=retry_session)


def _fetch_weather_for_date(target_date: str, cfg: dict) -> tuple[dict, pd.DataFrame]:
    weather_cfg = cfg.get("weather", {})
    client = _get_openmeteo_client()
    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": weather_cfg.get("latitude", 24.0718),
        "longitude": weather_cfg.get("longitude", 75.0699),
        "models": weather_cfg.get("model", "gfs_seamless"),
        "current": weather_cfg.get("current_vars", ["temperature_2m", "wind_speed_10m", "cloud_cover"]),
        "minutely_15": weather_cfg.get(
            "minutely_vars",
            ["temperature_2m", "wind_speed_10m", "diffuse_radiation", "global_tilted_irradiance"],
        ),
        "timezone": weather_cfg.get("timezone", "Asia/Kolkata"),
        "start_date": target_date,
        "end_date": target_date,
    }

    try:
        response = client.weather_api(url, params=params)[0]
    except requests.exceptions.RequestException:
        logger.exception("Open-Meteo request failed")
        raise

    current = response.Current()
    current_unix = current.Time()
    current_ist_dt = datetime.fromtimestamp(current_unix, tz=timezone.utc).astimezone(IST)
    fetched_at_ist = datetime.now(IST).isoformat()

    current_data = {
        "fetched_at_utc": fetched_at_ist,
        "source_date": target_date,
        "latitude": response.Latitude(),
        "longitude": response.Longitude(),
        "elevation_m": response.Elevation(),
        "timezone": response.Timezone().decode() if isinstance(response.Timezone(), bytes) else response.Timezone(),
        "timezone_abbrev": response.TimezoneAbbreviation().decode()
        if isinstance(response.TimezoneAbbreviation(), bytes)
        else response.TimezoneAbbreviation(),
        "utc_offset_seconds": response.UtcOffsetSeconds(),
        "current_time_unix": current_unix,
        "current_time_ist": current_ist_dt.isoformat(),
        "current_time_ist_hhmm": current_ist_dt.strftime("%H.%M"),
        "current_time_ist_hm": f"{current_ist_dt.hour}.{current_ist_dt.minute}",
        "temperature_2m": current.Variables(0).Value(),
        "wind_speed_10m": current.Variables(1).Value(),
        "cloud_cover": current.Variables(2).Value(),
    }

    minutely_15 = response.Minutely15()
    date_index = pd.date_range(
        start=pd.to_datetime(minutely_15.Time(), unit="s", utc=True).tz_convert("Asia/Kolkata"),
        end=pd.to_datetime(minutely_15.TimeEnd(), unit="s", utc=True).tz_convert("Asia/Kolkata"),
        freq=pd.Timedelta(seconds=minutely_15.Interval()),
        inclusive="left",
    )

    minutely_df = pd.DataFrame(
        {
            "date": date_index,
            "temperature_2m": minutely_15.Variables(0).ValuesAsNumpy(),
            "wind_speed_10m": minutely_15.Variables(1).ValuesAsNumpy(),
            "diffuse_radiation": minutely_15.Variables(2).ValuesAsNumpy(),
            "global_tilted_irradiance": minutely_15.Variables(3).ValuesAsNumpy(),
        }
    )
    minutely_df["source_date"] = target_date
    minutely_df["fetched_at_utc"] = current_data["fetched_at_utc"]

    return current_data, minutely_df


def _write_weather_outputs(weather_dir: Path, target_date: str, current_data: dict, minutely_df: pd.DataFrame, cfg: dict | None = None) -> None:
    _ensure_dir(weather_dir)
    current_path = weather_dir / f"openmeteo_current_{target_date}.csv"
    minutely_path = weather_dir / f"openmeteo_minutely15_{target_date}.csv"

    current_df = pd.DataFrame([current_data])
    if current_path.exists():
        old = pd.read_csv(current_path)
        current_df = pd.concat([old, current_df], ignore_index=True)

    current_df.to_csv(current_path, index=False)
    minutely_df.to_csv(minutely_path, index=False)
    logger.info("Weather files written: %s, %s", _rel(current_path), _rel(minutely_path))

    if isinstance(cfg, dict):
        manifest = cfg.get("_fetch_manifest")
        if isinstance(manifest, dict):
            manifest.setdefault("raw_inputs", {}).setdefault("weather", {}).setdefault("realtime", []).append(
                {
                    "source": "openmeteo_current",
                    "target_date": target_date,
                    "local_path": _rel(current_path),
                    "fetched_at_ist": current_data.get("fetched_at_utc"),
                }
            )
            manifest.setdefault("raw_inputs", {}).setdefault("weather", {}).setdefault("forecast", []).append(
                {
                    "source": "openmeteo_minutely15",
                    "target_date": target_date,
                    "local_path": _rel(minutely_path),
                    "fetched_at_ist": current_data.get("fetched_at_utc"),
                }
            )


def _sync_once(cfg: dict, run_date: str) -> None:
    site_id = str(cfg.get("site_id", "UNKNOWN")).upper()
    base_dir = Path(cfg.get("paths", {}).get("base_dir", str(PROJECT_ROOT / "data")))
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
            "weather": {"realtime": [], "forecast": []},
        },
    }
    cfg["_fetch_manifest"] = manifest

    client: RemoteClient | None = None
    try:
        client = _build_remote_client(cfg)
        _sync_forecasts(client, cfg, run_date, dirs)
        _sync_metered(client, cfg, run_date, dirs)
    finally:
        if client is not None:
            client.close()

    weather_date = _resolve_weather_date(run_date, cfg, dirs["enercast"])
    current_data, minutely_df = _fetch_weather_for_date(weather_date, cfg)
    _write_weather_outputs(dirs["weather"], weather_date, current_data, minutely_df, cfg=cfg)

    # Persist manifest inside the raw date root so scheduler can log it later.
    try:
        manifest["weather_date_used"] = weather_date
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
