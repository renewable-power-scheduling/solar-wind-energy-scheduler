import inspect
import sys
import unittest
from email import message_from_string
from pathlib import Path
from unittest.mock import MagicMock, patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from services.business_email_service import BusinessEmailAttachment, BusinessEmailInlineImage, send_business_email_smtp


def _call_send_business_email(**overrides):
    signature = inspect.signature(send_business_email_smtp)
    kwargs = {}
    for name, param in signature.parameters.items():
        lower = name.lower()
        if lower in {"from_email", "from_addr", "sender_email", "sender"}:
            kwargs[name] = "forecasting.india@vedanjay-power.com"
        elif lower in {"to_email", "to_emails", "to_addrs", "recipients", "recipient_emails"}:
            kwargs[name] = ["recipient@example.com"]
        elif lower in {"cc_email", "cc_emails", "cc_addrs"}:
            kwargs[name] = ["copy@example.com"]
        elif lower == "subject":
            kwargs[name] = "Powering Precision: Forecasting & Scheduling Partner for Your Renewable Energy Assets."
        elif lower in {"body", "body_text"}:
            kwargs[name] = (
                "Dear Sir/Madam,\n\n"
                "Greetings from Vedanjay Power Pvt. Ltd. (VPPL).\n"
                "Custom business email body for testing."
            )
        elif lower in {"attachments", "attachment_list", "files"}:
            attachment_signature = inspect.signature(BusinessEmailAttachment)
            attachment_kwargs = {}
            for attachment_name, attachment_param in attachment_signature.parameters.items():
                attachment_lower = attachment_name.lower()
                if attachment_lower in {"filename", "file_name", "name"}:
                    attachment_kwargs[attachment_name] = "proposal.pdf"
                elif attachment_lower in {"content", "content_bytes", "data", "file_bytes", "bytes"}:
                    attachment_kwargs[attachment_name] = b"%PDF-1.4 test attachment"
                elif attachment_lower in {"content_type", "mime_type", "mimetype"}:
                    attachment_kwargs[attachment_name] = "application/pdf"
                elif attachment_param.default is inspect._empty:
                    raise AssertionError(f"Unhandled attachment parameter: {attachment_name}")
            kwargs[name] = [BusinessEmailAttachment(**attachment_kwargs)]
        elif lower == "smtp_profile":
            kwargs[name] = "business"
        elif param.default is inspect._empty:
            raise AssertionError(f"Unhandled required parameter: {name}")

    kwargs.update(overrides)
    return send_business_email_smtp(**kwargs)


class BusinessEmailServiceTests(unittest.TestCase):
    @patch("services.business_email_service.smtplib.SMTP")
    @patch("services.business_email_service._read_smtp_config")
    def test_business_email_sender_preserves_body_and_attachment(self, read_config_mock, smtp_mock):
        read_config_mock.return_value = {
            "host": "smtp.example.com",
            "port": 587,
            "username": "forecasting.india@vedanjay-power.com",
            "password": "secret",
        }

        smtp_client = MagicMock()
        smtp_mock.return_value.__enter__.return_value = smtp_client

        result = _call_send_business_email()

        self.assertIsNotNone(result)
        self.assertTrue(smtp_client.starttls.called or smtp_client.login.called)
        self.assertTrue(smtp_client.send_message.called or smtp_client.sendmail.called)

        if smtp_client.send_message.called:
            message = smtp_client.send_message.call_args.args[0]
            self.assertIn(
                "Powering Precision: Forecasting & Scheduling Partner for Your Renewable Energy Assets.",
                message["Subject"],
            )
            payload = message.get_body(preferencelist=("plain",))
            if payload is None:
                payload = message
                body_text = payload.as_string()
            else:
                body_text = payload.get_content()
            self.assertIn("Custom business email body for testing.", body_text)
            self.assertIn("proposal.pdf", message.as_string())
            self.assertNotIn("Forecasting and QCA department", message.as_string())
        else:
            raw_message = smtp_client.sendmail.call_args.args[2]
            parsed = message_from_string(raw_message)
            self.assertIn(
                "Powering Precision: Forecasting & Scheduling Partner for Your Renewable Energy Assets.",
                parsed["Subject"],
            )
            self.assertIn("Custom business email body for testing.", parsed.as_string())
            self.assertIn("proposal.pdf", parsed.as_string())
            self.assertNotIn("Forecasting and QCA department", parsed.as_string())

    @patch("services.business_email_service.smtplib.SMTP")
    @patch("services.business_email_service._read_smtp_config")
    def test_business_email_sender_embeds_default_draft_images(self, read_config_mock, smtp_mock):
        read_config_mock.return_value = {
            "host": "smtp.example.com",
            "port": 587,
            "username": "forecasting.india@vedanjay-power.com",
            "password": "secret",
        }

        smtp_client = MagicMock()
        smtp_mock.return_value.__enter__.return_value = smtp_client

        result = _call_send_business_email(
            body_html=(
                '<div><img src="cid:business_email_greeting_banner" />'
                '<img src="cid:business_email_projects" /></div>'
            )
        )

        self.assertEqual(result, (True, "sent"))
        raw_message = smtp_client.sendmail.call_args.args[2]
        self.assertIn("Content-ID: <business_email_greeting_banner>", raw_message)
        self.assertIn("Content-ID: <business_email_projects>", raw_message)

    @patch("services.business_email_service.smtplib.SMTP")
    @patch("services.business_email_service._read_smtp_config")
    def test_business_email_sender_embeds_uploaded_inline_images(self, read_config_mock, smtp_mock):
        read_config_mock.return_value = {
            "host": "smtp.example.com",
            "port": 587,
            "username": "forecasting.india@vedanjay-power.com",
            "password": "secret",
        }

        smtp_client = MagicMock()
        smtp_mock.return_value.__enter__.return_value = smtp_client

        result = _call_send_business_email(
            body_html='<div><img src="cid:business_email_greeting_banner" /></div>',
            inline_images=[
                BusinessEmailInlineImage(
                    content_id="business_email_greeting_banner",
                    filename="banner.png",
                    content_bytes=b"fake image bytes",
                    content_type="image/png",
                )
            ],
        )

        self.assertEqual(result, (True, "sent"))
        raw_message = smtp_client.sendmail.call_args.args[2]
        self.assertIn("Content-ID: <business_email_greeting_banner>", raw_message)
        self.assertIn('filename="banner.png"', raw_message)

    @patch("services.business_email_service.smtplib.SMTP")
    @patch("services.business_email_service._read_smtp_config")
    def test_business_email_sender_hides_bcc_recipients(self, read_config_mock, smtp_mock):
        read_config_mock.return_value = {
            "host": "smtp.example.com",
            "port": 587,
            "username": "forecasting.india@vedanjay-power.com",
            "password": "secret",
        }

        smtp_client = MagicMock()
        smtp_mock.return_value.__enter__.return_value = smtp_client

        result = _call_send_business_email(
            to_email="visible@example.com",
            cc_email="copy@example.com",
            bcc_email="hidden1@example.com, hidden2@example.com",
        )

        self.assertEqual(result, (True, "sent"))
        sendmail_args = smtp_client.sendmail.call_args.args
        recipients = sendmail_args[1]
        raw_message = sendmail_args[2]
        self.assertIn("visible@example.com", recipients)
        self.assertIn("copy@example.com", recipients)
        self.assertIn("hidden1@example.com", recipients)
        self.assertIn("hidden2@example.com", recipients)
        parsed = message_from_string(raw_message)
        self.assertIsNone(parsed["Bcc"])
        self.assertNotIn("hidden1@example.com", raw_message)
        self.assertNotIn("hidden2@example.com", raw_message)


if __name__ == "__main__":
    unittest.main()
