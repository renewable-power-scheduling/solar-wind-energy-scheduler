import html
import html
import os
import re
import smtplib
from dataclasses import dataclass
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email import encoders
from typing import Any, Dict, Iterable, List, Optional, Tuple


_EMAIL_SPLIT_RE = re.compile(r"[;,]\s*|\s{2,}")


def _split_emails(value: str) -> List[str]:
    raw = str(value or "").strip()
    if not raw:
        return []
    parts = [p.strip() for p in _EMAIL_SPLIT_RE.split(raw) if p and p.strip()]
    # Keep order but de-dupe
    seen = set()
    out: List[str] = []
    for p in parts:
        key = p.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(p)
    return out


def render_text_as_html(text: str) -> str:
    escaped = html.escape(str(text or ""))
    return escaped.replace("\n", "<br/>")


def render_dsm_table_html(payload: Dict[str, Any]) -> str:
    cols = payload.get("columns")
    rows = payload.get("rows")
    if not isinstance(cols, list) or not isinstance(rows, list) or not cols:
        return ""

    safe_cols = [html.escape(str(c)) for c in cols]
    variant = str(payload.get("variant") or "").strip().lower()
    header_bg = "#f4f4f5"
    header_color = "#202124"
    if variant == "osepl":
        header_bg = "#0369a1"
        header_color = "#ffffff"
    elif variant in {"sirmour", "multi"}:
        header_bg = "#15803d"
        header_color = "#ffffff"

    def row_style(idx: int) -> str:
        if variant == "multi":
            if idx == 0:
                return "background-color:#fed7aa;"
            if idx == 1:
                return "background-color:#fef08a;"
            return "background-color:#e2e8f0;"
        if variant == "sirmour":
            return "background-color:#fed7aa;"
        return "background-color:#ffffff;"

    parts: List[str] = []
    parts.append('<div style="margin-top:12px;">')
    parts.append('<div style="font-weight:600;margin-bottom:6px;">DSM Report Preview</div>')
    parts.append('<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px;border:1px solid #8a8a8a;">')
    parts.append("<thead><tr>")
    for c in safe_cols:
        parts.append(
            f'<th style="background-color:{header_bg};color:{header_color};text-align:left;'
            f'border:1px solid #8a8a8a;padding:8px;font-weight:700;">{c}</th>'
        )
    parts.append("</tr></thead><tbody>")
    for idx, row in enumerate(rows):
        parts.append(f'<tr style="{row_style(idx)}">')
        for c in cols:
            v = ""
            if isinstance(row, dict):
                v = row.get(c)
            parts.append(
                f'<td style="{row_style(idx)}border:1px solid #8a8a8a;padding:8px;">'
                f"{html.escape('' if v is None else str(v))}</td>"
            )
        parts.append("</tr>")
    parts.append("</tbody></table></div>")
    return "".join(parts)


@dataclass
class EmailAttachment:
    filename: str
    content_bytes: bytes
    content_type: str = "application/octet-stream"


def build_email_html(*, body_text: str, employee_name: str = "", dsm_payload: Optional[Dict[str, Any]] = None) -> str:
    signature = ""
    if str(employee_name or "").strip():
        signature = f"<br/><br/>Regards,<br/>{html.escape(str(employee_name).strip())}"
    dsm_html = render_dsm_table_html(dsm_payload or {}) if dsm_payload else ""
    return f"{render_text_as_html(body_text)}{signature}{dsm_html}"


def send_email_smtp(
    *,
    from_email: str,
    to_email: str,
    cc_email: str = "",
    subject: str,
    body_text: str,
    employee_name: str = "",
    dsm_payload: Optional[Dict[str, Any]] = None,
    attachments: Optional[Iterable[EmailAttachment]] = None,
    smtp_profile: str = "default",
) -> Tuple[bool, str]:
    profile = str(smtp_profile or "default").strip().lower()
    prefix = "TESTING_" if profile in {"testing", "intern"} else ""

    smtp_host = os.getenv(f"{prefix}SMTP_HOST") or os.getenv("SMTP_HOST") or "smtp.gmail.com"
    smtp_port = int(os.getenv(f"{prefix}SMTP_PORT") or os.getenv("SMTP_PORT") or "587")
    smtp_user = (
        os.getenv(f"{prefix}EMAIL_USER")
        or os.getenv(f"{prefix}SMTP_USER")
        or os.getenv("EMAIL_USER")
        or os.getenv("SMTP_USER")
        or ""
    )
    smtp_pass = (
        os.getenv(f"{prefix}EMAIL_PASS")
        or os.getenv(f"{prefix}SMTP_PASS")
        or os.getenv("EMAIL_PASS")
        or os.getenv("SMTP_PASS")
        or ""
    )

    to_list = _split_emails(to_email)
    cc_list = _split_emails(cc_email)
    if not to_list:
        return False, "Missing To recipients"

    msg = MIMEMultipart("mixed")
    msg["From"] = str(from_email or smtp_user or "").strip()
    msg["To"] = ", ".join(to_list)
    if cc_list:
        msg["Cc"] = ", ".join(cc_list)
    msg["Subject"] = str(subject or "").strip()

    body_html = build_email_html(body_text=body_text, employee_name=employee_name, dsm_payload=dsm_payload)
    body_part = MIMEMultipart("alternative")
    body_part.attach(MIMEText(str(body_text or ""), "plain"))
    body_part.attach(MIMEText(body_html, "html"))
    msg.attach(body_part)

    for att in (attachments or []):
        if not att or not att.content_bytes:
            continue
        raw_type = str(att.content_type or "application/octet-stream").strip() or "application/octet-stream"
        parts = raw_type.split("/", 1)
        maintype = parts[0] if parts and parts[0] else "application"
        subtype = parts[1] if len(parts) > 1 and parts[1] else "octet-stream"
        part = MIMEBase(maintype, subtype)
        part.set_payload(att.content_bytes)
        encoders.encode_base64(part)
        part.add_header("Content-Disposition", f'attachment; filename="{att.filename}"')
        msg.attach(part)

    all_recipients = list(dict.fromkeys(to_list + cc_list))

    try:
        with smtplib.SMTP(smtp_host, smtp_port, timeout=30) as server:
            server.ehlo()
            if smtp_port in (587, 25):
                server.starttls()
                server.ehlo()
            if smtp_user and smtp_pass:
                server.login(smtp_user, smtp_pass)
            server.sendmail(msg["From"], all_recipients, msg.as_string())
        return True, "sent"
    except Exception as exc:
        return False, str(exc)
