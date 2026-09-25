import html
import os
import re
import smtplib
from email import encoders
from email.mime.base import MIMEBase
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional, Tuple

from services.email_dispatch_service import EmailAttachment, _split_emails, render_text_as_html


@dataclass
class BusinessEmailAttachment:
    filename: str
    content_bytes: bytes
    content_type: str = "application/octet-stream"


@dataclass
class BusinessEmailInlineImage:
    content_id: str
    filename: str
    content_bytes: bytes
    content_type: str = "image/png"


BUSINESS_EMAIL_INLINE_IMAGES = (
    ("business_email_greeting_banner", "vedanjay-greeting-banner.png"),
    ("business_email_projects", "vedanjay-projects.png"),
)


def _business_email_asset_path(filename: str) -> Path:
    return Path(__file__).resolve().parents[2] / "public" / "business-email" / filename


def _load_business_inline_images(body_html: str) -> List[BusinessEmailInlineImage]:
    html_body = str(body_html or "")
    images: List[BusinessEmailInlineImage] = []
    for content_id, filename in BUSINESS_EMAIL_INLINE_IMAGES:
        if f"cid:{content_id}" not in html_body:
            continue
        path = _business_email_asset_path(filename)
        try:
            data = path.read_bytes()
        except Exception:
            continue
        if data:
            images.append(
                BusinessEmailInlineImage(
                    content_id=content_id,
                    filename=filename,
                    content_bytes=data,
                    content_type="image/png",
                )
            )
    return images


def _normalize_business_inline_images(
    *,
    body_html: str,
    inline_images: Optional[Iterable[BusinessEmailInlineImage]] = None,
) -> List[BusinessEmailInlineImage]:
    html_body = str(body_html or "")
    normalized: List[BusinessEmailInlineImage] = []
    seen = set()
    for image in (inline_images or []):
        if not image or not getattr(image, "content_bytes", None):
            continue
        content_id = str(getattr(image, "content_id", "") or "").strip().strip("<>")
        if not content_id or f"cid:{content_id}" not in html_body:
            continue
        if content_id in seen:
            continue
        filename = str(getattr(image, "filename", "") or "").strip() or f"{content_id}.png"
        content_type = str(getattr(image, "content_type", "") or "image/png").strip() or "image/png"
        normalized.append(
            BusinessEmailInlineImage(
                content_id=content_id,
                filename=filename,
                content_bytes=bytes(image.content_bytes),
                content_type=content_type,
            )
        )
        seen.add(content_id)

    for image in _load_business_inline_images(html_body):
        if image.content_id not in seen:
            normalized.append(image)
            seen.add(image.content_id)
    return normalized


def _guess_content_type(filename: str, content_type: str = "") -> str:
    raw = str(content_type or "").strip()
    if raw and raw != "application/octet-stream":
        return raw

    lower = str(filename or "").strip().lower()
    if lower.endswith(".pdf"):
        return "application/pdf"
    if lower.endswith(".xlsx"):
        return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    if lower.endswith(".xls"):
        return "application/vnd.ms-excel"
    return "application/octet-stream"


def _read_smtp_config(smtp_profile: str) -> Tuple[str, int, str, str]:
    profile = str(smtp_profile or "default").strip().lower()
    prefix = "BUSINESS_" if profile in {"business", "business_email"} else ("TESTING_" if profile in {"testing", "intern"} else "")

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
    return smtp_host, smtp_port, smtp_user, smtp_pass


def send_business_email_smtp(
    *,
    from_email: str,
    to_email: str,
    cc_email: str = "",
    bcc_email: str = "",
    subject: str,
    body_text: str,
    body_html: str = "",
    inline_images: Optional[Iterable[BusinessEmailInlineImage]] = None,
    attachments: Optional[Iterable[BusinessEmailAttachment | EmailAttachment]] = None,
    smtp_profile: str = "business",
) -> Tuple[bool, str]:
    smtp_host, smtp_port, smtp_user, smtp_pass = _read_smtp_config(smtp_profile)
    # Business emails can include large PDF/XLSX attachments; allow SMTP enough
    # time to finish the DATA response without changing other email flows.
    try:
        smtp_timeout = max(30, int(os.getenv("BUSINESS_SMTP_TIMEOUT_SECONDS", "120")))
    except (TypeError, ValueError):
        smtp_timeout = 120

    to_list = _split_emails(to_email)
    cc_list = _split_emails(cc_email)
    bcc_list = _split_emails(bcc_email)
    if not to_list and not bcc_list:
        return False, "Missing recipients"

    msg = MIMEMultipart("mixed")
    msg["From"] = str(from_email or smtp_user or "").strip()
    msg["To"] = ", ".join(to_list) if to_list else "undisclosed-recipients:;"
    if cc_list:
        msg["Cc"] = ", ".join(cc_list)
    msg["Subject"] = str(subject or "").strip()

    body_plain = str(body_text or "")
    rich_body_html = str(body_html or "").strip() or render_text_as_html(body_plain)
    normalized_inline_images = _normalize_business_inline_images(
        body_html=rich_body_html,
        inline_images=inline_images,
    )
    body_part = MIMEMultipart("alternative")
    body_part.attach(MIMEText(body_plain, "plain"))
    body_part.attach(MIMEText(rich_body_html, "html"))
    if normalized_inline_images:
        related_part = MIMEMultipart("related")
        related_part.attach(body_part)
        for image in normalized_inline_images:
            raw_type = str(image.content_type or "").strip().lower()
            subtype = raw_type.split("/", 1)[1] if raw_type.startswith("image/") and "/" in raw_type else ""
            if not subtype:
                subtype = "png" if image.filename.lower().endswith(".png") else "jpeg"
            image_part = MIMEImage(bytes(image.content_bytes), _subtype=subtype)
            image_part.add_header("Content-ID", f"<{image.content_id}>")
            image_part.add_header("Content-Disposition", "inline", filename=image.filename)
            related_part.attach(image_part)
        msg.attach(related_part)
    else:
        msg.attach(body_part)

    for att in (attachments or []):
        if not att or not getattr(att, "content_bytes", None):
            continue
        filename = str(getattr(att, "filename", "") or "").strip() or "attachment.bin"
        raw_type = _guess_content_type(filename, str(getattr(att, "content_type", "") or ""))
        maintype, subtype = raw_type.split("/", 1) if "/" in raw_type else ("application", "octet-stream")
        part = MIMEBase(maintype, subtype)
        part.set_payload(bytes(att.content_bytes))
        encoders.encode_base64(part)
        part.add_header("Content-Disposition", f'attachment; filename="{filename}"')
        msg.attach(part)

    all_recipients = list(dict.fromkeys(to_list + cc_list + bcc_list))

    try:
        with smtplib.SMTP(smtp_host, smtp_port, timeout=smtp_timeout) as server:
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
