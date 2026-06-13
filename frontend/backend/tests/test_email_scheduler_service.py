import os
import sys
import unittest


BACKEND_DIR = os.path.dirname(os.path.dirname(__file__))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from services.email_scheduler_service import normalize_day_ahead_body


class EmailSchedulerBodyTests(unittest.TestCase):
    def test_da0_uses_day_ahead_zero(self):
        body = (
            "Dear Sir/Mam,\n"
            "Please find attached KOTHAGUDEM (37 MW) Day Ahead-01 Schedule for Date 11.06.2026."
        )
        self.assertEqual(
            normalize_day_ahead_body(body, "kothagudem_da0"),
            (
                "Dear Sir/Mam,\n"
                "Please find attached KOTHAGUDEM (37 MW) Day Ahead-0 Schedule for Date 11.06.2026."
            ),
        )

    def test_da1_uses_day_ahead_one(self):
        body = (
            "Dear Sir/Mam,\n"
            "Please find attached KOTHAGUDEM (37 MW) Day Ahead-02 Schedule for Date 11.06.2026."
        )
        self.assertEqual(
            normalize_day_ahead_body(body, "kothagudem_da1"),
            (
                "Dear Sir/Mam,\n"
                "Please find attached KOTHAGUDEM (37 MW) Day Ahead-1 Schedule for Date 11.06.2026."
            ),
        )

    def test_non_day_ahead_body_is_unchanged(self):
        body = "Dear Sir/Mam,\nPlease find attached DSM report."
        self.assertEqual(normalize_day_ahead_body(body, "kothagudem_dsm"), body)


if __name__ == "__main__":
    unittest.main()
