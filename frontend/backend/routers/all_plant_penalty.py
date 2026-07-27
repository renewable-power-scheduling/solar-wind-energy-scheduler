from __future__ import annotations

import io
import json
from datetime import date, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from database import get_db
from models import DailyPenaltySummary, GeneratedPenaltyReport, VedanjayScheduleUpload
from services.all_plant_penalty_service import (
    SOURCES,
    active_upload,
    calculate_and_store_daily,
    comparison_readiness,
    configured_plants,
    generate_and_store_report,
    normalize_plant_code,
    store_comparison_results,
    store_vedanjay_upload,
    summary_dict,
)


router = APIRouter(prefix="/api/all-plant-penalty", tags=["All Plant Penalty Report"])


class RecalculateRequest(BaseModel):
    plant_code: str
    schedule_date: date
    sources: List[str] = Field(default_factory=lambda: list(SOURCES))


class GenerateReportRequest(BaseModel):
    report_type: str
    start_date: date
    end_date: date
    formats: List[str]
    include_block_details: bool = False
    requested_by: Optional[str] = None
    plant_codes: Optional[List[str]] = None


class ComparisonBlockRequest(BaseModel):
    block_number: int
    scheduled_mw: Optional[float] = None
    actual_meter_mw: Optional[float] = None
    deviation_mw: Optional[float] = None
    deviation_percent: Optional[float] = None
    penalty_amount: Optional[float] = None
    payable_amount: Optional[float] = None
    receivable_amount: Optional[float] = None
    net_settlement: Optional[float] = None
    ppa_amount: Optional[float] = None


class ComparisonSourceRequest(BaseModel):
    source: str
    schedule_file: Optional[str] = None
    meter_file: Optional[str] = None
    blocks: List[ComparisonBlockRequest] = Field(default_factory=list)


class StoreComparisonRequest(BaseModel):
    plant_code: str
    schedule_date: date
    sources: List[ComparisonSourceRequest]


def _find_plant(db: Session, plant_code: str):
    normalized = normalize_plant_code(plant_code)
    plant = next((item for item in configured_plants(db) if item["code"] == normalized), None)
    if not plant:
        raise HTTPException(status_code=404, detail=f"Configured plant not found: {normalized}")
    return plant


def _report_dates(payload: GenerateReportRequest):
    report_type = str(payload.report_type or "").strip().title()
    if report_type not in {"Daily", "Weekly", "Monthly"}:
        raise HTTPException(status_code=400, detail="report_type must be Daily, Weekly, or Monthly")
    start_date = payload.start_date
    end_date = payload.end_date
    if report_type == "Daily":
        end_date = start_date
    elif report_type == "Weekly" and end_date <= start_date:
        end_date = start_date + timedelta(days=6)
    elif report_type == "Monthly" and end_date <= start_date:
        next_month = (start_date.replace(day=28) + timedelta(days=4)).replace(day=1)
        end_date = next_month - timedelta(days=1)
    if end_date < start_date:
        raise HTTPException(status_code=400, detail="end_date must be on or after start_date")
    if (end_date - start_date).days > 366:
        raise HTTPException(status_code=400, detail="Report range cannot exceed 366 days")
    return report_type, start_date, end_date


@router.post("/vedanjay-upload")
async def upload_vedanjay_schedule(
    plant_code: str = Form(...),
    schedule_date: date = Form(...),
    uploader: Optional[str] = Form(None),
    file: UploadFile = File(...),
    x_user_name: Optional[str] = Header(None, alias="X-User-Name"),
    db: Session = Depends(get_db),
):
    plant = _find_plant(db, plant_code)
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")
    if len(content) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Uploaded file exceeds 20 MB")
    try:
        upload = store_vedanjay_upload(
            db,
            plant=plant,
            schedule_date=schedule_date,
            filename=file.filename or "vedanjay-schedule.csv",
            content_type=file.content_type or "application/octet-stream",
            content=content,
            uploader=uploader or x_user_name or "Unknown",
        )
        summary = calculate_and_store_daily(
            db,
            plant=plant,
            schedule_date=schedule_date,
            source="VEDANJAY",
            force=True,
        )
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Vedanjay upload was saved but calculation failed: {exc}") from exc
    return {
        "upload": {
            "id": upload.id,
            "plant_code": upload.plant_code,
            "schedule_date": upload.schedule_date.isoformat(),
            "filename": upload.filename,
            "storage_key": upload.storage_key,
            "uploader": upload.uploader,
            "uploaded_at": upload.uploaded_at,
            "file_hash": upload.file_hash,
            "is_active": upload.is_active,
        },
        "penalty": summary_dict(summary),
    }


@router.get("/daily-result")
def get_daily_result(
    plant_code: str = Query(...),
    schedule_date: date = Query(...),
    source: str = Query("VEDANJAY"),
    db: Session = Depends(get_db),
):
    normalized_source = str(source).upper()
    if normalized_source not in SOURCES:
        raise HTTPException(status_code=400, detail=f"Unsupported source: {source}")
    summary = (
        db.query(DailyPenaltySummary)
        .filter(DailyPenaltySummary.plant_code == normalize_plant_code(plant_code))
        .filter(DailyPenaltySummary.schedule_date == schedule_date)
        .filter(DailyPenaltySummary.schedule_source == normalized_source)
        .first()
    )
    if not summary:
        return None
    return summary_dict(summary)


@router.get("/active-vedanjay-schedule")
def get_active_vedanjay_schedule(
    plant_code: str = Query(...),
    schedule_date: date = Query(...),
    db: Session = Depends(get_db),
):
    upload = active_upload(db, plant_code, schedule_date)
    if not upload:
        return None
    return {
        "upload_id": upload.id,
        "filename": upload.filename,
        "blocks": json.loads(upload.normalized_blocks_json),
    }


@router.post("/comparison-results")
def save_comparison_results(payload: StoreComparisonRequest, db: Session = Depends(get_db)):
    plant = _find_plant(db, payload.plant_code)
    summaries = store_comparison_results(
        db,
        plant=plant,
        schedule_date=payload.schedule_date,
        sources=[item.dict() for item in payload.sources],
    )
    return {"items": [summary_dict(summary) for summary in summaries]}


@router.get("/readiness")
def get_report_readiness(
    start_date: date = Query(...),
    end_date: date = Query(...),
    db: Session = Depends(get_db),
):
    if end_date < start_date:
        raise HTTPException(status_code=400, detail="end_date must be on or after start_date")
    return comparison_readiness(db, start_date=start_date, end_date=end_date)


@router.get("/upload-history")
def get_upload_history(
    plant_code: str = Query(...),
    schedule_date: date = Query(...),
    db: Session = Depends(get_db),
):
    rows = (
        db.query(VedanjayScheduleUpload)
        .filter(VedanjayScheduleUpload.plant_code == normalize_plant_code(plant_code))
        .filter(VedanjayScheduleUpload.schedule_date == schedule_date)
        .order_by(VedanjayScheduleUpload.uploaded_at.desc(), VedanjayScheduleUpload.id.desc())
        .all()
    )
    return {
        "items": [{
            "id": row.id,
            "filename": row.filename,
            "uploader": row.uploader,
            "uploaded_at": row.uploaded_at,
            "file_hash": row.file_hash,
            "is_active": row.is_active,
            "validation_status": row.validation_status,
        } for row in rows]
    }


@router.post("/recalculate")
def recalculate(payload: RecalculateRequest, db: Session = Depends(get_db)):
    plant = _find_plant(db, payload.plant_code)
    results = []
    for source in payload.sources:
        normalized_source = str(source).upper()
        if normalized_source not in SOURCES:
            continue
        try:
            summary = calculate_and_store_daily(
                db,
                plant=plant,
                schedule_date=payload.schedule_date,
                source=normalized_source,
                force=True,
            )
            results.append(summary_dict(summary))
        except Exception as exc:
            results.append({
                "plant_code": plant["code"],
                "schedule_date": payload.schedule_date.isoformat(),
                "schedule_source": normalized_source,
                "status": "Failed",
                "total_penalty": None,
                "missing_data_reason": str(exc),
            })
    return {"items": results}


@router.post("/reports")
def generate_report(payload: GenerateReportRequest, db: Session = Depends(get_db)):
    report_type, start_date, end_date = _report_dates(payload)
    readiness = comparison_readiness(db, start_date=start_date, end_date=end_date)
    requested_codes = [
        normalize_plant_code(code)
        for code in (payload.plant_codes or [])
        if normalize_plant_code(code)
    ]
    requested_codes = list(dict.fromkeys(requested_codes))
    if requested_codes:
        configured_codes = {plant["code"] for plant in configured_plants(db)}
        unknown_codes = [code for code in requested_codes if code not in configured_codes]
        if unknown_codes:
            raise HTTPException(status_code=400, detail=f"Unknown report plant(s): {', '.join(unknown_codes)}")
        loaded = {
            (normalize_plant_code(item.get("plant_code")), item.get("schedule_date"))
            for item in readiness.get("loaded", [])
        }
        missing_subset = [
            {"plant_code": code, "schedule_date": day.isoformat()}
            for code in requested_codes
            for day in (start_date + timedelta(days=offset) for offset in range((end_date - start_date).days + 1))
            if (code, day.isoformat()) not in loaded
        ]
        if missing_subset:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Load Comparison data for the selected report plants and date range before generating the report. "
                    f"{len(requested_codes) * ((end_date - start_date).days + 1) - len(missing_subset)} of "
                    f"{len(requested_codes) * ((end_date - start_date).days + 1)} selected plant-days are loaded."
                ),
            )
    elif not readiness["ready"]:
        raise HTTPException(
            status_code=400,
            detail=(
                "Load Comparison data for every report plant and date before generating the report. "
                f"{readiness['loaded_count']} of {readiness['required_count']} plant-days are loaded."
            ),
        )
    try:
        report = generate_and_store_report(
            db,
            report_type=report_type,
            start_date=start_date,
            end_date=end_date,
            formats=payload.formats,
            include_block_details=payload.include_block_details,
            requested_by=payload.requested_by or "Unknown",
            plant_codes=requested_codes or None,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Report generation failed: {exc}") from exc
    return {
        "id": report.id,
        "status": report.status,
        "report_type": report.report_type,
        "start_date": report.start_date.isoformat(),
        "end_date": report.end_date.isoformat(),
        "downloads": {
            "word": f"/api/all-plant-penalty/reports/{report.id}/download/word" if report.word_content else None,
            "pdf": f"/api/all-plant-penalty/reports/{report.id}/download/pdf" if report.pdf_content else None,
        },
    }


@router.get("/reports")
def report_history(limit: int = Query(20, ge=1, le=100), db: Session = Depends(get_db)):
    rows = (
        db.query(GeneratedPenaltyReport)
        .order_by(GeneratedPenaltyReport.created_at.desc(), GeneratedPenaltyReport.id.desc())
        .limit(limit)
        .all()
    )
    return {"items": [{
        "id": row.id,
        "report_type": row.report_type,
        "start_date": row.start_date.isoformat(),
        "end_date": row.end_date.isoformat(),
        "formats": row.requested_formats,
        "include_block_details": row.include_block_details,
        "status": row.status,
        "requested_by": row.requested_by,
        "created_at": row.created_at,
        "downloads": {
            "word": f"/api/all-plant-penalty/reports/{row.id}/download/word" if row.word_content else None,
            "pdf": f"/api/all-plant-penalty/reports/{row.id}/download/pdf" if row.pdf_content else None,
        },
    } for row in rows]}


@router.get("/reports/{report_id}/download/{file_format}")
def download_report(
    report_id: int,
    file_format: str,
    db: Session = Depends(get_db),
):
    report = db.query(GeneratedPenaltyReport).filter(GeneratedPenaltyReport.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    normalized = str(file_format).lower()
    if normalized == "word" and report.word_content:
        content = report.word_content
        filename = report.word_filename or f"all-plant-penalty-{report.id}.docx"
        media_type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    elif normalized == "pdf" and report.pdf_content:
        content = report.pdf_content
        filename = report.pdf_filename or f"all-plant-penalty-{report.id}.pdf"
        media_type = "application/pdf"
    else:
        raise HTTPException(status_code=404, detail=f"{file_format} report is not available")
    return StreamingResponse(
        io.BytesIO(content),
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
