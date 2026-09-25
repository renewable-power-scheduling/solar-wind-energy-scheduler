import os
import json
import os
import sys
import unittest
from datetime import datetime, timezone
from unittest.mock import patch


BACKEND_DIR = os.path.dirname(os.path.dirname(__file__))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from services import enercast_frozen_worker as worker


class EnercastFrozenWorkerTests(unittest.TestCase):
    def test_gsnp_is_required_for_enercast_frozen_daemon(self):
        self.assertIn("GSNP", worker._REQUIRED_ENERCAST_FROZEN_PLANTS)
        self.assertIn("GSNP", worker.ENERCAST_FROZEN_PLANTS)

    def test_gsnp_uses_madhya_pradesh_six_block_effective_delay(self):
        arrival = datetime(2026, 9, 4, 10, 0, tzinfo=worker._ist_tz())

        self.assertEqual(worker._effective_delay_minutes_for_plant("GSNP"), 90)
        self.assertEqual(worker._effective_block_from_arrival(arrival, plant_code="GSNP"), 47)

    def test_gsnp_loads_csv_revision_without_meta_from_last_modified(self):
        csv_key = "raw/vedanjay/GSNP/2026-08-06/enercast_data/intraday/gsnp_r1.csv"
        listed_objects = [{"Key": csv_key, "LastModified": datetime(2026, 8, 6, 4, 30, tzinfo=timezone.utc)}]

        with patch.object(worker, "_list_s3_objects", return_value=listed_objects):
            revisions = worker._load_intraday_revisions(
                bucket="test-bucket",
                plant_code="GSNP",
                schedule_date="2026-08-06",
            )

        self.assertEqual(len(revisions), 1)
        self.assertEqual(revisions[0]["csv_key"], csv_key)
        self.assertEqual(revisions[0]["meta_key"], "")
        self.assertEqual(revisions[0]["revision"], "r1")
        self.assertEqual(revisions[0]["arrival_dt"].tzinfo, worker._ist_tz())

    def test_gsnp_two_row_dc_reg_template_uses_forecast_column(self):
        csv_text = "\n".join(
            [
                "TYPE:,REG,",
                "DATE:,2026-09-04",
                "REVISION:,",
                "REASON:,NA,",
                "BLOCK,Block Interval,GLOBUS STEEL N POWER",
                ",,,Availability,Forecast",
                "1,00:00,00:15,20.00,0.00",
                "26,06:15,06:30,20.00,0.02",
                "47,11:30,11:45,20.00,5.62",
            ]
        )

        parsed = worker._parse_schedule_csv(csv_text)

        self.assertEqual(parsed[1], 0.0)
        self.assertEqual(parsed[26], 0.02)
        self.assertEqual(parsed[47], 5.62)

    def test_gsnp_recompute_writes_frozen_graph_artifact_from_dc_reg_csv(self):
        csv_key = "raw/vedanjay/GSNP/2026-09-04/enercast_data/intraday/GSNP_DC_REG_2026-09-04_.csv"
        csv_text = "\n".join(
            [
                "Block,Time,Forecast MW",
                "1,00:00-00:15,0",
                "2,00:15-00:30,1.25",
                "47,11:30-11:45,5.5",
            ]
        )
        puts = []

        class FakeS3:
            def put_object(self, **kwargs):
                puts.append(kwargs)
                return {}

        def fake_fetch(bucket, key):
            if key == csv_key:
                return csv_text
            if key.endswith("enercast_edited_frozen.csv"):
                return ""
            return ""

        listed_objects = [
            {"Key": csv_key, "LastModified": datetime(2026, 9, 4, 4, 30, tzinfo=timezone.utc)},
        ]

        with patch.object(worker, "_list_s3_objects", return_value=listed_objects), \
             patch.object(worker, "_fetch_s3_text", side_effect=fake_fetch), \
             patch.object(worker, "boto3") as fake_boto3:
            fake_boto3.client.return_value = FakeS3()
            result = worker.recompute_enercast_frozen_for_site_date(
                plant_code="GSNP",
                schedule_date="2026-09-04",
            )

        self.assertTrue(result["success"])
        self.assertEqual(result["schedule_key"], "frozenschedules/vedanjay/GSNP/2026-09-04/enercast_edited_frozen.csv")
        self.assertTrue(any(call.get("Key") == "frozenschedules/vedanjay/GSNP/2026-09-04/enercast_edited_frozen.csv" for call in puts))

    def test_non_gsnp_still_requires_meta_revision(self):
        csv_key = "raw/vedanjay/CME/2026-08-06/enercast_data/intraday/cme_r1.csv"
        listed_objects = [{"Key": csv_key, "LastModified": datetime(2026, 8, 6, 4, 30, tzinfo=timezone.utc)}]

        with patch.object(worker, "_list_s3_objects", return_value=listed_objects):
            revisions = worker._load_intraday_revisions(
                bucket="test-bucket",
                plant_code="CME",
                schedule_date="2026-08-06",
            )

        self.assertEqual(revisions, [])

    def test_chandwasa_plant_specific_header_builds_frozen_csv(self):
        csv_key = "raw/vedanjay/CHANDAWASA/2026-08-18/enercast_data/intraday/vedanjay_chandwasa_IntradayCERC_2026-08-18-14-35+0530.csv"
        meta_key = "raw/vedanjay/CHANDAWASA/2026-08-18/enercast_data/intraday/vedanjay_chandwasa_IntradayCERC_2026-08-18-14-35+0530.meta.json"
        meta_payload = {
            "filename": "vedanjay_chandwasa_IntradayCERC_2026-08-18-14-35+0530.csv",
            "arrival_timestamp_ist": "2026-08-18T14:35:00+05:30",
        }
        csv_text = "\n".join(
            [
                "Block,Block Interval,MARUT_SHAKTI_CHANDWASA",
                "1,00:00-00:15,1.25",
                "2,00:15-00:30,1.50",
            ]
        )

        def fake_fetch(bucket, key):
            if key == meta_key:
                return json.dumps(meta_payload)
            if key == csv_key:
                return csv_text
            return ""

        listed_objects = [
            {"Key": csv_key, "LastModified": datetime(2026, 8, 18, 9, 5, tzinfo=timezone.utc)},
            {"Key": meta_key, "LastModified": datetime(2026, 8, 18, 9, 5, tzinfo=timezone.utc)},
        ]

        with patch.object(worker, "_list_s3_objects", return_value=listed_objects), patch.object(worker, "_fetch_s3_text", side_effect=fake_fetch):
            revisions = worker._load_intraday_revisions(
                bucket="test-bucket",
                plant_code="CHANDWASA",
                schedule_date="2026-08-18",
            )
            built = worker._build_enercast_frozen_csv(
                bucket="test-bucket",
                revisions=revisions,
                plant_code="CHANDWASA",
            )

        self.assertEqual(len(revisions), 1)
        self.assertIsNotNone(built)
        self.assertIn("1,00:00,1.25", built["csv_text"])
        self.assertIn("2,00:15,1.5", built["csv_text"])

    def test_chandwasa_frozen_output_uses_chandawasa_folder(self):
        csv_key = "raw/vedanjay/CHANDAWASA/2026-08-18/enercast_data/intraday/vedanjay_chandwasa_IntradayCERC_2026-08-18-14-35+0530.csv"
        meta_key = "raw/vedanjay/CHANDAWASA/2026-08-18/enercast_data/intraday/vedanjay_chandwasa_IntradayCERC_2026-08-18-14-35+0530.meta.json"
        meta_payload = {
            "filename": "vedanjay_chandwasa_IntradayCERC_2026-08-18-14-35+0530.csv",
            "arrival_timestamp_ist": "2026-08-18T14:35:00+05:30",
        }
        csv_text = "\n".join(
            [
                "Block,Block Interval,MARUT_SHAKTI_CHANDWASA",
                "1,00:00-00:15,1.25",
            ]
        )
        puts = []

        class FakeS3:
            def put_object(self, **kwargs):
                puts.append(kwargs)
                return {}

        def fake_fetch(bucket, key):
            if key == meta_key:
                return json.dumps(meta_payload)
            if key == csv_key:
                return csv_text
            if key.endswith("enercast_edited_frozen.csv"):
                return ""
            return ""

        listed_objects = [
            {"Key": csv_key, "LastModified": datetime(2026, 8, 18, 9, 5, tzinfo=timezone.utc)},
            {"Key": meta_key, "LastModified": datetime(2026, 8, 18, 9, 5, tzinfo=timezone.utc)},
        ]

        with patch.object(worker, "_list_s3_objects", return_value=listed_objects), \
             patch.object(worker, "_fetch_s3_text", side_effect=fake_fetch), \
             patch.object(worker, "boto3") as fake_boto3:
            fake_boto3.client.return_value = FakeS3()
            result = worker.recompute_enercast_frozen_for_site_date(
                plant_code="CHANDWASA",
                schedule_date="2026-08-18",
            )

        self.assertTrue(result["success"])
        self.assertTrue(any(call.get("Key", "").startswith("frozenschedules/vedanjay/CHANDWASA/2026-08-18/") for call in puts))
        self.assertTrue(any(call.get("Key") == "frozenschedules/vedanjay/CHANDWASA/2026-08-18/enercast_edited_frozen.csv" for call in puts))

    def test_chandwasa_can_load_csv_without_meta(self):
        csv_key = "raw/vedanjay/CHANDWASA/2026-08-18/enercast_data/intraday/vedanjay_chandwasa_IntradayCERC_2026-08-18-14-35+0530.csv"
        csv_text = "\n".join(
            [
                "Block,Block Interval,MARUT_SHAKTI_CHANDWASA",
                "1,00:00-00:15,1.25",
                "2,00:15-00:30,1.50",
            ]
        )

        with patch.object(worker, "_list_s3_objects", return_value=[{"Key": csv_key, "LastModified": datetime(2026, 8, 18, 9, 5, tzinfo=timezone.utc)}]), \
             patch.object(worker, "_fetch_s3_text", side_effect=lambda bucket, key: csv_text if key == csv_key else ""):
            revisions = worker._load_intraday_revisions(
                bucket="test-bucket",
                plant_code="CHANDWASA",
                schedule_date="2026-08-18",
            )

        self.assertEqual(len(revisions), 1)
        self.assertEqual(revisions[0]["csv_key"], csv_key)

    def test_chandwasa_fuzzy_matches_csv_when_meta_basename_differs(self):
        meta_key = "raw/vedanjay/CHANDAWASA/2026-08-18/enercast_data/intraday/vedanjay_chandawasa_IntradayCERC_2026-08-18-17-35+0530.meta.json"
        csv_key = "raw/vedanjay/CHANDAWASA/2026-08-18/enercast_data/intraday/CHANDWASA_IntradayCERC_2026-08-18-17-35+0530.csv"
        meta_payload = {"arrival_timestamp_ist": "2026-08-18T17:35:00+05:30"}
        csv_text = "\n".join(
            [
                "Block,Block Interval,MARUT_SHAKTI_CHANDWASA",
                "1,00:00-00:15,1.25",
            ]
        )

        def fake_fetch(bucket, key):
            if key == meta_key:
                return json.dumps(meta_payload)
            if key == csv_key:
                return csv_text
            return ""

        listed_objects = [
            {"Key": csv_key, "LastModified": datetime(2026, 8, 18, 12, 5, tzinfo=timezone.utc)},
            {"Key": meta_key, "LastModified": datetime(2026, 8, 18, 12, 5, tzinfo=timezone.utc)},
        ]

        with patch.object(worker, "_list_s3_objects", return_value=listed_objects), patch.object(worker, "_fetch_s3_text", side_effect=fake_fetch):
            revisions = worker._load_intraday_revisions(
                bucket="test-bucket",
                plant_code="CHANDWASA",
                schedule_date="2026-08-18",
            )

        self.assertEqual(len(revisions), 1)
        self.assertEqual(revisions[0]["csv_key"], csv_key)

    def test_jewli_timestamp_rows_parse_forecast_megawatt_column(self):
        csv_text = "\n".join(
            [
                "Timestamp (Asia/Kolkata),Timestamp (Asia/Kolkata),Forecast (MEGAWATT)",
                "2026-09-22 00:00,2026-09-22 00:15,39.520",
                "2026-09-22 00:15,2026-09-22 00:30,40.125",
                "2026-09-22 23:45,2026-09-23 00:00,12.750",
            ]
        )

        parsed = worker._parse_schedule_csv(csv_text, plant_code="JEWLI")

        self.assertEqual(parsed[1], 39.52)
        self.assertEqual(parsed[2], 40.125)
        self.assertEqual(parsed[96], 12.75)


if __name__ == "__main__":
    unittest.main()
