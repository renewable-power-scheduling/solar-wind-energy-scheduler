import os
import sys
import unittest
from unittest.mock import patch


BACKEND_DIR = os.path.dirname(os.path.dirname(__file__))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import main


class FakePlant:
    def __init__(self, name):
        self.name = name


class TemplateTransformGroupScopeTests(unittest.TestCase):
    GROUP_CASES = [
        ("GSNP", 1, "GSNP"),
        ("SIRMOUR", 2, "SIRMOUR"),
        ("CME", 3, "CME"),
        ("SCCL_F_AND_S", 4, "BHUPALPALLY"),
        ("SCCL_F_AND_S", 5, "KASIPET"),
        ("SCCL_F_AND_S", 6, "KOTHAGUDEM"),
        ("ESSEL", 8, "OSEPL"),
        ("ILIOS_PV", 9, "ANJANGAON"),
        ("ILIOS_PV", 10, "BAMKHAL"),
        ("ILIOS_PV", 11, "ANDAD"),
        ("ILIOS_PV", 12, "GUGARIYAKHEDI"),
        ("ILIOS_PV", 13, "BALAKWADA"),
        ("ILIOS_PV", 14, "NANDGAON"),
        ("ZETRIC", 15, "ZETRIC"),
        ("CHANDWASA", 16, "CHANDWASA"),
        ("JEWLI", 17, "JEWLI"),
        ("JGBPL", 18, "JGBPL"),
        ("REWASPRNG", 19, "REWASPRNG"),
        ("ILIOS_PV", 20, "SAWDA"),
        ("ENRICH", 21, "ENRICH"),
        ("SHAHA", 22, "SHAHA"),
    ]

    def test_pipeline_plant_ids_validate_against_dashboard_group_codes(self):
        for group_id, pipeline_plant_id, expected_code in self.GROUP_CASES:
            with self.subTest(group_id=group_id, pipeline_plant_id=pipeline_plant_id):
                scope_code = main._pipeline_plant_scope_code(pipeline_plant_id)
                self.assertEqual(scope_code, expected_code)
                self.assertEqual(
                    main._dashboard_validate_plant(scope_code, group=group_id),
                    expected_code,
                )

    def test_pipeline_plant_ids_are_allowed_for_all_sites(self):
        for pipeline_plant_id in range(1, 23):
            with self.subTest(pipeline_plant_id=pipeline_plant_id):
                scope_code = main._pipeline_plant_scope_code(pipeline_plant_id)
                self.assertEqual(
                    main._dashboard_validate_plant(scope_code, group="ALL_SITES"),
                    scope_code,
                )

    def test_runtime_db_ids_are_resolved_by_name_before_pipeline_id(self):
        configs = main.load_pipeline_configs()
        pipeline_name_by_id = {
            int(plant["plant_id"]): str(plant["name"])
            for plant in configs.get("plants", [])
            if plant.get("plant_id") is not None
        }
        expected_pipeline_ids = [pipeline_id for _, pipeline_id, _ in self.GROUP_CASES]
        for group_id, expected_pipeline_id, expected_code in self.GROUP_CASES:
            runtime_id = next(
                candidate for candidate in expected_pipeline_ids if candidate != expected_pipeline_id
            )
            with patch.object(
                main,
                "get_plant",
                side_effect=lambda _db, plant_id, _runtime_id=runtime_id, _expected_pipeline_id=expected_pipeline_id: (
                    FakePlant(pipeline_name_by_id[_expected_pipeline_id])
                    if plant_id == _runtime_id
                    else None
                ),
            ):
                with self.subTest(group_id=group_id, runtime_id=runtime_id, expected_code=expected_code):
                    resolved_pipeline_id = main._resolve_pipeline_plant_id(runtime_id, object())
                    self.assertEqual(resolved_pipeline_id, expected_pipeline_id)
                    scope_code = main._pipeline_plant_scope_code(resolved_pipeline_id)
                    self.assertEqual(scope_code, expected_code)
                    self.assertEqual(
                        main._dashboard_validate_plant(scope_code, group=group_id),
                        expected_code,
                    )

    def test_runtime_db_id_resolves_sawda_to_its_own_pipeline_mapping(self):
        with patch.object(main, "get_plant", return_value=FakePlant("SAWDA")):
            self.assertEqual(main._resolve_pipeline_plant_id(1, object()), 20)


if __name__ == "__main__":
    unittest.main()
