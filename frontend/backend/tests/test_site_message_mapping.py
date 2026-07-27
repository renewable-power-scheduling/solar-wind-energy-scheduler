import os
import sys
import unittest


BACKEND_DIR = os.path.dirname(os.path.dirname(__file__))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import main


class FakeWindowsTable:
    def __init__(self, items, query_pages=None):
        self.items = items
        self.query_pages = query_pages
        self.update_calls = []

    def query(self, **kwargs):
        if self.query_pages is not None:
            token = kwargs.get("ExclusiveStartKey")
            page_index = int((token or {}).get("page", 0)) if isinstance(token, dict) else 0
            page = self.query_pages[page_index] if page_index < len(self.query_pages) else []
            response = {"Items": list(page)}
            if page_index + 1 < len(self.query_pages):
                response["LastEvaluatedKey"] = {"page": page_index + 1}
            return response
        return {"Items": list(self.items)}

    def scan(self, **kwargs):
        return {"Items": list(self.items)}

    def update_item(self, **kwargs):
        self.update_calls.append(kwargs)
        key = kwargs.get("Key") or {}
        values = kwargs.get("ExpressionAttributeValues") or {}
        for item in self.items:
            if item.get("plant_id") == key.get("plant_id") and item.get("window_id") == key.get("window_id"):
                item["active"] = values.get(":active")
                item["is_open_ended"] = values.get(":open")
                item["end_time"] = values.get(":end")
                item["updated_at"] = values.get(":updated")
                break
        return {}


class SiteMessageMappingTests(unittest.TestCase):
    def test_partial_shutdown_stores_backend_shutdown_dc_fields(self):
        payload = main.SiteMessageRequest(
            site_id="OSEL",
            site_id_raw="OSEL",
            event_date="2026-06-30",
            event_type="partial_shutdown",
            raw_message="OSEL 5 MW DC down tomorrow from 16:00 to 17:00",
            start_time="16:00",
            end_time="17:00",
            mw=5,
            unit="MW",
            reduction_type="DC",
        )

        item = main._build_site_message_window_item(payload)

        self.assertEqual(item["plant_status"], "SHUTDOWN")
        self.assertEqual(item["control_mode"], "DC")
        self.assertEqual(float(item["shutdown_reduction_mw"]), 5.0)
        self.assertNotIn("curtailment_capacity", item)

    def test_curtailment_stores_backend_curtailment_ac_fields(self):
        payload = main.SiteMessageRequest(
            site_id="KASIPET",
            event_date="2026-06-30",
            event_type="curtailment",
            raw_message="KASIPET 5 MW AC down from 16:00 to 17:00",
            start_time="16:00",
            end_time="17:00",
            mw=5,
            unit="MW",
            reduction_type="AC",
        )

        item = main._build_site_message_window_item(payload)

        self.assertEqual(item["plant_status"], "CURTAILMENT")
        self.assertEqual(item["control_mode"], "AC")
        self.assertEqual(float(item["curtailment_capacity"]), 5.0)
        self.assertNotIn("shutdown_reduction_mw", item)

    def test_anjangaon_is_stored_as_backend_alias(self):
        payload = main.SiteMessageRequest(
            site_id="ANJANGAON",
            event_date="2026-06-30",
            event_type="shutdown",
            raw_message="ANJANGAON shutdown from 16:00 to 17:00",
            start_time="16:00",
            end_time="17:00",
        )

        item = main._build_site_message_window_item(payload)

        self.assertEqual(item["site"], "ANJANGOAN")
        self.assertEqual(item["plant_status"], "SHUTDOWN")
        self.assertEqual(item["control_mode"], "FULL")

    def test_duplicate_detects_existing_ui_record(self):
        payload = main.SiteMessageRequest(
            site_id="KASIPET",
            event_date="2026-06-30",
            event_type="curtailment",
            raw_message="KASIPET 5 MW AC down from 16:00 to 17:00",
            start_time="16:00",
            end_time="17:00",
            mw=5,
            unit="MW",
            reduction_type="AC",
        )
        item = main._build_site_message_window_item(payload)
        existing = dict(item)
        existing["window_id"] = "existing-window"

        duplicate = main._site_message_is_duplicate(FakeWindowsTable([existing]), item)

        self.assertIsNotNone(duplicate)
        self.assertEqual(duplicate["window_id"], "existing-window")

    def test_duplicate_detects_existing_whatsapp_shaped_record(self):
        payload = main.SiteMessageRequest(
            site_id="OSEL",
            event_date="2026-06-30",
            event_type="partial_shutdown",
            raw_message="OSEL 5 MW DC down tomorrow from 16:00 to 17:00",
            start_time="16:00",
            end_time="17:00",
            mw=5,
            unit="MW",
            reduction_type="DC",
        )
        item = main._build_site_message_window_item(payload)
        existing = {
            "plant_id": "vedanjay",
            "window_id": "whatsapp-window",
            "site": "OSEL",
            "plant_status": "SHUTDOWN",
            "control_mode": "DC",
            "shutdown_reduction_mw": 5,
            "start_time": item["start_time"],
            "end_time": item["end_time"],
            "last_message": "OSEL 5 MW DC down tomorrow from 16:00 to 17:00",
        }

        duplicate = main._site_message_is_duplicate(FakeWindowsTable([existing]), item)

        self.assertIsNotNone(duplicate)
        self.assertEqual(duplicate["window_id"], "whatsapp-window")

    def test_duplicate_query_paginates_past_first_page(self):
        payload = main.SiteMessageRequest(
            site_id="SIRMOUR",
            event_date="2026-06-30",
            event_type="partial_shutdown",
            raw_message="SIRMOUR 2 MW DC down tomorrow from 11:00 to 13:00",
            start_time="11:00",
            end_time="13:00",
            mw=2,
            unit="MW",
            reduction_type="DC",
        )
        item = main._build_site_message_window_item(payload)
        existing = dict(item)
        existing["window_id"] = "second-page-window"
        other = dict(item)
        other["site"] = "KASIPET"
        other["window_id"] = "first-page-other-site"

        duplicate = main._site_message_is_duplicate(
            FakeWindowsTable([], query_pages=[[other], [existing]]),
            item,
        )

        self.assertIsNotNone(duplicate)
        self.assertEqual(duplicate["window_id"], "second-page-window")

    def test_duplicate_matches_legacy_partial_shutdown_status(self):
        payload = main.SiteMessageRequest(
            site_id="SIRMOUR",
            event_date="2026-06-30",
            event_type="partial_shutdown",
            raw_message="SIRMOUR 2 MW DC down tomorrow from 11:00 to 13:00",
            start_time="11:00",
            end_time="13:00",
            mw=2,
            unit="MW",
            reduction_type="DC",
        )
        item = main._build_site_message_window_item(payload)
        existing = dict(item)
        existing["window_id"] = "legacy-window"
        existing["plant_status"] = "PARTIAL_SHUTDOWN"
        existing.pop("control_mode", None)
        existing.pop("shutdown_reduction_mw", None)
        existing["curtailment_capacity"] = 2

        duplicate = main._site_message_is_duplicate(FakeWindowsTable([existing]), item)

        self.assertIsNotNone(duplicate)
        self.assertEqual(duplicate["window_id"], "legacy-window")

    def test_normal_message_closes_open_site_message_window(self):
        open_window = {
            "plant_id": "vedanjay",
            "window_id": "open-window",
            "site": "SIRMOUR",
            "plant_status": "CURTAILMENT",
            "active": True,
            "is_open_ended": True,
            "start_time": "2026-06-30T10:00:00+05:30",
            "end_time": None,
        }
        table = FakeWindowsTable([open_window])
        normal_item = {
            "site": "SIRMOUR",
            "plant_status": "NORMAL",
            "created_at": "2026-06-30T11:15:00+05:30",
        }

        main._close_site_message_open_windows_for_normal(table, normal_item)

        self.assertEqual(len(table.update_calls), 1)
        self.assertFalse(open_window["active"])
        self.assertFalse(open_window["is_open_ended"])
        self.assertEqual(open_window["end_time"], "2026-06-30T11:15:00+05:30")


if __name__ == "__main__":
    unittest.main()
