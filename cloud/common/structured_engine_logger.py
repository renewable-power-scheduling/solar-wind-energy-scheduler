from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from pathlib import Path


@dataclass
class BlockDetail:
    block: int
    hhmm: str
    generated: bool
    reason_code: str
    trigger_type: str
    threshold: float | None
    dynamic_start_decision: str
    schedule_exists: str
    schedule_source: str | None
    output_file: str | None
    validation_status: str
    reject_reason: str | None
    intraday_rev: str
    intraday_status: str
    day_ahead_status: str
    submission_status: str = "NO"
    slot_used_before: str | None = None
    slot_used_after: str | None = None
    importance: str | None = None
    rejection_category: str | None = None


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
        self._write(f"DATE: {self.log_date.strftime('%Y-%m-%d')} | SITE: {self.site_name}")
        self._write("################################################################################")
        self._write("ENGINE LOG LEGEND")
        self._write("")
        self._write("TRIGGER CODES (generation paths):")
        self._write("- CUSTOM_START: manual/custom run start")
        self._write("- PLANT_STATUS_INITIAL: first run with non-normal plant status")
        self._write("- PLANNED_CONTROL_INITIAL: planned control window trigger")
        self._write("- INTRADAY_INITIAL_TRIGGER: first intraday-triggered creation")
        self._write("- INTRADAY_REVISION_TRIGGER: intraday-triggered regeneration")
        self._write("- PLANT_STATUS_CHANGE: live status/capacity changed")
        self._write("")
        self._write("NON-GENERATION / GUARD CODES:")
        self._write("- INTRADAY_TRIGGER_DUPLICATE: duplicate intraday trigger key")
        self._write("- HIGH_PRIORITY_DEFERRED: high priority deferred to next slot")
        self._write("- NO_TRIGGER: no valid trigger this iteration")
        self._write("")
        self._write("FIELDS:")
        self._write("- GENERATED=YES/NO: schedule file generated in this iteration")
        self._write("- SUBMIT=YES/NO: submission decision for this iteration")
        self._write("- SLOT_USED_BEFORE/SLOT_USED_AFTER: slot-used state before/after iteration")
        self._write("- IMPORTANCE: HIGH/NA")
        self._write("- REJECT_CAUSE: NO_GENERATION_TRIGGER / OTHER")
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

    def append_summary_line(self, block: int, generated: bool, reason: str, rejected: bool, submission_status: str | None = None, slot_used_before: str | None = None, slot_used_after: str | None = None, rejection_category: str | None = None) -> None:
        hhmm = self._block_to_hhmm(block)
        status = "GENERATED" if generated else "NO_CHANGE"
        suffix = " | REJECTED" if rejected else ""
        submit = submission_status or ("YES" if generated and not rejected else "NO")
        before_txt = slot_used_before if slot_used_before is not None else "-"
        after_txt = slot_used_after if slot_used_after is not None else "-"
        rc_txt = rejection_category if rejection_category is not None else "-"
        self._write(f"{block:02d} | {hhmm} | {status} | SUBMIT={submit} | " f"SLOT_USED_BEFORE={before_txt} | SLOT_USED_AFTER={after_txt} | " f"REJECT_CAUSE={rc_txt} | {reason}{suffix}")

    def append_generated_detail(self, d: BlockDetail) -> None:
        self._write("")
        self._write(f"## BLOCK {d.block:02d} | TIME: {d.hhmm} | SCHEDULE GENERATED")
        self._write("")
        self._write("[TRIGGER]")
        self._write(f"Reason Code      : {d.reason_code}")
        self._write(f"Trigger Type     : {d.trigger_type}")
        self._write("")
        self._write("[KEY METRICS]")
        self._write(f"Threshold        : {self._fmt_num(d.threshold)}")
        self._write("")
        self._write("[DECISION TRACE]")
        self._write(f"Initial Trigger  : {d.dynamic_start_decision}")
        self._write(f"Schedule Exists  : {d.schedule_exists}")
        self._write("")
        self._write("[OUTPUT]")
        self._write(f"Schedule Source  : {d.schedule_source or '-'}")
        self._write(f"File             : {d.output_file or '-'}")
        self._write("")
        self._write("[VALIDATION]")
        self._write(f"Status           : {d.validation_status}")
        self._write(f"Submission       : {d.submission_status}")
        if d.slot_used_before is not None:
            self._write(f"Slot Used Before : {d.slot_used_before}")
        if d.slot_used_after is not None:
            self._write(f"Slot Used After  : {d.slot_used_after}")
        if d.importance is not None:
            self._write(f"Importance       : {d.importance}")
        if d.rejection_category is not None:
            self._write(f"Reject Category  : {d.rejection_category}")
        if d.reject_reason:
            self._write(f"Reject Reason    : {d.reject_reason}")
        self._write("")

    def append_no_generation_detail(self, d: BlockDetail) -> None:
        self._write("")
        self._write(f"BLOCK {d.block:02d} | {d.hhmm} | NO GENERATION")
        self._write("")
        self._write("[DATA STATUS]")
        self._write(f"Intraday Rev     : {d.intraday_rev} ({d.intraday_status})")
        self._write(f"Day-Ahead        : {d.day_ahead_status}")
        self._write("")
        self._write("[DECISION]")
        self._write(f"Reason Code      : {d.reason_code}")
        self._write(f"Submission       : {d.submission_status}")
        if d.slot_used_before is not None:
            self._write(f"Slot Used Before : {d.slot_used_before}")
        if d.slot_used_after is not None:
            self._write(f"Slot Used After  : {d.slot_used_after}")
        if d.importance is not None:
            self._write(f"Importance       : {d.importance}")
        if d.rejection_category is not None:
            self._write(f"Reject Category  : {d.rejection_category}")
        self._write("Schedule Status  : Existing schedule continues")
        self._write("")

    @staticmethod
    def _fmt_num(v: float | None) -> str:
        if v is None:
            return "-"
        return f"{float(v):.3f}"
