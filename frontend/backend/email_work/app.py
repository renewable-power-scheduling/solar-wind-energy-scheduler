import csv
import copy
import io
import json
import mimetypes
import os
import re
import smtplib
import sqlite3
import threading
import time
from datetime import datetime, timedelta
from email import encoders
from email.mime.base import MIMEBase
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from flask import Flask, jsonify, request, send_file, session

app = Flask(__name__)


def load_env_file(path=".env"):
    """Load KEY=VALUE pairs from a local .env file."""
    if not os.path.exists(path):
        return

    with open(path, "r", encoding="utf-8") as env_file:
        for raw_line in env_file:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


load_env_file()

# In-memory scheduled jobs:
# {
#   "email": str,
#   "scheduled_at": datetime,
#   "attachment_name": str | None,
#   "attachment_bytes": bytes | None,
#   "subject": str,
#   "body": str,
#   "cc": str,
# }
scheduled_jobs = []
jobs_lock = threading.Lock()

EMAIL_USER = os.environ.get("EMAIL_USER")
EMAIL_PASS = os.environ.get("EMAIL_PASS")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin123")
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "email-scheduler-secret")
CHECK_INTERVAL_SECONDS = 60
EMAIL_REGEX = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MAIL_LOG_PATH = "mail_logs.csv"
MAIL_TEMPLATES_PATH = "mail_templates.json"
DATABASE_PATH = "scheduler_data.db"
IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp")
DOCUMENT_EXTENSIONS = (".pdf", ".doc", ".docx")
UI_USERS = {
    "testing": {"password": "test01", "role": "testing"},
    "Admin": {"password": "admin01", "role": "admin"},
}
MAIL_LOG_HEADERS = [
    "employee_name",
    "from_email",
    "to_email",
    "cc_email",
    "plant_name",
    "mail_label",
    "subject",
    "status",
    "mode",
    "scheduled_at",
    "sent_at",
    "error_message"]


def normalize_day_ahead_body(body, template_id="", label="", scheduled_at=None):
    text = str(body or "")
    selector = f"{template_id} {label}".lower()
    if "da0" in selector:
        number = "0"
    elif "da2" in selector:
        number = "1"
    elif "da1" in selector:
        # Legacy standalone ids use DA1 for morning and DA2 for night.
        number = "0" if scheduled_at is not None and scheduled_at.hour < 12 else "1"
    else:
        return text
    return re.sub(r"\bDay\s*Ahead\s*-\s*0?[12]\b", f"Day Ahead-{number}", text, flags=re.IGNORECASE)


DEFAULT_MAIL_TEMPLATES = {
    "SIRMOUR": [
        {
            "id": "sirmour_dayahead",
            "label": "Day Ahead Schedule",
            "timing_hint": "05:00 AM",
            "time_24h": "05:00",
            "am_pm": "AM",
            "subject": "{month_short}{year_short} _Dayahead Schedule of SIRMOUR_PV",
            "body": "Dear Sir,\nPlease find attached Day-Ahead Schedule SIRMOUR_PV for Date {date_dotted}.",
            "default_to": "",
            "default_cc": "",
        },
        {
            "id": "sirmour_intraday",
            "label": "Final Intraday Schedule",
            "timing_hint": "17:00 to 18:00",
            "time_24h": "17:00",
            "am_pm": "PM",
            "subject": "SIRMOUR_PV Intraday Schedule for the Month of {month_full}-{year_full}",
            "body": "Dear Sir/Mam,\nPlease find attached Intraday Schedule SIRMOUR_PV for Date {date_dotted}.",
            "default_to": "",
            "default_cc": "",
        },
        {
            "id": "sirmour_dsm",
            "label": "DSM Penalty Report",
            "timing_hint": "Choose as required",
            "time_24h": "18:00",
            "am_pm": "PM",
            "subject": "DSM Penalty Report - SIRMOUR",
            "body": "Dear Sir/Mam,\nPFA The DSM Penalty Report for the date {date_dashed}.",
            "default_to": "",
            "default_cc": "",
        }],
    "Globus Steel N Power": [
        {
            "id": "globus_intraday",
            "label": "Final Intraday Schedule",
            "timing_hint": "17:00 to 18:00",
            "time_24h": "17:00",
            "am_pm": "PM",
            "subject": "Globus Steel N Power Intraday for {month_full}-{year_full}",
            "body": 'Dear Sir/Mam,\nPlease find the attached Intraday Forecast of "Globus Steel N Power" for Date {date_dotted}.',
        }
    ],
    "MARUT SHAKTI CHANDWASA": [
        {
            "id": "chandwasa_intraday",
            "label": "Final Intraday Schedule",
            "timing_hint": "17:00 to 18:00",
            "time_24h": "17:00",
            "am_pm": "PM",
            "subject": "Chandwasa Intraday Revision for {month_full}-{year_full}",
            "body": 'Dear Sir,\nPlease find the attached Intraday Forecast of "Chandwasa" for Date {date_dashed}.',
        }
    ],
    "BHUPALPALLY": [
        {
            "id": "bhupalpally_da1",
            "label": "DA1 Schedule",
            "timing_hint": "05:00 to 06:00 AM",
            "time_24h": "05:00",
            "am_pm": "AM",
            "subject": "{month_short}{year_short} BHUPALPALLY (10 MW) Dayahead Schedule",
            "body": "Dear Sir/Mam,\nPlease find attached BHUPALPALLY (10 MW) Day Ahead-0 Schedule for Date {date_dotted}.",
            "default_to": ", ",
            "default_cc": "",
        },
        {
            "id": "bhupalpally_da2",
            "label": "DA2 Schedule",
            "timing_hint": "22:45",
            "time_24h": "22:45",
            "am_pm": "PM",
            "subject": "{month_short}{year_short} BHUPALPALLY (10 MW) Dayahead Schedule",
            "body": "Dear Sir/Mam,\nPlease find attached BHUPALPALLY (10 MW) Day Ahead-1 Schedule for Date {date_dotted}.",
            "default_to": ", ",
            "default_cc": "",
        },
        {
            "id": "bhupalpally_dsm",
            "label": "DSM Penalty Report",
            "timing_hint": "Choose as required",
            "time_24h": "18:00",
            "am_pm": "PM",
            "subject": "DSM Penalty Report - BHUPALPALLY",
            "body": "Dear Sir/Mam,\nPlease find attached DSM penalty report for the selected date.",
            "default_to": ", , , ",
            "default_cc": "",
        }],
    "KASIPET": [
        {
            "id": "kasipet_da1",
            "label": "DA1 Schedule",
            "timing_hint": "05:00 to 06:00 AM",
            "time_24h": "05:00",
            "am_pm": "AM",
            "subject": "{month_short}{year_short} KASIPET (15 MW) Dayahead Schedule",
            "body": "Dear Sir/Mam,\nPlease find attached KASIPET (15 MW) Day Ahead-0 Schedule for Date {date_dotted}.",
            "default_to": ", , , ",
            "default_cc": "",
        },
        {
            "id": "kasipet_da2",
            "label": "DA2 Schedule",
            "timing_hint": "22:45",
            "time_24h": "22:45",
            "am_pm": "PM",
            "subject": "{month_short}{year_short} KASIPET (15 MW) Dayahead Schedule",
            "body": "Dear Sir/Mam,\nPlease find attached KASIPET (15 MW) Day Ahead-1 Schedule for Date {date_dotted}.",
            "default_to": ", , , ",
            "default_cc": "",
        }],
    "KOTHAGUDEM": [
        {
            "id": "kothagudem_da1",
            "label": "DA1 Schedule",
            "timing_hint": "05:00 to 06:00 AM",
            "time_24h": "05:00",
            "am_pm": "AM",
            "subject": "{month_short}{year_short} KOTHAGUDEM (37 MW) Dayahead Schedule",
            "body": "Dear Sir/Mam,\nPlease find attached KOTHAGUDEM (37 MW) Day Ahead-0 Schedule for Date {date_dotted}.",
            "default_to": ", , , ",
            "default_cc": "",
        },
        {
            "id": "kothagudem_da2",
            "label": "DA2 Schedule",
            "timing_hint": "22:45",
            "time_24h": "22:45",
            "am_pm": "PM",
            "subject": "{month_short}{year_short} KOTHAGUDEM (37 MW) Dayahead Schedule",
            "body": "Dear Sir/Mam,\nPlease find attached KOTHAGUDEM (37 MW) Day Ahead-1 Schedule for Date {date_dotted}.",
            "default_to": ", , , ",
            "default_cc": "",
        }],
    "Chakur Park (Ztric)": [
        {
            "id": "chakur_intraday",
            "label": "Final Intraday Schedule",
            "timing_hint": "18:00",
            "time_24h": "18:00",
            "am_pm": "PM",
            "subject": "Chakur - Ztric 25MW Daily Intraday schedule for the Month of {month_full}_{year_full}",
            "body": "Dear Sir/Madam,\nPlease find attached the Chakur-Ztric 25 MW schedule for {date_dashed}.",
        }
    ],
    "OSEPL": [
        {
            "id": "osepl_dayahead",
            "label": "Dayahead Schedule",
            "timing_hint": "05:00 AM",
            "time_24h": "05:00",
            "am_pm": "AM",
            "subject": "{next_month_short}{year_short}_DA schedule of Osmanabad Solar Energy Limited",
            "body": "Dear Sir,\nPlease find attached DA schedule of Osmanabad Solar Energy Limited for Date- {date_dotted}.",
            "default_to": "",
            "default_cc": ", ",
        }
        ,
        {
            "id": "osepl_dsm",
            "label": "DSM Penalty Report",
            "timing_hint": "Choose as required",
            "time_24h": "18:00",
            "am_pm": "PM",
            "subject": "DSM Penalty Report - OSEPL",
            "body": "Dear Sir,\nPlease find the DSM penalty report for Date {date_dashed}.",
            "default_to": "",
            "default_cc": ", , ",
        }
    ],
    "TPREL - JEWALI (DayAhead)": [
        {
            "id": "jewali_dayahead",
            "label": "Dayahead Schedule",
            "timing_hint": "05:00 to 06:00 AM",
            "time_24h": "05:00",
            "am_pm": "AM",
            "subject": "TPREL-Jewali Naldurg PSS DayAhead Schedule for {next_month_short}-{year_full}",
            "body": "Dear Sir/Mam,\nPFA the DayAhead Schedule for TPREL-Jewali_Naldurg PSS for Date {date_dashed}.",
        }
    ],
    "TPREL - JEWALI (Intraday)": [
        {
            "id": "jewali_intraday",
            "label": "Final Intraday Schedule",
            "timing_hint": "22:00",
            "time_24h": "22:00",
            "am_pm": "PM",
            "subject": "TPREL-Jewali_Naldurg PSS Intraday Schedule for {next_month_short}-{year_full}",
            "body": "Dear Sir/Mam,\nPFA the Intraday Schedule for TPREL-Jewali_Naldurg PSS for Date {date_dashed}.",
        }
    ],
    "CME": [
        {
            "id": "cme_intraday",
            "label": "Final Intraday Schedule",
            "timing_hint": "17:30",
            "time_24h": "17:30",
            "am_pm": "PM",
            "subject": "CME_DIGHI 5MW Daily Intraday schedule for the Month of {next_month_short}_{year_full}",
            "body": "Dear Sir,\nPlease find attached CME_DIGHI 5MW Schedule for Date {date_dashed}.",
        }
    ],
}

MAIL_TEMPLATES = copy.deepcopy(DEFAULT_MAIL_TEMPLATES)

TABULAR_REPORT_SCHEMAS = {
    "sirmour_dsm": {
        "file_name": "sirmour-dsm-report.csv",
        "columns": [
            "From",
            "To",
            "Project",
            "Installed Capacity (Mw)",
            "Generation (Kwh)",
            "DSM Penalty (Rs.)",
            "Paisa /Kwh",
            "Net Revenue",
            "%Impact"],
        "rows": lambda sender_email, recipient_email, cc_emails, context, plant_name: [
            [
                context["date_dashed"],
                context["date_dashed"],
                plant_name,
                "5",
                "12,480",
                "4,850",
                "0.39",
                "1,24,560",
                "3.89%"]
        ],
    },
    "bhupalpally_dsm": {
        "file_name": "bhupalpally-dsm-report.csv",
        "columns": [
            "To",
            "Month",
            "Project",
            "Installed Capacity (Mw)",
            "Generation (Kwh)",
            "DSM Penalty(Rs.) As per Scada Availability",
            "DSM Penalty As Maintenance Information",
            "Paisa/Kwh Scada Availability",
            "Paisa/Kwh Maintenance Information",
            "Scada Availability(%)"],
        "rows": lambda sender_email, recipient_email, cc_emails, context, plant_name: [
            [
                context["date_dashed"],
                context["month_full"],
                plant_name,
                "10",
                "24,920",
                "8,640",
                "1,250",
                "0.35",
                "0.05",
                "98.7%"]
        ],
    },
    "kasipet_dsm": {
        "file_name": "kasipet-dsm-report.csv",
        "columns": [
            "To",
            "Month",
            "Project",
            "Installed Capacity (Mw)",
            "Generation (Kwh)",
            "DSM Penalty(Rs.) As per Scada Availability",
            "DSM Penalty As Maintenance Information",
            "Paisa/Kwh Scada Availability",
            "Paisa/Kwh Maintenance Information",
            "Scada Availability(%)",
        ],
        "rows": lambda sender_email, recipient_email, cc_emails, context, plant_name: [
            [
                context["date_dashed"],
                context["month_full"],
                plant_name,
                "15",
                "31,250",
                "9,250",
                "1,450",
                "0.30",
                "0.05",
                "98.9%",
            ]
        ],
    },
    "kothagudem_dsm": {
        "file_name": "kothagudem-dsm-report.csv",
        "columns": [
            "To",
            "Month",
            "Project",
            "Installed Capacity (Mw)",
            "Generation (Kwh)",
            "DSM Penalty(Rs.) As per Scada Availability",
            "DSM Penalty As Maintenance Information",
            "Paisa/Kwh Scada Availability",
            "Paisa/Kwh Maintenance Information",
            "Scada Availability(%)",
        ],
        "rows": lambda sender_email, recipient_email, cc_emails, context, plant_name: [
            [
                context["date_dashed"],
                context["month_full"],
                plant_name,
                "37",
                "74,880",
                "21,640",
                "3,120",
                "0.29",
                "0.04",
                "99.0%",
            ]
        ],
    },
    "osepl_dsm": {
        "file_name": "osepl-dsm-report.csv",
        "columns": [
            "From",
            "Month",
            "Project",
            "Installed Capacity",
            "SCADA availability",
            "Generation(Kwh)",
            "Scheduled unit*PPA",
            "Payable",
            "Receivable",
            "DSM Penalty(Rs.)"],
        "rows": lambda sender_email, recipient_email, cc_emails, context, plant_name: [
            [
                context["date_dashed"],
                context["month_full"],
                plant_name,
                "20",
                "99.1%",
                "48,750",
                "47,900",
                "12,500",
                "2,800",
                "9,700"]
        ],
    },
}


def save_mail_templates():
    with open(MAIL_TEMPLATES_PATH, "w", encoding="utf-8") as file:
        json_compatible = copy.deepcopy(MAIL_TEMPLATES)
        json.dump(json_compatible, file, indent=2)


def slugify(value):
    return re.sub(r"[^a-z0-9]+", "_", (value or "").strip().lower()).strip("_")


def get_db_connection():
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def init_database():
    with get_db_connection() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS plants (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                plant_code TEXT UNIQUE,
                plant_name TEXT UNIQUE NOT NULL,
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS mail_templates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                template_id TEXT UNIQUE NOT NULL,
                plant_id INTEGER NOT NULL,
                label TEXT NOT NULL,
                timing_hint TEXT,
                time_24h TEXT NOT NULL,
                am_pm TEXT NOT NULL,
                subject TEXT NOT NULL,
                body TEXT NOT NULL,
                default_to TEXT,
                default_cc TEXT,
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (plant_id) REFERENCES plants (id)
            )
            """
        )


def read_template_seed_data():
    if os.path.exists(MAIL_TEMPLATES_PATH):
        try:
            with open(MAIL_TEMPLATES_PATH, "r", encoding="utf-8") as file:
                stored_templates = json.load(file)
            if isinstance(stored_templates, dict) and stored_templates:
                return stored_templates
        except (OSError, ValueError):
            pass
    return copy.deepcopy(DEFAULT_MAIL_TEMPLATES)


def upsert_plant(connection, plant_name, plant_code=None, active=1):
    timestamp = datetime.now().isoformat(timespec="seconds")
    resolved_code = (plant_code or slugify(plant_name) or f"plant_{int(time.time())}").upper()
    connection.execute(
        """
        INSERT INTO plants (plant_code, plant_name, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(plant_name) DO UPDATE SET
            plant_code=excluded.plant_code,
            active=excluded.active,
            updated_at=excluded.updated_at
        """,
        (resolved_code, plant_name, int(active), timestamp, timestamp))
    row = connection.execute(
        "SELECT id, plant_code, plant_name, active FROM plants WHERE plant_name = ?",
        (plant_name)).fetchone()
    return row


def upsert_template_record(connection, plant_id, template):
    timestamp = datetime.now().isoformat(timespec="seconds")
    connection.execute(
        """
        INSERT INTO mail_templates (
            template_id, plant_id, label, timing_hint, time_24h, am_pm, subject, body,
            default_to, default_cc, active, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(template_id) DO UPDATE SET
            plant_id=excluded.plant_id,
            label=excluded.label,
            timing_hint=excluded.timing_hint,
            time_24h=excluded.time_24h,
            am_pm=excluded.am_pm,
            subject=excluded.subject,
            body=excluded.body,
            default_to=excluded.default_to,
            default_cc=excluded.default_cc,
            active=excluded.active,
            updated_at=excluded.updated_at
        """,
        (
            template["id"],
            plant_id,
            template["label"],
            template.get("timing_hint", ""),
            template["time_24h"],
            template["am_pm"],
            template["subject"],
            template["body"],
            template.get("default_to", ""),
            template.get("default_cc", ""),
            timestamp,
            timestamp))


def seed_database_if_empty():
    with get_db_connection() as connection:
        seed_data = read_template_seed_data()
        for plant_name, templates in seed_data.items():
            plant_row = upsert_plant(connection, plant_name)
            for template in templates:
                upsert_template_record(connection, plant_row["id"], template)
        connection.commit()


def fetch_plants(active_only=True):
    query = """
        SELECT plant_code, plant_name, active
        FROM plants
    """
    params = []
    if active_only:
        query += " WHERE active = 1"
    query += " ORDER BY plant_name COLLATE NOCASE"

    with get_db_connection() as connection:
        rows = connection.execute(query, params).fetchall()

    return [
        {
            "plant_code": row["plant_code"],
            "plant_name": row["plant_name"],
            "active": bool(row["active"]),
        }
        for row in rows
    ]


def fetch_template_map(active_only=True):
    query = """
        SELECT
            p.plant_name,
            mt.template_id,
            mt.label,
            mt.timing_hint,
            mt.time_24h,
            mt.am_pm,
            mt.subject,
            mt.body,
            mt.default_to,
            mt.default_cc,
            mt.active
        FROM mail_templates mt
        INNER JOIN plants p ON p.id = mt.plant_id
    """
    if active_only:
        query += " WHERE p.active = 1 AND mt.active = 1"
    query += " ORDER BY p.plant_name COLLATE NOCASE, mt.label COLLATE NOCASE"

    template_map = {}
    with get_db_connection() as connection:
        for row in connection.execute(query).fetchall():
            template_map.setdefault(row["plant_name"], []).append(
                {
                    "id": row["template_id"],
                    "label": row["label"],
                    "timing_hint": row["timing_hint"] or row["time_24h"],
                    "time_24h": row["time_24h"],
                    "am_pm": row["am_pm"],
                    "subject": row["subject"],
                    "body": normalize_day_ahead_body(
                        row["body"],
                        row["template_id"],
                        row["label"],
                        datetime.strptime(row["time_24h"], "%H:%M") if row["time_24h"] else None,
                    ),
                    "default_to": row["default_to"] or "",
                    "default_cc": row["default_cc"] or "",
                }
            )
    return template_map


def load_mail_templates():
    global MAIL_TEMPLATES
    MAIL_TEMPLATES = fetch_template_map(active_only=True)
    save_mail_templates()


def is_admin_authenticated():
    return bool(session.get("is_admin"))


def require_admin():
    if not is_admin_authenticated():
        return jsonify({"error": "Admin login required."}), 401
    return None


init_database()
seed_database_if_empty()
load_mail_templates()


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = request.headers.get("Origin", "*") or "*"
    response.headers["Vary"] = "Origin"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
    return response


def parse_schedule_datetime(date_str, time_str, am_pm):
    """Parse flexible date/time inputs into datetime."""
    if not date_str or not time_str:
        return None

    parsed_date = None
    for fmt in ("%Y-%m-%d", "%d-%m-%Y"):
        try:
            parsed_date = datetime.strptime(date_str.strip(), fmt).date()
            break
        except ValueError:
            continue
    if parsed_date is None:
        return None

    try:
        parts = time_str.strip().split(":")
        if len(parts) != 2:
            return None
        hour = int(parts[0])
        minute = int(parts[1])
    except (TypeError, ValueError):
        return None

    if not (0 <= minute <= 59):
        return None

    am_pm_val = (am_pm or "").strip().upper()

    # If user provides 24-hour time (like 23:02), accept directly.
    if 0 <= hour <= 23 and hour > 12:
        pass
    else:
        # Handle 12-hour mode with AM/PM.
        if hour == 0:
            hour = 12
        if not (1 <= hour <= 12):
            return None
        if am_pm_val == "AM":
            hour = 0 if hour == 12 else hour
        elif am_pm_val == "PM":
            hour = 12 if hour == 12 else hour + 12
        else:
            return None

    try:
        return datetime(
            parsed_date.year,
            parsed_date.month,
            parsed_date.day,
            hour,
            minute,
            0,
            0)
    except ValueError:
        return None


def is_valid_email(value):
    return bool(value and EMAIL_REGEX.match(value))


def is_valid_email_list(value):
    emails = normalize_email_list(value)
    if not emails:
        return False
    return all(is_valid_email(email) for email in emails)


def build_template_context(date_str):
    parsed = None
    for fmt in ("%Y-%m-%d", "%d-%m-%Y"):
        try:
            parsed = datetime.strptime(date_str.strip(), fmt)
            break
        except (TypeError, ValueError, AttributeError):
            continue
    if parsed is None:
        parsed = datetime.now()

    next_month = parsed.month + 1 if parsed.month < 12 else 1
    next_month_year = parsed.year if parsed.month < 12 else parsed.year + 1

    return {
        "month_short": parsed.strftime("%b"),
        "month_full": parsed.strftime("%B"),
        "year_short": parsed.strftime("%y"),
        "year_full": parsed.strftime("%Y"),
        "next_month_short": datetime(next_month_year, next_month, 1).strftime("%b"),
        "date_dotted": parsed.strftime("%d.%m.%Y"),
        "date_dashed": parsed.strftime("%d-%m-%Y"),
    }


def format_mail_template(template, date_str):
    context = build_template_context(date_str)
    scheduled_at = parse_schedule_datetime(date_str, template.get("time_24h"), template.get("am_pm"))
    return {
        "subject": template["subject"].format(**context),
        "body": normalize_day_ahead_body(
            template["body"].format(**context),
            template.get("id", ""),
            template.get("label", ""),
            scheduled_at,
        ),
    }


def normalize_email_list(value):
    if not value:
        return []
    normalized = value.replace(";", "\n").replace(",", "\n")
    return [item.strip() for item in normalized.splitlines() if item.strip()]


def get_template_by_id(template_id):
    with get_db_connection() as connection:
        row = connection.execute(
            """
            SELECT p.plant_name, mt.template_id, mt.label, mt.timing_hint, mt.time_24h, mt.am_pm,
                   mt.subject, mt.body, mt.default_to, mt.default_cc
            FROM mail_templates mt
            INNER JOIN plants p ON p.id = mt.plant_id
            WHERE mt.template_id = ? AND mt.active = 1 AND p.active = 1
            """,
            (template_id)).fetchone()
    if not row:
        return "", None
    return row["plant_name"], {
        "id": row["template_id"],
        "label": row["label"],
        "timing_hint": row["timing_hint"] or row["time_24h"],
        "time_24h": row["time_24h"],
        "am_pm": row["am_pm"],
        "subject": row["subject"],
        "body": row["body"],
        "default_to": row["default_to"] or "",
        "default_cc": row["default_cc"] or "",
    }


def build_tabular_report_csv_bytes(template_id, sender_email, recipient_email, cc_emails, date_str, plant_name=""):
    schema = TABULAR_REPORT_SCHEMAS.get(template_id)
    if not schema:
        return None, None

    context = build_template_context(date_str)
    resolved_plant_name = plant_name or get_template_by_id(template_id)[0] or "Plant Report"
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(schema["columns"])
    for row in schema["rows"](sender_email, recipient_email, cc_emails, context, resolved_plant_name):
        writer.writerow(row)
    return schema["file_name"], output.getvalue().encode("utf-8")


def build_job(
    recipient_email,
    scheduled_at,
    subject,
    body,
    plant_name="",
    mail_label="",
    attachment_name=None,
    attachment_bytes=None,
    cc="",
    template_id="",
    report_date="",
    employee_name="",
    mode="scheduled",
    portal_issue=False,
    auto_send_enabled=True):
    return {
        "email": recipient_email,
        "scheduled_at": scheduled_at,
        "attachment_name": attachment_name,
        "attachment_bytes": attachment_bytes,
        "subject": subject,
        "body": normalize_day_ahead_body(body, template_id, mail_label, scheduled_at),
        "cc": cc,
        "plant_name": plant_name,
        "mail_label": mail_label,
        "template_id": template_id,
        "report_date": report_date,
        "employee_name": employee_name,
        "mode": mode,
        "portal_issue": portal_issue,
        "auto_send_enabled": auto_send_enabled,
    }


def append_mail_log(entry):
    file_exists = os.path.exists(MAIL_LOG_PATH)
    with open(MAIL_LOG_PATH, "a", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=MAIL_LOG_HEADERS)
        if not file_exists or os.path.getsize(MAIL_LOG_PATH) == 0:
            writer.writeheader()
        writer.writerow({key: entry.get(key, "") for key in MAIL_LOG_HEADERS})


def log_mail_event(
    employee_name,
    from_email,
    to_email,
    cc_email,
    plant_name,
    mail_label,
    subject,
    status,
    mode,
    scheduled_at="",
    sent_at="",
    error_message=""):
    append_mail_log(
        {
            "employee_name": employee_name,
            "from_email": from_email,
            "to_email": to_email,
            "cc_email": cc_email,
            "plant_name": plant_name,
            "mail_label": mail_label,
            "subject": subject,
            "status": status,
            "mode": mode,
            "scheduled_at": scheduled_at,
            "sent_at": sent_at,
            "error_message": error_message,
        }
    )


def generate_report_csv(path="penalty-report.csv"):
    """Create daily penalty report CSV with sample rows."""
    rows = [
        ["Block Name", "Scheduled Value", "Actual Value", "Penalty"],
        ["Block A", 100, 92, 8],
        ["Block B", 75, 68, 7],
        ["Block C", 120, 111, 9],
        ["Block D", 90, 85, 5]]

    with open(path, "w", newline="", encoding="utf-8") as file:
        writer = csv.writer(file)
        writer.writerows(rows)


def build_report_csv_bytes():
    """Build report CSV in memory and return bytes."""
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Block Name", "Scheduled Value", "Actual Value", "Penalty"])
    writer.writerow(["Block A", 100, 92, 8])
    writer.writerow(["Block B", 75, 68, 7])
    writer.writerow(["Block C", 120, 111, 9])
    writer.writerow(["Block D", 90, 85, 5])
    return output.getvalue().encode("utf-8")


def append_employee_signature(body_text, employee_name=""):
    base_text = (body_text or "").strip()
    signer = (employee_name or "").strip()
    if not signer:
        return base_text
    return f"{base_text}\n\nThanks & Regards\n{signer}" if base_text else f"Thanks & Regards\n{signer}"


def plain_text_to_html(text):
    safe_text = (text or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return safe_text.replace("\n", "<br>")


def send_email_with_report(
    recipient_email,
    subject="Daily Penalty Report",
    body_text="Please find attached the daily penalty report",
    cc_emails="",
    employee_name=""):
    """Send email with CSV attachment via Gmail SMTP SSL."""
    if not EMAIL_USER or not EMAIL_PASS:
        raise RuntimeError("EMAIL_USER and EMAIL_PASS environment variables must be set.")

    report_path = "penalty-report.csv"

    try:
        generate_report_csv(report_path)

        message = MIMEMultipart()
        message["From"] = EMAIL_USER
        message["To"] = recipient_email
        cc_list = normalize_email_list(cc_emails)
        if cc_list:
            message["CC"] = ", ".join(cc_list)
        message["Subject"] = subject
        message.attach(MIMEText(append_employee_signature(body_text, employee_name), "plain"))

        with open(report_path, "rb") as attachment:
            part = MIMEBase("application", "octet-stream")
            part.set_payload(attachment.read())

        encoders.encode_base64(part)
        part.add_header("Content-Disposition", "attachment; filename=penalty-report.csv")
        message.attach(part)

        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
            server.login(EMAIL_USER, EMAIL_PASS)
            recipients = normalize_email_list(recipient_email) + cc_list
            server.sendmail(EMAIL_USER, recipients or [recipient_email], message.as_string())

        print(f"[SENT] Email sent to {recipient_email}")
    finally:
        if os.path.exists(report_path):
            os.remove(report_path)
            print(f"[CLEANUP] Deleted {report_path}")


def send_email_with_report_custom(
    sender_email,
    recipient_email,
    subject="Daily Penalty Report",
    body_text="Please find attached the daily penalty report",
    cc_emails="",
    employee_name=""):
    """Send report with explicit from/to fields."""
    if not sender_email or not recipient_email:
        raise RuntimeError("from_email and to_email are required.")
    if not EMAIL_USER:
        raise RuntimeError("EMAIL_USER is not configured.")
    # Gmail SMTP authenticates using EMAIL_USER/EMAIL_PASS.
    # We allow a different UI "From Email" value and still send through EMAIL_USER.
    send_email_with_report(
        recipient_email,
        subject=subject,
        body_text=body_text,
        cc_emails=cc_emails,
        employee_name=employee_name)


def send_plain_email(
    sender_email,
    recipient_email,
    subject,
    body_text,
    cc_emails="",
    employee_name=""):
    """Send plain email without any attachment."""
    if not EMAIL_USER or not EMAIL_PASS:
        raise RuntimeError("EMAIL_USER and EMAIL_PASS environment variables must be set.")
    if not sender_email or not recipient_email:
        raise RuntimeError("from_email and to_email are required.")

    message = MIMEMultipart()
    message["From"] = sender_email
    message["To"] = recipient_email
    cc_list = normalize_email_list(cc_emails)
    if cc_list:
        message["CC"] = ", ".join(cc_list)
    message["Subject"] = subject
    message.attach(MIMEText(append_employee_signature(body_text, employee_name), "plain"))

    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
        server.login(EMAIL_USER, EMAIL_PASS)
        recipients = normalize_email_list(recipient_email) + cc_list
        server.sendmail(EMAIL_USER, recipients or [recipient_email], message.as_string())

    print(f"[SENT] Plain email sent to {recipient_email}")


def send_email_with_custom_attachment(
    sender_email,
    recipient_email,
    file_name,
    file_bytes,
    subject="Custom Report Attachment",
    body_text="Please find attached the report file.",
    cc_emails="",
    employee_name=""):
    """Send email with user-uploaded attachment (PDF/DOC/DOCX)."""
    if not EMAIL_USER or not EMAIL_PASS:
        raise RuntimeError("EMAIL_USER and EMAIL_PASS environment variables must be set.")
    if not sender_email or not recipient_email:
        raise RuntimeError("from_email and to_email are required.")
    if not file_name or not file_bytes:
        raise RuntimeError("Attachment file is required.")

    guessed_type, _ = mimetypes.guess_type(file_name)
    is_image = bool(guessed_type and guessed_type.startswith("image/"))
    message = MIMEMultipart("mixed")
    message["From"] = sender_email
    message["To"] = recipient_email
    cc_list = normalize_email_list(cc_emails)
    if cc_list:
        message["CC"] = ", ".join(cc_list)
    message["Subject"] = subject
    final_body = append_employee_signature(body_text, employee_name)

    if is_image:
        subtype = guessed_type.split("/", 1)[1]
        related = MIMEMultipart("related")
        alternative = MIMEMultipart("alternative")
        html_body = (
            f"<html><body><div>{plain_text_to_html(final_body)}</div>"
            f'<br><img src="cid:portal_issue_image" alt="{file_name}" style="max-width:100%; height:auto; display:block;" />'
            f"</body></html>"
        )
        alternative.attach(MIMEText(final_body, "plain"))
        alternative.attach(MIMEText(html_body, "html"))
        related.attach(alternative)

        inline_image = MIMEImage(file_bytes, _subtype=subtype, name=file_name)
        inline_image.add_header("Content-ID", "<portal_issue_image>")
        inline_image.add_header("Content-Disposition", "inline", filename=file_name)
        related.attach(inline_image)
        message.attach(related)

        attachment_copy = MIMEImage(file_bytes, _subtype=subtype, name=file_name)
        attachment_copy.add_header("Content-Disposition", f'attachment; filename="{file_name}"')
        message.attach(attachment_copy)
    else:
        message.attach(MIMEText(final_body, "plain"))
        part = MIMEBase("application", "octet-stream")
        part.set_payload(file_bytes)
        encoders.encode_base64(part)
        part.add_header("Content-Disposition", f'attachment; filename="{file_name}"')
        message.attach(part)

    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
        server.login(EMAIL_USER, EMAIL_PASS)
        recipients = normalize_email_list(recipient_email) + cc_list
        server.sendmail(EMAIL_USER, recipients or [recipient_email], message.as_string())

    print(f"[SENT] Custom attachment email sent to {recipient_email} ({file_name})")


def send_portal_issue_email_with_image(
    sender_email,
    recipient_email,
    file_name,
    file_bytes,
    subject,
    body_text,
    cc_emails="",
    employee_name=""):
    """Send portal issue mail with the pasted image embedded after the email ending."""
    if not EMAIL_USER or not EMAIL_PASS:
        raise RuntimeError("EMAIL_USER and EMAIL_PASS environment variables must be set.")
    if not sender_email or not recipient_email:
        raise RuntimeError("from_email and to_email are required.")
    if not file_name or not file_bytes:
        raise RuntimeError("Image attachment is required.")

    guessed_type, _ = mimetypes.guess_type(file_name)
    if not guessed_type or not guessed_type.startswith("image/"):
        raise RuntimeError("Portal issue mail requires an image file.")

    final_body = append_employee_signature(body_text, employee_name)

    message = MIMEMultipart("mixed")
    message["From"] = sender_email
    message["To"] = recipient_email
    cc_list = normalize_email_list(cc_emails)
    if cc_list:
        message["CC"] = ", ".join(cc_list)
    message["Subject"] = subject

    related = MIMEMultipart("related")
    alternative = MIMEMultipart("alternative")
    html_body = (
        f"<html><body><div>{plain_text_to_html(final_body)}</div>"
        f"<br><div><strong>Portal issue screenshot:</strong></div>"
        f'<br><img src="cid:portal_issue_image" alt="{file_name}" style="max-width:100%; height:auto; display:block;" />'
        f"</body></html>"
    )
    alternative.attach(MIMEText(final_body, "plain"))
    alternative.attach(MIMEText(html_body, "html"))
    related.attach(alternative)

    subtype = guessed_type.split("/", 1)[1]
    inline_image = MIMEImage(file_bytes, _subtype=subtype, name=file_name)
    inline_image.add_header("Content-ID", "<portal_issue_image>")
    inline_image.add_header("Content-Disposition", "inline", filename=file_name)
    related.attach(inline_image)
    message.attach(related)

    fallback_attachment = MIMEBase("application", "octet-stream")
    fallback_attachment.set_payload(file_bytes)
    encoders.encode_base64(fallback_attachment)
    fallback_attachment.add_header("Content-Disposition", f'attachment; filename="{file_name}"')
    fallback_attachment.add_header("Content-Type", guessed_type, name=file_name)
    message.attach(fallback_attachment)

    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
        server.login(EMAIL_USER, EMAIL_PASS)
        recipients = normalize_email_list(recipient_email) + cc_list
        server.sendmail(EMAIL_USER, recipients or [recipient_email], message.as_string())

    print(f"[SENT] Portal issue inline image email sent to {recipient_email} ({file_name})")


def scheduler_loop():
    """Background scheduler: check every 60 seconds and send at scheduled datetime."""
    while True:
        now = datetime.now()
        print(f"[CHECK] Current time: {now.strftime('%Y-%m-%d %H:%M:%S')}")

        with jobs_lock:
            jobs_snapshot = list(scheduled_jobs)

        for job in jobs_snapshot:
            scheduled_at = job["scheduled_at"]
            print(f"[JOB] email={job['email']} scheduled_at={scheduled_at.strftime('%Y-%m-%d %I:%M %p')}")

            try:
                should_send = now >= scheduled_at

                if should_send:
                    if not job.get("auto_send_enabled", True):
                        print(f"[PAUSED] Auto-send is off for {job['email']} at {scheduled_at.strftime('%Y-%m-%d %I:%M %p')}")
                        continue
                    normalized_body = normalize_day_ahead_body(
                        job.get("body", ""),
                        job.get("template_id", ""),
                        job.get("mail_label", ""),
                        scheduled_at,
                    )
                    if job.get("attachment_name") and job.get("attachment_bytes") and job.get("portal_issue"):
                        send_portal_issue_email_with_image(
                            EMAIL_USER,
                            job["email"],
                            job["attachment_name"],
                            job["attachment_bytes"],
                            subject=job.get("subject", "Portal Issue"),
                            body_text=normalized_body,
                            cc_emails=job.get("cc", ""),
                            employee_name=job.get("employee_name", ""))
                    elif job.get("attachment_name") and job.get("attachment_bytes"):
                        send_email_with_custom_attachment(
                            EMAIL_USER,
                            job["email"],
                            job["attachment_name"],
                            job["attachment_bytes"],
                            subject=job.get("subject", "Custom Report Attachment"),
                            body_text=normalized_body or "Please find attached the report file.",
                            cc_emails=job.get("cc", ""),
                            employee_name=job.get("employee_name", ""))
                    elif job.get("portal_issue"):
                        send_plain_email(
                            EMAIL_USER or "",
                            job["email"],
                            subject=job.get("subject", "Portal Issue"),
                            body_text=normalized_body,
                            cc_emails=job.get("cc", ""),
                            employee_name=job.get("employee_name", ""))
                    elif job.get("template_id") in TABULAR_REPORT_SCHEMAS:
                        generated_name, generated_bytes = build_tabular_report_csv_bytes(
                            job.get("template_id", ""),
                            EMAIL_USER or "",
                            job["email"],
                            job.get("cc", ""),
                            job.get("report_date", scheduled_at.strftime("%Y-%m-%d")),
                            plant_name=job.get("plant_name", ""))
                        if not generated_name or not generated_bytes:
                            raise RuntimeError("Unable to generate tabular report attachment.")
                        send_email_with_custom_attachment(
                            EMAIL_USER,
                            job["email"],
                            generated_name,
                            generated_bytes,
                            subject=job.get("subject", "Generated Plant Report"),
                            body_text=normalized_body or "Please find attached the generated plant report.",
                            cc_emails=job.get("cc", ""),
                            employee_name=job.get("employee_name", ""))
                    else:
                        send_email_with_report(
                            job["email"],
                            subject=job.get("subject", "Daily Penalty Report"),
                            body_text=normalized_body or "Please find attached the daily penalty report",
                            cc_emails=job.get("cc", ""),
                            employee_name=job.get("employee_name", ""))
                    log_mail_event(
                        job.get("employee_name", ""),
                        EMAIL_USER or "",
                        job["email"],
                        job.get("cc", ""),
                        job.get("plant_name", ""),
                        job.get("mail_label", ""),
                        job.get("subject", ""),
                        status="sent",
                        mode=job.get("mode", "scheduled"),
                        scheduled_at=scheduled_at.strftime("%Y-%m-%d %I:%M %p"),
                        sent_at=now.strftime("%Y-%m-%d %I:%M %p"))
                    with jobs_lock:
                        scheduled_jobs[:] = [
                            live_job
                            for live_job in scheduled_jobs
                            if not (
                                live_job["email"] == job["email"]
                                and live_job["scheduled_at"] == job["scheduled_at"]
                            )
                        ]
                    print(f"[UPDATE] Sent and removed schedule for {job['email']}")
            except Exception as error:
                log_mail_event(
                    job.get("employee_name", ""),
                    EMAIL_USER or "",
                    job["email"],
                    job.get("cc", ""),
                    job.get("plant_name", ""),
                    job.get("mail_label", ""),
                    job.get("subject", ""),
                    status="failed",
                    mode=job.get("mode", "scheduled"),
                    scheduled_at=scheduled_at.strftime("%Y-%m-%d %I:%M %p"),
                    error_message=str(error))
                print(f"[ERROR] Failed job for {job['email']}: {error}")

        time.sleep(CHECK_INTERVAL_SECONDS)


@app.route("/", methods=["GET"])
def home():
    with open("index.html", "r", encoding="utf-8") as file:
        return file.read(), 200, {"Content-Type": "text/html"}


@app.route("/mail-templates", methods=["GET"])
def list_mail_templates():
    load_mail_templates()
    return jsonify({"plants": MAIL_TEMPLATES, "plant_options": fetch_plants(active_only=True)}), 200


@app.route("/plants", methods=["GET"])
def list_plants():
    include_inactive = str(request.args.get("include_inactive", "")).strip().lower() in {"1", "true", "yes"}
    return jsonify({"plants": fetch_plants(active_only=not include_inactive)}), 200


@app.route("/plant-master", methods=["GET"])
def list_plant_master():
    return jsonify({"plants": fetch_plants(active_only=False)}), 200


@app.route("/ui-session", methods=["GET"])
def ui_session():
    return jsonify(
        {
            "authenticated": bool(session.get("ui_role")),
            "username": session.get("ui_username", ""),
            "role": session.get("ui_role", ""),
        }
    ), 200


@app.route("/ui-login", methods=["POST"])
def ui_login():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = (data.get("password") or "").strip()

    user = UI_USERS.get(username)
    if not user or user["password"] != password:
        return jsonify({"error": "Invalid login credentials."}), 401

    session["ui_username"] = username
    session["ui_role"] = user["role"]
    return jsonify({"message": "Login successful.", "username": username, "role": user["role"]}), 200


@app.route("/ui-logout", methods=["POST"])
def ui_logout():
    session.pop("ui_username", None)
    session.pop("ui_role", None)
    return jsonify({"message": "Logged out successfully."}), 200


@app.route("/admin/login", methods=["POST"])
def admin_login():
    data = request.get_json(silent=True) or {}
    password = (data.get("password") or "").strip()
    if password != ADMIN_PASSWORD:
        return jsonify({"error": "Invalid admin password."}), 401
    session["is_admin"] = True
    return jsonify({"message": "Admin login successful."}), 200


@app.route("/admin/logout", methods=["POST"])
def admin_logout():
    session.pop("is_admin", None)
    return jsonify({"message": "Admin logged out."}), 200


@app.route("/admin/templates", methods=["GET"])
def get_admin_templates():
    auth_error = require_admin()
    if auth_error:
        return auth_error
    load_mail_templates()
    return jsonify({"plants": MAIL_TEMPLATES, "plant_options": fetch_plants(active_only=False)}), 200


@app.route("/admin/plants", methods=["POST"])
def save_admin_plant():
    auth_error = require_admin()
    if auth_error:
        return auth_error

    data = request.get_json(silent=True) or {}
    plant_name = (data.get("plant_name") or "").strip()
    plant_code = (data.get("plant_code") or "").strip()
    active = bool(data.get("active", True))

    if not plant_name:
        return jsonify({"error": "plant_name is required."}), 400

    with get_db_connection() as connection:
        upsert_plant(connection, plant_name, plant_code=plant_code, active=active)

    load_mail_templates()
    return jsonify({"message": "Plant master saved successfully."}), 200


@app.route("/admin/templates", methods=["POST"])
def save_admin_template():
    auth_error = require_admin()
    if auth_error:
        return auth_error

    data = request.get_json(silent=True) or {}
    plant_name = (data.get("plant_name") or "").strip()
    template_id = (data.get("template_id") or "").strip()
    label = (data.get("label") or "").strip()
    timing_hint = (data.get("timing_hint") or "").strip()
    time_24h = (data.get("time_24h") or "").strip()
    am_pm = (data.get("am_pm") or "AM").strip().upper()
    subject = (data.get("subject") or "").strip()
    body = (data.get("body") or "").strip()
    default_to = (data.get("default_to") or "").strip()
    default_cc = (data.get("default_cc") or "").strip()

    if not plant_name or not label or not time_24h or not subject or not body:
        return jsonify({"error": "plant_name, label, time_24h, subject and body are required."}), 400

    time_parts = time_24h.split(":")
    if len(time_parts) != 2 or not all(part.isdigit() for part in time_parts):
        return jsonify({"error": "time_24h must be in HH:MM format."}), 400

    if am_pm not in ("AM", "PM"):
        return jsonify({"error": "am_pm must be AM or PM."}), 400

    if default_to and not is_valid_email_list(default_to):
        return jsonify({"error": "Please enter valid To email addresses."}), 400
    if default_cc and not is_valid_email_list(default_cc):
        return jsonify({"error": "Please enter valid CC email addresses."}), 400

    if not template_id:
        template_id = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_") or "custom_template"

    updated_template = {
        "id": template_id,
        "label": label,
        "timing_hint": timing_hint or time_24h,
        "time_24h": time_24h,
        "am_pm": am_pm,
        "subject": subject,
        "body": body,
        "default_to": default_to,
        "default_cc": default_cc,
    }

    with get_db_connection() as connection:
        plant_row = upsert_plant(connection, plant_name)
        upsert_template_record(connection, plant_row["id"], updated_template)

    load_mail_templates()
    return jsonify({"message": "Template configuration saved successfully.", "template_id": template_id}), 200


@app.route("/schedule", methods=["POST"])
def schedule_email():
    data = request.get_json(silent=True) or {}
    employee_name = data.get("employee_name", "").strip()
    sender_email = data.get("from_email")
    recipient_email = data.get("to_email")
    cc_email = data.get("cc_email", "")
    date_str = data.get("date")
    time_str = data.get("time")
    am_pm = data.get("am_pm")
    subject = data.get("subject") or "Daily Penalty Report"
    body = data.get("body") or "Please find attached the daily penalty report"
    plant_name = data.get("plant_name", "")
    template_id = data.get("template_id", "")
    portal_issue = bool(data.get("portal_issue"))
    auto_send_enabled = bool(data.get("auto_send_enabled", not portal_issue))

    if not employee_name or not sender_email or not recipient_email or not date_str or not time_str or not am_pm:
        return jsonify({"error": "employee_name, from_email, to_email, date, time and am_pm are required."}), 400
    if not is_valid_email(sender_email) or not is_valid_email_list(recipient_email):
        return jsonify({"error": "Please enter valid from/to email addresses."}), 400

    scheduled_at = parse_schedule_datetime(date_str, time_str, am_pm)
    if not scheduled_at:
        return jsonify({"error": "Invalid date/time format."}), 400
    min_allowed_time = datetime.now() + timedelta(minutes=1)
    if scheduled_at <= min_allowed_time:
        return jsonify({"error": "Please choose a date/time at least 1 minute in the future."}), 400

    _, template = get_template_by_id(template_id)
    with jobs_lock:
        scheduled_jobs.append(
            build_job(
                recipient_email,
                scheduled_at,
                subject,
                body,
                plant_name=plant_name,
                mail_label=template["label"] if template else "",
                cc=cc_email,
                template_id=template_id,
                report_date=date_str,
                employee_name=employee_name,
                mode="scheduled",
                portal_issue=portal_issue,
                auto_send_enabled=auto_send_enabled)
        )
        print(f"[SCHEDULE] Added job: email={recipient_email}, when={scheduled_at.strftime('%Y-%m-%d %I:%M %p')}")
        log_mail_event(
            employee_name,
            sender_email,
            recipient_email,
            cc_email,
            plant_name,
            template["label"] if template else "",
            subject,
            status="scheduled",
            mode="scheduled",
            scheduled_at=scheduled_at.strftime("%Y-%m-%d %I:%M %p"))

    return jsonify(
        {
            "message": (
                f"Email scheduled from {sender_email} to {recipient_email} "
                f"on {date_str} at {time_str} {am_pm}."
            )
        }
    ), 200


@app.route("/schedule-all-templates", methods=["POST"])
def schedule_all_templates():
    data = request.get_json(silent=True) or {}
    employee_name = data.get("employee_name", "").strip()
    sender_email = data.get("from_email")
    recipient_email = data.get("to_email")
    cc_email = data.get("cc_email", "")
    date_str = data.get("date")
    auto_send_enabled = bool(data.get("auto_send_enabled", True))

    if not employee_name or not sender_email or not date_str:
        return jsonify({"error": "employee_name, from_email and date are required."}), 400
    if not is_valid_email(sender_email):
        return jsonify({"error": "Please enter a valid from email address."}), 400

    scheduled = 0
    skipped = 0
    min_allowed_time = datetime.now() + timedelta(minutes=1)

    with jobs_lock:
        for plant_name, templates in MAIL_TEMPLATES.items():
            for template in templates:
                scheduled_at = parse_schedule_datetime(date_str, template["time_24h"], template["am_pm"])
                if not scheduled_at or scheduled_at <= min_allowed_time:
                    skipped += 1
                    continue

                formatted = format_mail_template(template, date_str)
                final_to = template.get("default_to", recipient_email)
                final_cc = template.get("default_cc", cc_email)
                if not final_to:
                    skipped += 1
                    continue
                scheduled_jobs.append(
                    build_job(
                        final_to,
                        scheduled_at,
                        formatted["subject"],
                        formatted["body"],
                        plant_name=plant_name,
                        mail_label=template["label"],
                        cc=final_cc,
                        template_id=template["id"],
                        report_date=date_str,
                        employee_name=employee_name,
                        mode="bulk_schedule",
                        auto_send_enabled=auto_send_enabled)
                )
                log_mail_event(
                    employee_name,
                    sender_email,
                    final_to,
                    final_cc,
                    plant_name,
                    template["label"],
                    formatted["subject"],
                    status="scheduled",
                    mode="bulk_schedule",
                    scheduled_at=scheduled_at.strftime("%Y-%m-%d %I:%M %p"))
                scheduled += 1

    return jsonify(
        {
            "message": f"Scheduled {scheduled} plant mails.",
            "scheduled_count": scheduled,
            "skipped_count": skipped,
        }
    ), 200


@app.route("/schedule-with-attachment", methods=["POST"])
def schedule_with_attachment():
    employee_name = request.form.get("employee_name", "").strip()
    sender_email = request.form.get("from_email")
    recipient_email = request.form.get("to_email")
    cc_email = request.form.get("cc_email", "")
    date_str = request.form.get("date")
    time_str = request.form.get("time")
    am_pm = request.form.get("am_pm")
    subject = request.form.get("subject") or "Custom Report Attachment"
    body = request.form.get("body") or "Please find attached the report file."
    uploaded_file = request.files.get("report_file")
    plant_name = request.form.get("plant_name", "")
    template_id = request.form.get("template_id", "")
    portal_issue = (request.form.get("portal_issue", "") or "").strip().lower() == "true"
    auto_send_enabled = (request.form.get("auto_send_enabled", "true") or "").strip().lower() == "true"

    if not employee_name or not sender_email or not recipient_email or not date_str or not time_str or not am_pm:
        return jsonify({"error": "employee_name, from_email, to_email, date, time and am_pm are required."}), 400
    if not is_valid_email(sender_email) or not is_valid_email_list(recipient_email):
        return jsonify({"error": "Please enter valid from/to email addresses."}), 400
    if not uploaded_file or not uploaded_file.filename:
        return jsonify({"error": "Please choose a PDF or Word file for scheduled send."}), 400

    scheduled_at = parse_schedule_datetime(date_str, time_str, am_pm)
    if not scheduled_at:
        return jsonify({"error": "Invalid date/time format."}), 400

    min_allowed_time = datetime.now() + timedelta(minutes=1)
    if scheduled_at <= min_allowed_time:
        return jsonify({"error": "Please choose a date/time at least 1 minute in the future."}), 400

    attachment_name = uploaded_file.filename
    allowed_extensions = IMAGE_EXTENSIONS if portal_issue else DOCUMENT_EXTENSIONS
    if not attachment_name.lower().endswith(allowed_extensions):
        if portal_issue:
            return jsonify({"error": "Only image files are allowed for portal issue mail."}), 400
        return jsonify({"error": "Only PDF, DOC, and DOCX files are allowed."}), 400
    attachment_bytes = uploaded_file.read()
    if not attachment_bytes:
        return jsonify({"error": "Uploaded file is empty."}), 400

    with jobs_lock:
        scheduled_jobs.append(
            build_job(
                recipient_email,
                scheduled_at,
                subject,
                body,
                plant_name=plant_name,
                attachment_name=attachment_name,
                attachment_bytes=attachment_bytes,
                cc=cc_email,
                template_id=template_id,
                report_date=date_str,
                employee_name=employee_name,
                mode="scheduled_attachment",
                portal_issue=portal_issue,
                auto_send_enabled=auto_send_enabled)
        )
        print(
            f"[SCHEDULE] Added attachment job: email={recipient_email}, when={scheduled_at.strftime('%Y-%m-%d %I:%M %p')}"
        )
        _, template = get_template_by_id(template_id)
        log_mail_event(
            employee_name,
            sender_email,
            recipient_email,
            cc_email,
            plant_name,
            template["label"] if template else "",
            subject,
            status="scheduled",
            mode="scheduled_attachment",
            scheduled_at=scheduled_at.strftime("%Y-%m-%d %I:%M %p"))

    return jsonify(
        {
            "message": (
                f"Attachment report scheduled from {sender_email} to {recipient_email} "
                f"on {date_str} at {time_str} {am_pm}."
            )
        }
    ), 200


@app.route("/schedules", methods=["GET"])
def list_schedules():
    with jobs_lock:
        jobs = [
            {
                "email": job["email"],
                "scheduled_at": job["scheduled_at"].strftime("%Y-%m-%d %I:%M %p"),
                "has_attachment": bool(job.get("attachment_name")) or job.get("template_id") in TABULAR_REPORT_SCHEMAS,
                "subject": job.get("subject", ""),
                "cc": job.get("cc", ""),
                "plant_name": job.get("plant_name", ""),
                "mail_label": job.get("mail_label", ""),
                "employee_name": job.get("employee_name", ""),
                "auto_send_enabled": job.get("auto_send_enabled", True),
            }
            for job in scheduled_jobs
        ]
    return jsonify({"jobs": jobs}), 200


@app.route("/mail-logs", methods=["GET"])
def list_mail_logs():
    if not os.path.exists(MAIL_LOG_PATH):
        return jsonify({"logs": []}), 200
    try:
        with open(MAIL_LOG_PATH, "r", newline="", encoding="utf-8") as file:
            reader = csv.DictReader(file)
            logs = list(reader)
    except OSError:
        logs = []
    return jsonify({"logs": logs[-50:][::-1]}), 200


@app.route("/schedule", methods=["DELETE"])
def delete_schedule():
    data = request.get_json(silent=True) or {}
    email = data.get("email")

    if not email:
        return jsonify({"error": "email is required."}), 400
    if not is_valid_email_list(email):
        return jsonify({"error": "Please enter a valid email address."}), 400

    with jobs_lock:
        before_count = len(scheduled_jobs)
        scheduled_jobs[:] = [job for job in scheduled_jobs if job["email"] != email]
        deleted = before_count - len(scheduled_jobs)

    if deleted == 0:
        return jsonify({"error": f"No schedule found for {email}."}), 404

    print(f"[DELETE] Removed {deleted} schedule(s) for {email}")
    return jsonify({"message": f"Removed schedule for {email}."}), 200


@app.route("/download-report", methods=["POST"])
def download_report():
    data = request.get_json(silent=True) or {}
    email = data.get("email")

    if not email:
        return jsonify({"error": "email is required."}), 400
    if not is_valid_email_list(email):
        return jsonify({"error": "Please enter a valid email address."}), 400

    print(f"[DOWNLOAD] Report requested for email={email}")
    csv_bytes = build_report_csv_bytes()
    csv_stream = io.BytesIO(csv_bytes)

    return send_file(
        csv_stream,
        mimetype="text/csv",
        as_attachment=True,
        download_name="penalty-report.csv")


@app.route("/download-and-email-report", methods=["POST"])
def download_and_email_report():
    data = request.get_json(silent=True) or {}
    sender_email = data.get("from_email")
    recipient_email = data.get("to_email")
    cc_email = data.get("cc_email", "")
    subject = data.get("subject") or "Daily Penalty Report"
    body = data.get("body") or "Please find attached the daily penalty report"

    if not sender_email or not recipient_email:
        return jsonify({"error": "from_email and to_email are required."}), 400
    if not is_valid_email(sender_email) or not is_valid_email_list(recipient_email):
        return jsonify({"error": "Please enter valid from/to email addresses."}), 400

    try:
        # Send report as email attachment immediately.
        send_email_with_report_custom(
            sender_email,
            recipient_email,
            subject=subject,
            body_text=body,
            cc_emails=cc_email,
            employee_name=data.get("employee_name", ""))
    except Exception as error:
        print(f"[ERROR] Could not send report email to {recipient_email}: {error}")
        return jsonify({"error": f"Failed to send email: {error}"}), 500

    # Return same report as direct browser download.
    csv_bytes = build_report_csv_bytes()
    csv_stream = io.BytesIO(csv_bytes)
    print(f"[DOWNLOAD+EMAIL] Completed for email={recipient_email}")
    return send_file(
        csv_stream,
        mimetype="text/csv",
        as_attachment=True,
        download_name="penalty-report.csv")


@app.route("/send-report-now", methods=["POST"])
def send_report_now():
    data = request.get_json(silent=True) or {}
    employee_name = data.get("employee_name", "").strip()
    sender_email = data.get("from_email")
    recipient_email = data.get("to_email")
    cc_email = data.get("cc_email", "")
    template_id = data.get("template_id", "")
    report_date = data.get("date") or datetime.now().strftime("%Y-%m-%d")
    plant_name = data.get("plant_name", "")
    portal_issue = bool(data.get("portal_issue"))

    if not employee_name or not sender_email or not recipient_email:
        return jsonify({"error": "employee_name, from_email and to_email are required."}), 400
    if not is_valid_email(sender_email) or not is_valid_email_list(recipient_email):
        return jsonify({"error": "Please enter valid from/to email addresses."}), 400

    try:
        if portal_issue:
            send_plain_email(
                sender_email,
                recipient_email,
                subject=data.get("subject") or "Portal Issue",
                body_text=data.get("body") or "",
                cc_emails=cc_email,
                employee_name=employee_name)
        elif template_id in TABULAR_REPORT_SCHEMAS:
            file_name, file_bytes = build_tabular_report_csv_bytes(
                template_id,
                sender_email,
                recipient_email,
                cc_email,
                report_date,
                plant_name=plant_name)
            if not file_name or not file_bytes:
                raise RuntimeError("Unable to generate selected tabular report.")
            send_email_with_custom_attachment(
                sender_email,
                recipient_email,
                file_name,
                file_bytes,
                subject=data.get("subject") or "Generated Plant Report",
                body_text=data.get("body") or "Please find attached the generated plant report.",
                cc_emails=cc_email,
                employee_name=employee_name)
        else:
            send_email_with_report_custom(
                sender_email,
                recipient_email,
                subject=data.get("subject") or "Daily Penalty Report",
                body_text=data.get("body") or "Please find attached the daily penalty report",
                cc_emails=cc_email,
                employee_name=employee_name)
        _, template = get_template_by_id(template_id)
        log_mail_event(
            employee_name,
            sender_email,
            recipient_email,
            cc_email,
            plant_name,
            template["label"] if template else "",
            data.get("subject") or "Daily Penalty Report",
            status="sent",
            mode="immediate",
            sent_at=datetime.now().strftime("%Y-%m-%d %I:%M %p"))
        print(f"[SEND-NOW] Report emailed to {recipient_email}")
        return jsonify({"message": f"Report sent from {sender_email} to {recipient_email}."}), 200
    except Exception as error:
        _, template = get_template_by_id(template_id)
        log_mail_event(
            employee_name,
            sender_email,
            recipient_email,
            cc_email,
            plant_name,
            template["label"] if template else "",
            data.get("subject") or "Daily Penalty Report",
            status="failed",
            mode="immediate",
            error_message=str(error))
        print(f"[ERROR] Send-now failed for {recipient_email}: {error}")
        return jsonify({"error": f"Failed to send email: {error}"}), 500


@app.route("/send-custom-attachment", methods=["POST"])
def send_custom_attachment():
    sender_email = request.form.get("from_email", "").strip()
    recipient_email = request.form.get("to_email", "").strip()
    cc_email = request.form.get("cc_email", "").strip()
    subject = request.form.get("subject", "").strip() or "Custom Report Attachment"
    body = request.form.get("body", "").strip() or "Please find attached the report file."
    uploaded_file = request.files.get("report_file")
    portal_issue = (request.form.get("portal_issue", "") or "").strip().lower() == "true"

    if not sender_email or not recipient_email:
        return jsonify({"error": "from_email and to_email are required."}), 400
    if not is_valid_email(sender_email) or not is_valid_email_list(recipient_email):
        return jsonify({"error": "Please enter valid from/to email addresses."}), 400
    if not uploaded_file or not uploaded_file.filename:
        return jsonify({"error": "Please select a PDF or Word file."}), 400

    file_name = uploaded_file.filename
    allowed_extensions = IMAGE_EXTENSIONS if portal_issue else DOCUMENT_EXTENSIONS
    if not file_name.lower().endswith(allowed_extensions):
        if portal_issue:
            return jsonify({"error": "Only image files are allowed for portal issue mail."}), 400
        return jsonify({"error": "Only PDF, DOC, and DOCX files are allowed."}), 400

    file_bytes = uploaded_file.read()
    if not file_bytes:
        return jsonify({"error": "Uploaded file is empty."}), 400

    try:
        if portal_issue:
            send_portal_issue_email_with_image(
                sender_email,
                recipient_email,
                file_name,
                file_bytes,
                subject=subject,
                body_text=body,
                cc_emails=cc_email,
                employee_name=request.form.get("employee_name", "").strip())
        else:
            send_email_with_custom_attachment(
                sender_email,
                recipient_email,
                file_name,
                file_bytes,
                subject=subject,
                body_text=body,
                cc_emails=cc_email,
                employee_name=request.form.get("employee_name", "").strip())
        return jsonify({"message": f"Attachment email sent to {recipient_email}."}), 200
    except Exception as error:
        print(f"[ERROR] Custom attachment send failed for {recipient_email}: {error}")
        return jsonify({"error": f"Failed to send email: {error}"}), 500


@app.route("/health", methods=["GET"])
def health():
    with jobs_lock:
        job_count = len(scheduled_jobs)
    return jsonify(
        {
            "status": "ok",
            "email_configured": bool(EMAIL_USER and EMAIL_PASS),
            "job_count": job_count,
        }
    ), 200


def start_scheduler():
    thread = threading.Thread(target=scheduler_loop, daemon=True)
    thread.start()
    print("[START] Background scheduler thread started.")


if __name__ == "__main__":
    start_scheduler()
    app.run(host="0.0.0.0", port=5000, debug=False)
