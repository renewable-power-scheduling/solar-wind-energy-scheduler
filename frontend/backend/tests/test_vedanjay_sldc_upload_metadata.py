import io
import json
import os
import sys
import unittest
from unittest.mock import patch

from starlette.datastructures import UploadFile


BACKEND_DIR = os.path.dirname(os.path.dirname(__file__))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import main


class FakeS3:
    def __init__(self):
        self.puts = []
        self.deletes = []

    def put_object(self, **kwargs):
        self.puts.append(kwargs)

    def delete_object(self, **kwargs):
        self.deletes.append(kwargs)


class VedanjaySldcUploadMetadataTests(unittest.IsolatedAsyncioTestCase):
    async def test_upload_writes_schedule_and_audit_sidecar(self):
        fake_s3 = FakeS3()
        rows = [{"block": block, "mw": 1.0} for block in range(1, 97)]
        upload = UploadFile(filename="plant_schedule.csv", file=io.BytesIO(b"schedule-data"))

        with (
            patch.object(main, "_derive_s3_bucket_name", return_value="test-bucket"),
            patch.object(main, "_get_vedanjay_sldc_s3_client", return_value=fake_s3),
            patch.object(main, "_parse_vedanjay_sldc_schedule", return_value=rows),
        ):
            response = await main.upload_vedanjay_sldc_schedule(
                file=upload,
                plant_code="KOTHAGUDEM",
                plant_name="Kothagudem",
                schedule_date="2026-06-22",
                state="Telangana",
                sldc_submission_time="14:35",
                uploader="Pooja Patil (Executive, member)",
                uploader_employee_id="VPPL6127",
                uploader_name="Pooja Patil",
                uploader_role="member",
            )

        self.assertEqual(len(fake_s3.puts), 2)
        self.assertEqual(fake_s3.deletes, [])
        self.assertTrue(response["s3_key"].endswith("plant_schedule.csv"))
        self.assertEqual(response["log_key"], f'{response["s3_key"]}.metadata.json')
        self.assertEqual(response["sldc_submission_time"], "14:35")

        log_put = fake_s3.puts[1]
        self.assertEqual(log_put["Key"], response["log_key"])
        self.assertEqual(log_put["ContentType"], "application/json")
        audit = json.loads(log_put["Body"].decode("utf-8"))
        self.assertEqual(audit["state"], "Telangana")
        self.assertEqual(audit["plant_name"], "Kothagudem")
        self.assertEqual(audit["plant_code"], "KOTHAGUDEM")
        self.assertEqual(audit["schedule_date"], "2026-06-22")
        self.assertEqual(audit["sldc_submission_time"], "14:35")
        self.assertEqual(audit["uploaded_by"]["employee_id"], "VPPL6127")
        self.assertEqual(audit["uploaded_by"]["name"], "Pooja Patil")
        self.assertEqual(audit["parsed_blocks"], 96)
        self.assertEqual(len(audit["file_checksum_sha256"]), 64)

    def test_submission_time_validation(self):
        self.assertEqual(main._validate_sldc_submission_time("00:00"), "00:00")
        self.assertEqual(main._validate_sldc_submission_time("23:59"), "23:59")
        with self.assertRaises(Exception):
            main._validate_sldc_submission_time("24:00")


if __name__ == "__main__":
    unittest.main()
