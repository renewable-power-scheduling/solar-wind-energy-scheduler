from __future__ import annotations

from cloud.fetcher_core import runtime_global1, runtime_illios


def load_group_fetch_handler(source_group: str):
    if source_group == "global1":
        return runtime_global1
    if source_group == "illios_power":
        return runtime_illios
    raise KeyError(f"Unsupported fetch runtime group: {source_group}")


def load_group_fetchdata(source_group: str):
    handler = load_group_fetch_handler(source_group)
    if hasattr(handler, "_load_fetchdata_module"):
        return handler._load_fetchdata_module()
    raise AttributeError(f"Legacy fetch handler for {source_group} does not expose _load_fetchdata_module()")
