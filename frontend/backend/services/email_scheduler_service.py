import json
import os
import re
import sqlite3
from typing import Any, Dict, List, Tuple


_MANDATORY_DEFAULT_CC = "forecasting.vppl@gmail.com"
_GSNP_INTRADAY_SUBJECT = "Globus Steel N Power Intraday for {month_full}-{year_full}"
_GSNP_INTRADAY_BODY = 'Dear Sir/mam,\n\nPlease Find the attached Intraday Forecast of "Globus Steel N Power" for Date {date_dotted}'
_ILIOS_PV_CODE = "ILIOS_PV"
_ILIOS_PV_PLANT_NAME = "Ilios_PV"
_ILIOS_PV_DAYAHEAD_SUBJECT = "Dayahead Schedule Ilios_PV (50MW) for {date_dashed}"
_ILIOS_PV_DAYAHEAD_BODY = "Dear Sir/Mam,\n\nPlease find attached Ilios_PV (50 MW) Day Ahead-Schedule for Date {date_dotted}"
_ILIOS_PV_INTRADAY_SUBJECT = "Ilios_PV Intraday Schedule for the Month of {month_full}_{year_full}"
_ILIOS_PV_INTRADAY_BODY = "Dear Sir/Mam,\n\nPlease find attached the Intraday Schedule ILIOS_PV for Date {date_dotted}"


def _gsnp_intraday_template() -> Dict[str, Any]:
    return {
        "id": "gsnp_intraday",
        "label": "Intraday",
        "timing_hint": "17:00 to 18:00",
        "time_24h": "17:00",
        "am_pm": "PM",
        "subject": _GSNP_INTRADAY_SUBJECT,
        "body": _GSNP_INTRADAY_BODY,
        "default_to": "",
        "default_cc": "",
        "active": True,
    }


def _ensure_gsnp_intraday_metadata(
    plants: List[Dict[str, Any]],
    templates_by_plant: Dict[str, List[Dict[str, Any]]],
) -> None:
    plant = next(
        (item for item in plants if str(item.get("plant_code") or "").strip().upper() == "GSNP"),
        None,
    )
    if plant:
        plant["active"] = True
    else:
        plants.append(
            {
                "plant_id": 0,
                "plant_code": "GSNP",
                "plant_name": "GSNP",
                "active": True,
            }
        )

    existing = templates_by_plant.get("GSNP") or templates_by_plant.get("gsnp") or []
    intraday = [
        template
        for template in existing
        if "intra" in f"{template.get('id', '')} {template.get('label', '')}".lower()
    ]
    for template in intraday:
        template["label"] = "Intraday"
        template["timing_hint"] = "17:00 to 18:00"
        template["time_24h"] = "17:00"
        template["am_pm"] = "PM"
        template["subject"] = _GSNP_INTRADAY_SUBJECT
        template["body"] = _GSNP_INTRADAY_BODY
        template["default_to"] = ""
        template["default_cc"] = ""
        template["active"] = True
    templates_by_plant["GSNP"] = intraday or [_gsnp_intraday_template()]


def _ilios_pv_templates() -> List[Dict[str, Any]]:
    return [
        {
            "id": "ilios_pv_da0",
            "label": "DA0 Schedule",
            "timing_hint": "05:00 to 06:00 AM",
            "time_24h": "05:00",
            "am_pm": "AM",
            "subject": _ILIOS_PV_DAYAHEAD_SUBJECT,
            "body": _ILIOS_PV_DAYAHEAD_BODY,
            "default_to": "",
            "default_cc": "",
            "active": True,
        },
        {
            "id": "ilios_pv_intraday",
            "label": "Intraday",
            "timing_hint": "17:00 to 18:00",
            "time_24h": "17:00",
            "am_pm": "PM",
            "subject": _ILIOS_PV_INTRADAY_SUBJECT,
            "body": _ILIOS_PV_INTRADAY_BODY,
            "default_to": "",
            "default_cc": "",
            "active": True,
        },
    ]


def _ensure_ilios_pv_metadata(
    plants: List[Dict[str, Any]],
    templates_by_plant: Dict[str, List[Dict[str, Any]]],
) -> None:
    plant = next(
        (item for item in plants if str(item.get("plant_code") or "").strip().upper() == _ILIOS_PV_CODE),
        None,
    )
    if plant:
        plant["plant_name"] = str(plant.get("plant_name") or _ILIOS_PV_PLANT_NAME)
        plant["active"] = True
    else:
        plants.append(
            {
                "plant_id": 0,
                "plant_code": _ILIOS_PV_CODE,
                "plant_name": _ILIOS_PV_PLANT_NAME,
                "active": True,
            }
        )

    existing = list(templates_by_plant.get(_ILIOS_PV_CODE) or [])
    by_id = {str((item or {}).get("id") or "").strip().lower(): dict(item or {}) for item in existing}
    for fallback in _ilios_pv_templates():
        key = str(fallback["id"]).lower()
        merged = {**fallback, **by_id.get(key, {})}
        merged["subject"] = fallback["subject"]
        merged["body"] = fallback["body"]
        merged["timing_hint"] = fallback["timing_hint"]
        merged["time_24h"] = fallback["time_24h"]
        merged["am_pm"] = fallback["am_pm"]
        merged["active"] = True
        by_id[key] = merged
    templates_by_plant[_ILIOS_PV_CODE] = [by_id["ilios_pv_da0"], by_id["ilios_pv_intraday"]]


def normalize_day_ahead_body(body: str, template_id: str = "", label: str = "") -> str:
    """Keep DA0/DA1 body numbering consistent across stored and fallback templates."""
    text = str(body or "")
    selector = f"{template_id} {label}".lower()
    if re.search(r"(?:^|[_\s-])da0(?:$|[_\s-])", selector):
        number = "0"
    elif re.search(r"(?:^|[_\s-])da1(?:$|[_\s-])", selector):
        number = "1"
    elif re.search(r"(?:^|[_\s-])da2(?:$|[_\s-])", selector):
        # Legacy standalone scheduler used DA1/DA2 ids for morning/night.
        number = "1"
    else:
        return text
    return re.sub(r"\bDay\s*Ahead\s*-\s*0?[12]\b", f"Day Ahead-{number}", text, flags=re.IGNORECASE)


def _merge_email_list(existing: str, extra: str) -> str:
    existing_items = [x.strip() for x in str(existing or "").split(",") if str(x or "").strip()]
    extra_items = [x.strip() for x in str(extra or "").split(",") if str(x or "").strip()]
    merged: List[str] = []
    seen = set()
    for addr in existing_items + extra_items:
        key = addr.lower()
        if key in seen:
            continue
        seen.add(key)
        merged.append(addr)
    return ",".join(merged)


def _apply_mandatory_default_cc(default_cc: str) -> str:
    return _merge_email_list(default_cc, _MANDATORY_DEFAULT_CC)


def _default_db_path() -> str:
    return os.path.join(os.path.dirname(__file__), "..", "data", "email_scheduler", "scheduler_data.db")


def _default_templates_path() -> str:
    return os.path.join(os.path.dirname(__file__), "..", "data", "email_scheduler", "mail_templates.json")


def _open_sqlite_readonly(db_path: str) -> sqlite3.Connection:
    resolved = os.path.abspath(db_path)
    uri = f"file:{resolved}?mode=ro"
    return sqlite3.connect(uri, uri=True)


def load_email_scheduler_metadata() -> Tuple[List[Dict[str, Any]], Dict[str, List[Dict[str, Any]]], Dict[str, Any]]:
    """
    Load Email Scheduler metadata for the dashboard UI.

    Read-only guarantee:
    - SQLite connection is opened in mode=ro
    - no writes to DB / S3 are performed here
    """
    db_path = os.environ.get("EMAIL_SCHEDULER_DB_PATH") or _default_db_path()
    templates_path = os.environ.get("EMAIL_SCHEDULER_TEMPLATES_PATH") or _default_templates_path()

    plants: List[Dict[str, Any]] = []
    templates_by_plant: Dict[str, List[Dict[str, Any]]] = {}
    meta: Dict[str, Any] = {"db_path": db_path, "templates_path": templates_path, "source": "none"}

    if os.path.exists(db_path):
        json_defaults: Dict[Tuple[str, str], Dict[str, str]] = {}
        if os.path.exists(templates_path):
            try:
                with open(templates_path, "r", encoding="utf-8") as f:
                    raw_defaults = json.load(f) or {}
                for plant_code, items in (raw_defaults or {}).items():
                    for tpl in (items or []):
                        tpl_id = str((tpl or {}).get("id") or "").strip()
                        if not plant_code or not tpl_id:
                            continue
                        json_defaults[(str(plant_code).strip(), tpl_id)] = {
                            "default_to": str((tpl or {}).get("default_to") or ""),
                            "default_cc": str((tpl or {}).get("default_cc") or ""),
                        }
            except Exception:
                # Metadata must stay resilient; ignore JSON defaults if parsing fails.
                json_defaults = {}

        con = _open_sqlite_readonly(db_path)
        try:
            con.row_factory = sqlite3.Row
            cur = con.cursor()

            cur.execute("select id, plant_code, plant_name, active from plants order by id")
            plant_rows = cur.fetchall()
            plants = [
                {
                    "plant_id": int(r["id"]),
                    "plant_code": str(r["plant_code"] or ""),
                    "plant_name": str(r["plant_name"] or ""),
                    "active": bool(r["active"]),
                }
                for r in plant_rows
            ]

            # Join mail_templates to plants so UI gets the mapping keyed by plant_code.
            cur.execute(
                """
                select
                    p.plant_code as plant_code,
                    t.template_id as id,
                    t.label as label,
                    t.timing_hint as timing_hint,
                    t.time_24h as time_24h,
                    t.am_pm as am_pm,
                    t.subject as subject,
                    t.body as body,
                    t.default_to as default_to,
                    t.default_cc as default_cc,
                    t.active as active
                from mail_templates t
                join plants p on p.id = t.plant_id
                order by p.id, t.id
                """
            )
            for row in cur.fetchall():
                plant_code = str(row["plant_code"] or "")
                if not plant_code:
                    continue

                tpl_id = str(row["id"] or "").strip()
                defaults = json_defaults.get((plant_code, tpl_id), {}) if tpl_id else {}
                default_to = str(row["default_to"] or "").strip() or str(defaults.get("default_to") or "").strip()
                default_cc = str(row["default_cc"] or "").strip() or str(defaults.get("default_cc") or "").strip()
                default_cc = _apply_mandatory_default_cc(default_cc)
                templates_by_plant.setdefault(plant_code, []).append(
                    {
                        "id": tpl_id,
                        "label": str(row["label"] or ""),
                        "timing_hint": str(row["timing_hint"] or ""),
                        "time_24h": str(row["time_24h"] or ""),
                        "am_pm": str(row["am_pm"] or ""),
                        "subject": str(row["subject"] or ""),
                        "body": normalize_day_ahead_body(
                            str(row["body"] or ""),
                            tpl_id,
                            str(row["label"] or ""),
                        ),
                        "default_to": default_to,
                        "default_cc": default_cc,
                        "active": bool(row["active"]),
                    }
                )

            _ensure_gsnp_intraday_metadata(plants, templates_by_plant)
            _ensure_ilios_pv_metadata(plants, templates_by_plant)
            meta["source"] = "sqlite+json_defaults" if json_defaults else "sqlite"
            return plants, templates_by_plant, meta
        finally:
            con.close()

    if os.path.exists(templates_path):
        with open(templates_path, "r", encoding="utf-8") as f:
            raw = json.load(f) or {}
        # In JSON form it is keyed by plant name; we expose the same keys for now.
        # Ensure mandatory CC is present for all templates.
        try:
            for _plant_key, items in (raw or {}).items():
                for tpl in items or []:
                    tpl["default_cc"] = _apply_mandatory_default_cc(str((tpl or {}).get("default_cc") or "").strip())
                    tpl["body"] = normalize_day_ahead_body(
                        str((tpl or {}).get("body") or ""),
                        str((tpl or {}).get("id") or ""),
                        str((tpl or {}).get("label") or ""),
                    )
        except Exception:
            pass
        _ensure_gsnp_intraday_metadata(plants, raw)
        _ensure_ilios_pv_metadata(plants, raw)
        meta["source"] = "json"
        return plants, raw, meta

    _ensure_ilios_pv_metadata(plants, templates_by_plant)
    return plants, templates_by_plant, meta
