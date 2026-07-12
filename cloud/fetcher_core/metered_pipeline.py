from __future__ import annotations

from dataclasses import asdict, dataclass

from cloud.common.config_loader import load_site_config
from cloud.fetcher_core.forecast_fetch import load_group_fetch_handler


@dataclass
class SiteFetchResult:
    site: str
    ok: bool
    returncode: int
    uploaded_files: int
    uploaded_da_files: int
    uploaded_intraday_files: int
    intraday_reason_label: str | None
    stdout_tail: str
    stderr_tail: str
    uploaded_da_keys: list[str]
    uploaded_intraday_keys: list[str]

    def as_response_dict(self) -> dict:
        payload = asdict(self)
        payload.pop("uploaded_da_keys", None)
        payload.pop("uploaded_intraday_keys", None)
        return payload


def _resolve_intraday_reason(handler, site_id: str, uploaded_intraday_keys: list[str], explicit_reason: str | None) -> str | None:
    if explicit_reason:
        return explicit_reason
    if uploaded_intraday_keys and hasattr(handler, "_intraday_reason_label_from_policy"):
        return handler._intraday_reason_label_from_policy(site_id, uploaded_intraday_keys)
    return explicit_reason


def run_site_fetch(entry: dict, run_date: str) -> SiteFetchResult:
    site_id = str(entry["site_id"]).strip().upper()
    handler = load_group_fetch_handler(entry["source_group"])

    handler._configure_for_site(site_id)
    handler._reset_workdir()

    if entry["source_group"] == "illios_power":
        if hasattr(handler, "_prepare_fetch_assets"):
            handler._prepare_fetch_assets()
        if hasattr(handler, "_restore_metered_state_from_s3"):
            handler._restore_metered_state_from_s3(site_id, run_date)

        proc = handler._run_fetch_once(site_id)
        if hasattr(handler, "_log_process_output"):
            handler._log_process_output(f"FETCH RUN | site={site_id}", proc)

        uploaded = 0
        uploaded_da_keys: list[str] = []
        uploaded_intraday_keys: list[str] = []
        intraday_reason_label: str | None = None

        if proc.returncode == 0:
            uploaded, uploaded_da_keys, uploaded_intraday_keys, intraday_reason_label = handler._upload_raw_data()
            intraday_reason_label = _resolve_intraday_reason(
                handler,
                site_id,
                uploaded_intraday_keys,
                intraday_reason_label,
            )

        return SiteFetchResult(
            site=site_id,
            ok=proc.returncode == 0,
            returncode=int(proc.returncode),
            uploaded_files=int(uploaded),
            uploaded_da_files=len(uploaded_da_keys),
            uploaded_intraday_files=len(uploaded_intraday_keys),
            intraday_reason_label=intraday_reason_label,
            stdout_tail=str(proc.stdout or "")[-4000:],
            stderr_tail=str(proc.stderr or "")[-4000:],
            uploaded_da_keys=uploaded_da_keys,
            uploaded_intraday_keys=uploaded_intraday_keys,
        )

    fetchdata = handler._load_fetchdata_module()
    cfg = load_site_config(site_id)
    cfg.setdefault("paths", {})["base_dir"] = str((handler.WORK_ROOT / "data").resolve())

    uploaded = 0
    uploaded_da_keys: list[str] = []
    uploaded_intraday_keys: list[str] = []
    intraday_reason_label: str | None = None

    try:
        fetchdata._sync_once_with_client(cfg, run_date, client=None)
        uploaded, uploaded_da_keys, uploaded_intraday_keys, intraday_reason_label = handler._upload_raw_data()
        intraday_reason_label = _resolve_intraday_reason(
            handler,
            site_id,
            uploaded_intraday_keys,
            intraday_reason_label,
        )
        return SiteFetchResult(
            site=site_id,
            ok=True,
            returncode=0,
            uploaded_files=int(uploaded),
            uploaded_da_files=len(uploaded_da_keys),
            uploaded_intraday_files=len(uploaded_intraday_keys),
            intraday_reason_label=intraday_reason_label,
            stdout_tail="",
            stderr_tail="",
            uploaded_da_keys=uploaded_da_keys,
            uploaded_intraday_keys=uploaded_intraday_keys,
        )
    except Exception as exc:
        return SiteFetchResult(
            site=site_id,
            ok=False,
            returncode=1,
            uploaded_files=0,
            uploaded_da_files=0,
            uploaded_intraday_files=0,
            intraday_reason_label=None,
            stdout_tail="",
            stderr_tail=str(exc)[-4000:],
            uploaded_da_keys=[],
            uploaded_intraday_keys=[],
        )
