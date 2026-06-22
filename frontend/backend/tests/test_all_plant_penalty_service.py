import json
import os
import sys
import unittest
import zipfile
from datetime import date
from io import BytesIO

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

BACKEND_DIR = os.path.dirname(os.path.dirname(__file__))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from database import Base
from models import (
    BlockPenaltyResult,
    DailyPenaltySummary,
    GeneratedPenaltyReport,
    Plant,
    VedanjayScheduleUpload,
)
from services.all_plant_penalty_service import (
    CALCULATION_VERSION,
    COMPARISON_CALCULATION_VERSION,
    SourceData,
    active_upload,
    calculate_and_store_daily,
    calculate_daily_penalty,
    comparison_readiness,
    build_report_data,
    configured_plants,
    generate_and_store_report,
    sha256_bytes,
    store_comparison_results,
    store_vedanjay_upload,
)


class FakeSource:
    def __init__(self, schedules=None, meters=None):
        self.schedules = schedules or {}
        self.meters = meters or {}

    def schedule(self, plant_code, schedule_date, source):
        return self.schedules.get((plant_code, schedule_date, source))

    def meter(self, plant_code, schedule_date):
        return self.meters.get((plant_code, schedule_date))


def csv_bytes(value):
    rows = ["block,mw"] + [f"{block},{value}" for block in range(1, 97)]
    return "\n".join(rows).encode("utf-8")


class AllPlantPenaltyServiceTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.db.add(Plant(
            name="SIRMOUR",
            type="Solar",
            capacity=5.1,
            state="Madhya Pradesh",
            status="Active",
        ))
        self.db.commit()
        self.plant = {
            "code": "SIRMOUR",
            "name": "SIRMOUR",
            "state": "Madhya Pradesh",
            "type": "Solar",
            "capacity": 5.1,
        }
        self.day = date(2026, 6, 4)

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def test_calculation_uses_available_blocks_and_never_turns_missing_into_zero(self):
        schedule = {block: 4.0 for block in range(1, 97)}
        meter = {block: 3.0 for block in range(1, 83)}
        result = calculate_daily_penalty(
            schedule=schedule,
            meter=meter,
            capacity_mw=5.1,
            state="Madhya Pradesh",
            plant_type="Solar",
            plant_code="SIRMOUR",
        )
        self.assertEqual(result["status"], "Partially Calculated")
        self.assertEqual(result["calculated_blocks"], 82)
        self.assertIsNotNone(result["total_penalty"])
        self.assertIn("Calculated using 82 of 96 blocks", result["missing_data_reason"])
        self.assertIsNone(result["blocks"][90]["penalty_amount"])

    def test_bamkhal_uses_madhya_pradesh_solar_penalty_bands(self):
        result = calculate_daily_penalty(
            schedule={1: 4.0},
            meter={1: 5.0},
            capacity_mw=5.0,
            state="Telangana",
            plant_type="Wind",
            plant_code="BAMKHAL",
        )
        self.assertEqual(result["status"], "Partially Calculated")
        self.assertAlmostEqual(result["blocks"][0]["deviation_percent"], 20.0)
        self.assertAlmostEqual(result["blocks"][0]["penalty_amount"], 78.125)

    def test_missing_meter_is_pending_with_null_penalty(self):
        upload = store_vedanjay_upload(
            self.db,
            plant=self.plant,
            schedule_date=self.day,
            filename="vedanjay.csv",
            content_type="text/csv",
            content=csv_bytes(4.0),
            uploader="tester",
        )
        summary = calculate_and_store_daily(
            self.db,
            plant=self.plant,
            schedule_date=self.day,
            source="VEDANJAY",
            s3=FakeSource(),
            force=True,
        )
        self.assertEqual(upload.id, summary.upload_id)
        self.assertEqual(summary.status, "Pending")
        self.assertIsNone(summary.total_penalty)
        self.assertEqual(summary.missing_data_reason, "Meter data not available.")

    def test_reupload_keeps_history_and_marks_latest_active(self):
        first = store_vedanjay_upload(
            self.db,
            plant=self.plant,
            schedule_date=self.day,
            filename="first.csv",
            content_type="text/csv",
            content=csv_bytes(3.0),
            uploader="first-user",
        )
        second = store_vedanjay_upload(
            self.db,
            plant=self.plant,
            schedule_date=self.day,
            filename="second.csv",
            content_type="text/csv",
            content=csv_bytes(4.0),
            uploader="second-user",
        )
        self.db.refresh(first)
        rows = self.db.query(VedanjayScheduleUpload).all()
        self.assertEqual(len(rows), 2)
        self.assertFalse(first.is_active)
        self.assertTrue(second.is_active)
        self.assertEqual(active_upload(self.db, "SIRMOUR", self.day).id, second.id)

    def test_cached_result_recalculates_when_meter_hash_changes(self):
        upload = store_vedanjay_upload(
            self.db,
            plant=self.plant,
            schedule_date=self.day,
            filename="vedanjay.csv",
            content_type="text/csv",
            content=csv_bytes(4.0),
            uploader="tester",
        )
        meter_one = csv_bytes(3.0)
        source = FakeSource(meters={
            ("SIRMOUR", self.day): SourceData(
                values={block: 3.0 for block in range(1, 97)},
                file_name="meter-one.csv",
                file_hash=sha256_bytes(meter_one),
            )
        })
        first = calculate_and_store_daily(
            self.db,
            plant=self.plant,
            schedule_date=self.day,
            source="VEDANJAY",
            s3=source,
        )
        first_total = first.total_penalty
        source.meters[("SIRMOUR", self.day)] = SourceData(
            values={block: 4.0 for block in range(1, 97)},
            file_name="meter-two.csv",
            file_hash=sha256_bytes(csv_bytes(4.0)),
        )
        second = calculate_and_store_daily(
            self.db,
            plant=self.plant,
            schedule_date=self.day,
            source="VEDANJAY",
            s3=source,
        )
        self.assertEqual(upload.id, second.upload_id)
        self.assertNotEqual(first_total, second.total_penalty)
        self.assertEqual(second.status, "Zero Penalty")
        self.assertEqual(second.calculation_version, CALCULATION_VERSION)
        self.assertEqual(
            self.db.query(BlockPenaltyResult).filter_by(summary_id=second.id).count(),
            96,
        )

    def test_report_generation_stores_word_and_pdf_in_database(self):
        source_rows = []
        for source in ("SYSTEM", "MANUAL", "ENERCAST", "VEDANJAY", "TESTENV"):
            source_rows.append({
                "source": source,
                "schedule_file": f"{source.lower()}.csv",
                "meter_file": "meter.csv",
                "blocks": [{
                    "block_number": block,
                    "scheduled_mw": 4.0,
                    "actual_meter_mw": 3.5,
                    "deviation_mw": -0.5,
                    "deviation_percent": -9.8,
                    "penalty_amount": float(block),
                } for block in range(1, 97)],
            })
        stored = store_comparison_results(
            self.db,
            plant=self.plant,
            schedule_date=self.day,
            sources=source_rows,
        )
        self.assertEqual(len(stored), 5)
        self.assertTrue(comparison_readiness(
            self.db,
            start_date=self.day,
            end_date=self.day,
        )["ready"])
        report = generate_and_store_report(
            self.db,
            report_type="Daily",
            start_date=self.day,
            end_date=self.day,
            formats=["WORD", "PDF"],
            include_block_details=True,
            requested_by="tester",
            s3=FakeSource(),
        )
        self.assertEqual(report.status, "Ready")
        self.assertTrue(report.word_content.startswith(b"PK"))
        self.assertTrue(report.pdf_content.startswith(b"%PDF"))
        with zipfile.ZipFile(BytesIO(report.word_content)) as archive:
            document_xml = archive.read("word/document.xml").decode("utf-8")
        self.assertIn("High Penalty Blocks", document_xml)
        self.assertIn("Enercast", document_xml)
        self.assertNotIn("Testing", document_xml)
        self.assertTrue(json.loads(report.report_data_json)["include_block_details"])
        observation = json.loads(report.report_data_json)["plants"][0]["daily"][0]["observation"]
        self.assertIn("lowest total penalty", observation)
        self.assertIn("highest block penalty", observation)
        self.assertIn("actual generation was", observation)
        self.assertIn("Block 96", observation)
        self.assertEqual(self.db.query(GeneratedPenaltyReport).count(), 1)
        self.assertEqual(self.db.query(DailyPenaltySummary).count(), 5)
        self.assertTrue(all(
            row.calculation_version == COMPARISON_CALCULATION_VERSION
            for row in self.db.query(DailyPenaltySummary).all()
        ))

    def test_testing_schedule_penalty_is_reported_in_testenv_column(self):
        source_rows = []
        for source, penalty in (("SYSTEM", 1.0), ("MANUAL", 2.0), ("ENERCAST", 3.0), ("VEDANJAY", 4.0), ("TESTENV", 5.0)):
            source_rows.append({
                "source": source,
                "schedule_file": f"{source.lower()}.csv",
                "meter_file": "meter.csv",
                "blocks": [{
                    "block_number": block,
                    "scheduled_mw": 4.0,
                    "actual_meter_mw": 3.5,
                    "deviation_mw": -0.5,
                    "deviation_percent": -9.8,
                    "penalty_amount": penalty,
                } for block in range(1, 97)],
            })

        store_comparison_results(
            self.db,
            plant=self.plant,
            schedule_date=self.day,
            sources=source_rows,
        )
        report_data = build_report_data(
            self.db,
            start_date=self.day,
            end_date=self.day,
            include_block_details=False,
        )
        report_sources = report_data["plants"][0]["daily"][0]["sources"]
        self.assertEqual(report_sources["ENERCAST"]["total_penalty"], 288.0)
        self.assertEqual(report_sources["TESTENV"]["total_penalty"], 480.0)

    def test_report_requires_comparison_load_and_keeps_unavailable_values_blank(self):
        self.assertFalse(comparison_readiness(
            self.db,
            start_date=self.day,
            end_date=self.day,
        )["ready"])
        store_comparison_results(
            self.db,
            plant=self.plant,
            schedule_date=self.day,
            sources=[],
        )
        report = generate_and_store_report(
            self.db,
            report_type="Daily",
            start_date=self.day,
            end_date=self.day,
            formats=["WORD"],
            include_block_details=False,
            requested_by="tester",
        )
        with zipfile.ZipFile(BytesIO(report.word_content)) as archive:
            document_xml = archive.read("word/document.xml").decode("utf-8")
        self.assertNotIn(">Failed<", document_xml)
        self.assertNotIn(">Pending<", document_xml)
        self.assertNotIn(">Missing<", document_xml)
        self.assertNotIn(">Not Calculated<", document_xml)

    def test_report_plant_selection_excludes_unlisted_plants(self):
        self.db.add_all([
            Plant(name="BHUPALPALLY", type="Solar", capacity=10, state="Telangana", status="Active"),
            Plant(name="GSNP", type="Solar", capacity=20, state="Madhya Pradesh", status="Active"),
        ])
        self.db.commit()
        codes = [plant["code"] for plant in configured_plants(self.db)]
        self.assertEqual(codes, ["SIRMOUR", "BHUPALPALLY"])
        self.assertNotIn("GSNP", codes)


if __name__ == "__main__":
    unittest.main()
