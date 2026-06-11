import json
import os
import sqlite3
from typing import Any, Dict, List, Tuple


_MANDATORY_DEFAULT_CC = "forecasting.vppl@gmail.com"


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
                        "body": str(row["body"] or ""),
                        "default_to": default_to,
                        "default_cc": default_cc,
                        "active": bool(row["active"]),
                    }
                )

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
        except Exception:
            pass
        meta["source"] = "json"
        return plants, raw, meta

    return plants, templates_by_plant, meta
