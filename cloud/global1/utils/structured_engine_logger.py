from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path


@dataclass
class BlockDetail:
    block: int
    hhmm: str
    generated: bool
    reason_code: str
    trigger_type: str
    meter_t: float | None
    meter_t_minus_1: float | None
    meter_t_minus_2: float | None
    threshold: float | None
    dynamic_start_decision: str
    abrupt_weather_decision: str
    schedule_exists: str
    schedule_source: str | None
    output_file: str | None
    validation_status: str
    reject_reason: str | None
    intraday_rev: str
    intraday_status: str
    day_ahead_status: str
    meter_row_status: str
    weather_rt_status: str
    weather_fc_status: str


class StructuredEngineLogger:
    def __init__(self, log_path: Path, site_name: str, log_date: date) -> None:
        self.log_path = log_path
        self.site_name = site_name
        self.log_date = log_date
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self._ensure_date_header()

    def _write(self, text: str) -> None:
        with self.log_path.open("a", encoding="utf-8", newline="\n") as f:
            f.write(text + "\n")

    def _ensure_date_header(self) -> None:
        marker = f"[BLOCK SUMMARY - {self.log_date.strftime('%Y-%m-%d')}]"
        if self.log_path.exists():
            try:
                body = self.log_path.read_text(encoding="utf-8")
                if marker in body:
                    return
            except Exception:
                pass
        self._write("################################################################################")
        self._write(f"📅 DATE: {self.log_date.strftime('%Y-%m-%d')} | SITE: {self.site_name}")
        self._write("################################################################################")
        self._write("")
        self._write(marker)
        self._write("")

    @staticmethod
    def _block_to_hhmm(block: int) -> str:
        idx = max(1, min(96, int(block))) - 1
        mins = idx * 15
        hh = mins // 60
        mm = mins % 60
        return f"{hh:02d}:{mm:02d}"

    def append_summary_line(
        self,
        block: int,
        generated: bool,
        reason: str,
        rejected: bool,
    ) -> None:
        hhmm = self._block_to_hhmm(block)
        status = "✅ GENERATED" if generated else "⏸ NO CHANGE"
        suffix = " | ❌ REJECTED" if rejected else ""
        self._write(f"{block:02d} | {hhmm} | {status} | {reason}{suffix}")

    def append_generated_detail(self, d: BlockDetail) -> None:
        self._write("")
        self._write(f"## 🟢 BLOCK {d.block:02d} | TIME: {d.hhmm} | ✅ SCHEDULE GENERATED")
        self._write("")
        self._write("[TRIGGER]")
        self._write(f"Reason Code      : {d.reason_code}")
        self._write(f"Trigger Type     : {d.trigger_type}")
        self._write("")
        self._write("[KEY METRICS]")
        self._write(f"Meter(T)         : {self._fmt_num(d.meter_t)}")
        self._write(f"Meter(T-1)       : {self._fmt_num(d.meter_t_minus_1)}")
        self._write(f"Meter(T-2)       : {self._fmt_num(d.meter_t_minus_2)}")
        self._write(f"Threshold        : {self._fmt_num(d.threshold)}")
        self._write("")
        self._write("[DECISION TRACE]")
        self._write(f"Dynamic Start    : {d.dynamic_start_decision}")
        self._write(f"Abrupt Weather   : {d.abrupt_weather_decision}")
        self._write(f"Schedule Exists  : {d.schedule_exists}")
        self._write("")
        self._write("[OUTPUT]")
        self._write(f"Schedule Source  : {d.schedule_source or '-'}")
        self._write(f"File             : {d.output_file or '-'}")
        self._write("")
        self._write("[VALIDATION]")
        self._write(f"Status           : {d.validation_status}")
        if d.reject_reason:
            self._write(f"Reject Reason    : {d.reject_reason}")
        self._write("")

    def append_no_generation_detail(self, d: BlockDetail) -> None:
        self._write("")
        self._write(f"BLOCK {d.block:02d} | {d.hhmm} | ⏸ NO GENERATION")
        self._write("")
        self._write(f"Meter(T)         : {self._fmt_num(d.meter_t)}")
        self._write("")
        self._write("[DATA STATUS]")
        self._write(f"Intraday Rev     : {d.intraday_rev} ({d.intraday_status})")
        self._write(f"Day-Ahead        : {d.day_ahead_status}")
        self._write(f"Meter Row        : {d.meter_row_status}")
        self._write(f"Weather RT       : {d.weather_rt_status}")
        self._write(f"Weather Forecast : {d.weather_fc_status}")
        self._write("")
        self._write("[DECISION]")
        self._write(f"Reason Code      : {d.reason_code}")
        self._write("Schedule Status  : Existing schedule continues")
        self._write("")

    @staticmethod
    def _fmt_num(v: float | None) -> str:
        if v is None:
            return "-"
        return f"{float(v):.3f}"
