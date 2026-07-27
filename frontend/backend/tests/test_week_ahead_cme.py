import os
import sys
import unittest
from datetime import date


BACKEND_DIR = os.path.dirname(os.path.dirname(__file__))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import main


class CmeWeekAheadTests(unittest.TestCase):
    def test_cme_week_ahead_forecast_schedule_and_avc_are_normalized(self):
        values = [
            {"date": "2026-07-23", "block": 1, "declared_forecast": 1.25, "inter_avc": 0, "schedule": 9},
            {"date": "2026-07-22", "block": 1, "declared_forecast": 0, "inter_avc": 5, "schedule": 0},
            {"date": "2026-07-22", "block": 2, "declared_forecast": 0.5, "inter_avc": 0, "schedule": 7},
        ]

        normalized = main._week_ahead_normalize_cme_values(values, date(2026, 7, 21))

        self.assertEqual(normalized[0]["date"], "2026-07-22")
        self.assertEqual(normalized[0]["block"], 1)
        self.assertEqual(normalized[0]["declared_forecast"], 0)
        self.assertEqual(normalized[0]["inter_avc"], 0)
        self.assertEqual(normalized[0]["schedule"], 0)
        self.assertEqual(normalized[1]["date"], "2026-07-22")
        self.assertEqual(normalized[1]["block"], 2)
        self.assertEqual(normalized[1]["declared_forecast"], 0.5)
        self.assertEqual(normalized[1]["inter_avc"], 5)
        self.assertEqual(normalized[1]["schedule"], 0.5)

    def test_cme_week_ahead_csv_fills_declared_forecast_intra_avc_and_schedule(self):
        values = main._week_ahead_normalize_cme_values(
            [0, 0.75],
            date(2026, 7, 21),
        )
        template = (
            "Schedule Template for MH_VEDANJAY and revision WA,,,\n"
            ",Scheduling entity,MH_VEDANJAY,\n"
            ",Date,2026-07-21,\n"
            ",Revision No,WA,\n"
            "Block,Declared Forecast,Intra Avc,Schedule\n"
            "1,,,\n"
            "2,,,\n"
            "3,,,\n"
        ).encode("utf-8")

        output = main._week_ahead_fill_csv(template, values).decode("utf-8")

        self.assertIn("1,0,0,0", output)
        self.assertIn("2,0.75,5,0.75", output)


class OseplWeekAheadTests(unittest.TestCase):
    def test_osepl_week_ahead_inter_avc_is_zero_for_non_generation_blocks(self):
        values = [
            {"date": "2026-07-22", "block": 1, "declared_forecast": 0, "inter_avc": 20, "schedule": 0},
            {"date": "2026-07-22", "block": 26, "declared_forecast": 0.21, "inter_avc": 20, "schedule": 0.21},
        ]

        normalized = main._week_ahead_normalize_osepl_values(values)

        self.assertEqual(normalized[0]["inter_avc"], 0)
        self.assertEqual(normalized[1]["inter_avc"], 20)

    def test_osepl_week_ahead_csv_uses_zero_inter_avc_for_non_generation_blocks(self):
        values = main._week_ahead_normalize_osepl_values([
            {"date": "2026-07-22", "block": 1, "declared_forecast": 0, "inter_avc": 20, "schedule": 0},
            {"date": "2026-07-22", "block": 2, "declared_forecast": 0.5, "inter_avc": 20, "schedule": 0.5},
        ])
        template = (
            "Schedule Template for MH_VEDANJAY and revision WA,,,\n"
            ",Scheduling entity,MH_VEDANJAY,\n"
            ",Date,2026-07-22,\n"
            ",Revision No,WA,\n"
            "Block,Declared Forecast,Inter Avc,Schedule\n"
            "1,,,\n"
            "2,,,\n"
        ).encode("utf-8")

        output = main._week_ahead_fill_csv(template, values).decode("utf-8")

        self.assertIn("1,0,0,0", output)
        self.assertIn("2,0.5,20,0.5", output)


if __name__ == "__main__":
    unittest.main()
