from __future__ import annotations

import json
import sys
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from cloud.common.site_registry import get_site_entry
from cloud.lambda_sites.anjangoan import fetcher_handler as anjangoan_fetcher_handler
from cloud.lambda_sites.anjangoan import scheduler_handler as anjangoan_scheduler_handler
from cloud.lambda_sites.bhupalpally import fetcher_handler as bhupalpally_fetcher_handler
from cloud.lambda_sites.bhupalpally import scheduler_handler as bhupalpally_scheduler_handler
from cloud.fetcher_core import fetcher_engine
from cloud.scheduler_core import scheduler_entry


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def validate_site_registry() -> None:
    bhp = get_site_entry("BHUPALPALLY")
    anj = get_site_entry("ANJANGOAN")

    _assert(bhp["source_group"] == "global1", "BHUPALPALLY should map to global1")
    _assert(anj["source_group"] == "illios_power", "ANJANGOAN should map to illios_power")
    _assert(bhp["fetcher_lambda_name"] == "BHUPALPALLY-fetcher", "BHUPALPALLY fetcher lambda mismatch")
    _assert(anj["scheduler_lambda_name"] == "ANJANGOAN-scheduler", "ANJANGOAN scheduler lambda mismatch")


def validate_site_wrappers() -> None:
    with patch("cloud.lambda_sites.bhupalpally.fetcher_handler.run", return_value={"ok": True}) as bhp_fetch_run:
        result = bhupalpally_fetcher_handler.lambda_handler({"sample": 1}, None)
        _assert(result == {"ok": True}, "BHUPALPALLY fetcher wrapper should return core result")
        bhp_fetch_run.assert_called_once_with("BHUPALPALLY", {"sample": 1}, None)

    with patch("cloud.lambda_sites.anjangoan.fetcher_handler.run", return_value={"ok": True}) as anj_fetch_run:
        result = anjangoan_fetcher_handler.lambda_handler({"sample": 2}, None)
        _assert(result == {"ok": True}, "ANJANGOAN fetcher wrapper should return core result")
        anj_fetch_run.assert_called_once_with("ANJANGOAN", {"sample": 2}, None)

    with patch("cloud.lambda_sites.bhupalpally.scheduler_handler.run", return_value={"ok": True}) as bhp_sched_run:
        result = bhupalpally_scheduler_handler.lambda_handler({"sample": 3}, None)
        _assert(result == {"ok": True}, "BHUPALPALLY scheduler wrapper should return core result")
        bhp_sched_run.assert_called_once_with("BHUPALPALLY", {"sample": 3}, None)

    with patch("cloud.lambda_sites.anjangoan.scheduler_handler.run", return_value={"ok": True}) as anj_sched_run:
        result = anjangoan_scheduler_handler.lambda_handler({"sample": 4}, None)
        _assert(result == {"ok": True}, "ANJANGOAN scheduler wrapper should return core result")
        anj_sched_run.assert_called_once_with("ANJANGOAN", {"sample": 4}, None)


@contextmanager
def _noop_temp_env(**_kwargs):
    yield


def validate_fetcher_core() -> None:
    fetch_result = {
        "site": "BHUPALPALLY",
        "ok": True,
        "returncode": 0,
        "uploaded_files": 2,
        "uploaded_da_files": 1,
        "uploaded_intraday_files": 1,
        "intraday_reason_label": "intraday schedule r3",
        "stdout_tail": "",
        "stderr_tail": "",
    }

    class FakeFetchResult:
        def __init__(self, payload: dict):
            self.ok = payload["ok"]
            self.payload = payload

        def as_response_dict(self) -> dict:
            return dict(self.payload)

    calls: list[tuple[str, str]] = []

    def fake_run_site_fetch(entry: dict, run_date: str):
        calls.append((entry["site_id"], run_date))
        return FakeFetchResult(fetch_result)

    def fake_trigger_scheduler_refreshes(entry: dict, result):
        _assert(entry["site_id"] == "BHUPALPALLY", "Fetcher core should trigger for BHUPALPALLY")
        _assert(result.ok is True, "Fetcher core should pass fetch result to scheduler refresh")

    with patch.object(fetcher_engine, "temporary_env", _noop_temp_env):
        with patch.object(fetcher_engine, "run_site_fetch", side_effect=fake_run_site_fetch):
            with patch.object(fetcher_engine, "trigger_scheduler_refreshes", side_effect=fake_trigger_scheduler_refreshes):
                response = fetcher_engine.run("BHUPALPALLY", {"run_date": "2026-07-01"}, None)

    body = json.loads(response["body"])
    _assert(response["statusCode"] == 200, "Fetcher core should return 200 for successful site run")
    _assert(body["ok"] is True, "Fetcher core body ok should be true")
    _assert(body["results"][0]["site"] == "BHUPALPALLY", "Fetcher core should emit single-site result")
    _assert(calls == [("BHUPALPALLY", "2026-07-01")], "Fetcher core should run only the bound site")

    anj_result = dict(fetch_result)
    anj_result["site"] = "ANJANGOAN"

    with patch.object(fetcher_engine, "temporary_env", _noop_temp_env):
        with patch.object(fetcher_engine, "run_site_fetch", return_value=FakeFetchResult(anj_result)):
            with patch.object(fetcher_engine, "trigger_scheduler_refreshes", return_value=None):
                response = fetcher_engine.run("ANJANGOAN", {"run_date": "2026-07-01"}, None)

    body = json.loads(response["body"])
    _assert(body["results"][0]["site"] == "ANJANGOAN", "Fetcher core should emit ANJANGOAN pilot result")


def validate_scheduler_core() -> None:
    class FakeHandler:
        def _run_worker(self, payload):
            return {"ok": True, "mode": "worker", "site": payload["site"], "engine_block_ref": payload["engine_block_ref"]}

        def _run_da_refresh(self, payload):
            return {"ok": True, "mode": "da_refresh", "site": payload["site"]}

        def _run_intraday_refresh(self, payload):
            return {"ok": True, "mode": "intraday_refresh", "site": payload["site"]}

    with patch.object(scheduler_entry, "scheduler_runtime", FakeHandler()):
        with patch.object(scheduler_entry, "temporary_env", _noop_temp_env):
            response = scheduler_entry.run("BHUPALPALLY", {"mode": "worker", "site": "BHUPALPALLY", "engine_block_ref": 40}, None)
            body = json.loads(response["body"])
            _assert(response["statusCode"] == 200, "Worker mode should succeed")
            _assert(body["mode"] == "worker", "Worker mode routing mismatch")
            _assert(body["site"] == "BHUPALPALLY", "Worker mode site mismatch")

            response = scheduler_entry.run("ANJANGOAN", {"mode": "intraday_refresh", "site": "ANJANGOAN", "engine_block_ref": 28}, None)
            body = json.loads(response["body"])
            _assert(body["mode"] == "intraday_refresh", "Intraday refresh routing mismatch")
            _assert(body["site"] == "ANJANGOAN", "Intraday refresh site mismatch")

            response = scheduler_entry.run("BHUPALPALLY", {"mode": "da_refresh", "site": "BHUPALPALLY", "engine_block_ref": 40}, None)
            body = json.loads(response["body"])
            _assert(body["mode"] == "da_refresh", "DA refresh routing mismatch")

            response = scheduler_entry.run("ANJANGOAN", {}, None)
            body = json.loads(response["body"])
            _assert(body["mode"] == "worker", "Default scheduler route should be worker")
            _assert(body["site"] == "ANJANGOAN", "Default worker should stay single-site")


def main() -> int:
    validate_site_registry()
    validate_site_wrappers()
    validate_fetcher_core()
    validate_scheduler_core()
    print("pilot migration validation passed for BHUPALPALLY and ANJANGOAN")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
