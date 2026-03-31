"""
FastAPI Backend for QCA Renewable Energy Schedule Management Dashboard
"""
from fastapi import FastAPI, HTTPException, UploadFile, File, Query, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse, StreamingResponse, PlainTextResponse
from sqlalchemy.orm import Session
from sqlalchemy import inspect, text
from typing import Optional, List, Dict, Any
import csv
import io
import json
import math
import random
from datetime import datetime, date, timedelta
import os
import re
import hashlib
from urllib.parse import urlparse, quote
from urllib.request import urlopen
from threading import Lock
from xml.etree import ElementTree

from database import SessionLocal, engine, Base
from models import (
    Plant, Schedule, Forecast, Weather, Deviation, Report, Template, WhatsAppData, MeterData,
    ScheduleReadiness, ScheduleTrigger, ScheduleNotification
)
from schemas import (
    PlantCreate, PlantUpdate, ScheduleCreate, ScheduleUpdate,
    ForecastCreate, WeatherCreate, DeviationCreate, ReportCreate, TemplateCreate,
    WhatsAppDataCreate, WhatsAppDataUpdate, MeterDataCreate, MeterDataUpdate,
    ScheduleReadinessResponse, ScheduleReadinessSummary, ScheduleTriggerResponse,
    ScheduleNotificationResponse, NotificationListResponse, TriggerCheckResult,
    ManualTriggerRequest, ContinueScheduleRequest, MarkReadyRequest,
    TemplateTransformRequest, TemplateTransformPreviewResponse, TemplateTransformGenerateResponse,
    ScheduleReadinessUploadTemplateRequest, ScheduleReadinessUploadTemplateResponse,
    ScheduleOverwriteRequest, ScheduleOverwriteResponse,
    ScheduleChangeLogRequest, ScheduleChangeLogResponse, ScheduleChangeLogEntry
)
from crud import (
    get_plants, get_plant, create_plant, update_plant, delete_plant,
    get_schedules, get_schedule, create_schedule, update_schedule, delete_schedule,
    get_forecasts, get_forecast, create_forecast,
    get_weather_data, create_weather,
    get_deviations, create_deviation,
    get_reports, get_report, create_report, update_report, delete_report,
    get_templates, get_template, create_template, delete_template,
    get_dashboard_stats as fetch_dashboard_stats,
    get_whatsapp_data, get_whatsapp_data_by_id, create_whatsapp_data, update_whatsapp_data, delete_whatsapp_data,
    get_meter_data, get_meter_data_by_id, get_latest_meter_data, create_meter_data, update_meter_data, delete_meter_data,
    get_schedule_readiness, get_schedule_readiness_by_plant, get_schedule_readiness_summary,
    get_schedule_triggers, create_schedule_trigger,
    get_schedule_notifications, get_schedule_notification_by_id, mark_notification_read,
    update_schedule_readiness, create_schedule_readiness
)
from services.template_transform_service import (
    run_preview_pipeline, transform_rows, to_csv_bytes, publish_output_file,
    save_transform_audit_run, query_transform_history, load_pipeline_configs,
    get_active_template, get_template_mappings, get_plant_config,
    fetch_s3_text, parse_to_canonical_rows, validate_canonical_rows, compute_source_hash,
    list_schedule_files_for_date, get_transform_run_by_id, normalize_canonical_blocks,
    format_missing_blocks_summary
)
from services.template_transform_service import SCHEDULE_FILE_PREFIX

app = FastAPI(
    title="QCA Renewable Energy Dashboard API",
    description="Backend API for Renewable Energy Schedule Management",
    version="1.0.0"
)

def _load_seed_plants():
    config_path = os.path.join(
        os.path.dirname(__file__),
        "config",
        "template_pipeline",
        "plants.json"
    )
    try:
        with open(config_path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
            return data if isinstance(data, list) else []
    except Exception as exc:
        print(f"Warning: Could not load plants seed file: {exc}")
        return []

def _ensure_plants_schema():
    try:
        if engine.dialect.name != "postgresql":
            return
        inspector = inspect(engine)
        columns = {col["name"] for col in inspector.get_columns("plants")}
        if "penalty_threshold_percent" not in columns:
            with engine.connect() as conn:
                conn.execute(text("ALTER TABLE plants ADD COLUMN penalty_threshold_percent FLOAT"))
                conn.commit()
            print("Added plants.penalty_threshold_percent column")
    except Exception as exc:
        print(f"Warning: Could not ensure plants schema: {exc}")

@app.on_event("startup")
async def startup_event():
    """Create database tables on startup"""
    try:
        Base.metadata.create_all(bind=engine)
        print("Database tables created/verified successfully")
        _ensure_plants_schema()

        # Ensure default plants required by schedule template conversion are present.
        db = SessionLocal()
        try:
            seed_plants = _load_seed_plants()
            existing = db.query(Plant).all()
            existing_by_key = {
                ((p.name or "").strip().lower(), (p.state or "").strip().lower()): p
                for p in existing
            }
            inserted = 0
            updated = 0
            for item in seed_plants:
                name = (item.get("name") or "").strip()
                state = (item.get("state") or "").strip()
                if not name or not state:
                    continue
                key = (name.lower(), state.lower())
                target = existing_by_key.get(key)
                payload = {
                    "name": name,
                    "type": item.get("type") or "Solar",
                    "capacity": item.get("capacity") if item.get("capacity") is not None else 0.0,
                    "state": state,
                    "status": item.get("status") or "Active",
                    "efficiency": item.get("efficiency") if item.get("efficiency") is not None else 0.0,
                    "penalty_threshold_percent": item.get("penalty_threshold_percent"),
                    "latitude": item.get("latitude"),
                    "longitude": item.get("longitude"),
                    "location_name": item.get("location_name") or item.get("location") or None,
                }
                if not target:
                    db.add(Plant(**payload))
                    inserted += 1
                    continue
                changed = False
                for field, value in payload.items():
                    if value is None:
                        continue
                    if getattr(target, field, None) != value:
                        setattr(target, field, value)
                        changed = True
                if changed:
                    updated += 1
            if inserted or updated:
                db.commit()
                print(f"Seeded plants (inserted={inserted}, updated={updated})")
        finally:
            db.close()
    except Exception as e:
        print(f"Warning: Could not create database tables: {e}")
        print("Tables may already exist or database may not be ready yet")

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:80", "http://localhost", "http://frontend:80", "http://127.0.0.1:80", "http://127.0.0.1"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allow_headers=["*"],
    expose_headers=["*"],
)

# Dependency to get DB session
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ==================== ROOT ENDPOINTS ====================
@app.get("/api")
@app.get("/api/")
async def api_root():
    """API root endpoint - returns API information"""
    return {
        "name": "QCA Renewable Energy Dashboard API",
        "version": "1.0.0",
        "status": "running",
        "endpoints": {
            "dashboard": "/api/dashboard/stats",
            "plants": "/api/plants",
            "schedules": "/api/schedules",
            "forecasts": "/api/forecasts",
            "weather": "/api/weather",
            "deviations": "/api/deviations",
            "reports": "/api/reports",
            "templates": "/api/templates",
            "template_transform": "/api/template-transform/preview",
            "template_transform_source_files": "/api/template-transform/source-files",
            "template_transform_download": "/api/template-transform/download/{run_id}"
        }
    }


# ==================== DASHBOARD ENDPOINTS ====================
@app.get("/api/dashboard/stats")
async def get_dashboard_stats_endpoint(db: Session = Depends(get_db)):
    """Get dashboard statistics"""
    try:
        stats = fetch_dashboard_stats(db)
        return stats
    except Exception as e:
        import traceback
        traceback.print_exc()
        # Return a safe fallback instead of crashing
        return {
            "activePlants": 0,
            "totalCapacity": 0,
            "currentGeneration": 0,
            "efficiency": 0,
            "windCapacity": 0,
            "solarCapacity": 0,
            "schedules": {
                "total": 0,
                "pending": 0,
                "approved": 0,
                "revised": 0
            }
        }


@app.get("/api/dashboard/recent-activity")
async def get_recent_activity(
    limit: int = Query(5, ge=1, le=50),
    db: Session = Depends(get_db)
):
    """Get recent schedule activity"""
    try:
        schedules = get_schedules(db, limit=limit)
        return schedules
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==================== PLANTS ENDPOINTS ====================
@app.get("/api/plants")
async def list_plants(
    search: Optional[str] = None,
    type: Optional[str] = None,
    state: Optional[str] = None,
    status: Optional[str] = None,
    db: Session = Depends(get_db)
):
    """List all plants with optional filtering"""
    try:
        filters = {}
        if search:
            filters['search'] = search
        if type and type != 'all' and type != 'All Types':
            filters['type'] = type
        if state and state != 'all' and state != 'All States':
            filters['state'] = state
        if status and status != 'all' and status != 'All':
            filters['status'] = status
        
        plants = get_plants(db, **filters)
        # Return as list directly (FastAPI will serialize)
        return plants
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/plants/{plant_id}")
async def get_plant_by_id(plant_id: int, db: Session = Depends(get_db)):
    """Get a specific plant by ID"""
    try:
        plant = get_plant(db, plant_id)
        if not plant:
            raise HTTPException(status_code=404, detail="Plant not found")
        return plant
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/plants")
async def create_new_plant(plant: PlantCreate, db: Session = Depends(get_db)):
    """Create a new plant"""
    try:
        return create_plant(db, plant)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.put("/api/plants/{plant_id}")
async def update_plant_by_id(
    plant_id: int,
    plant: PlantUpdate,
    db: Session = Depends(get_db)
):
    """Update an existing plant"""
    try:
        updated_plant = update_plant(db, plant_id, plant)
        if not updated_plant:
            raise HTTPException(status_code=404, detail="Plant not found")
        return updated_plant
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/api/plants/{plant_id}")
async def delete_plant_by_id(plant_id: int, db: Session = Depends(get_db)):
    """Delete a plant"""
    try:
        success = delete_plant(db, plant_id)
        if not success:
            raise HTTPException(status_code=404, detail="Plant not found")
        return {"message": "Plant deleted successfully"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==================== SCHEDULES ENDPOINTS ====================
@app.get("/api/schedules")
async def list_schedules(
    type: Optional[str] = None,
    status: Optional[str] = None,
    plant: Optional[str] = None,
    startDate: Optional[str] = None,
    endDate: Optional[str] = None,
    limit: int = Query(10, ge=1, le=100),  # Allow limit from 1 to 100
    db: Session = Depends(get_db)
):
    """List all schedules with optional filtering"""
    try:
        filters = {}
        if type and type != 'all' and type != 'All':
            filters['type'] = type
        if status and status != 'all' and status != 'All':
            filters['status'] = status
        if plant and plant != 'all' and plant != 'All Plants' and plant != 'Select Plant':
            filters['plant'] = plant
        if startDate:
            filters['startDate'] = startDate
        if endDate:
            filters['endDate'] = endDate
        
        # Apply limit to schedules
        schedules = get_schedules(db, limit=limit, **filters)
        return schedules
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error fetching schedules: {str(e)}")


@app.get("/api/schedules/{schedule_id}")
async def get_schedule_by_id(schedule_id: int, db: Session = Depends(get_db)):
    """Get a specific schedule by ID"""
    try:
        schedule = get_schedule(db, schedule_id)
        if not schedule:
            raise HTTPException(status_code=404, detail="Schedule not found")
        return schedule
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/schedules")
async def create_new_schedule(
    schedule: ScheduleCreate,
    db: Session = Depends(get_db)
):
    """Create a new schedule"""
    try:
        return create_schedule(db, schedule)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.put("/api/schedules/{schedule_id}")
async def update_schedule_by_id(
    schedule_id: int,
    schedule: ScheduleUpdate,
    db: Session = Depends(get_db)
):
    """Update an existing schedule"""
    try:
        updated_schedule = update_schedule(db, schedule_id, schedule)
        if not updated_schedule:
            raise HTTPException(status_code=404, detail="Schedule not found")
        return updated_schedule
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/api/schedules/{schedule_id}")
async def delete_schedule_by_id(
    schedule_id: int,
    db: Session = Depends(get_db)
):
    """Delete a schedule"""
    try:
        success = delete_schedule(db, schedule_id)
        if not success:
            raise HTTPException(status_code=404, detail="Schedule not found")
        return {"message": "Schedule deleted successfully"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/schedules/bulk-upload")
async def bulk_upload_schedules(
    file: UploadFile = File(...),
    db: Session = Depends(get_db)
):
    """Upload and import schedules from CSV file"""
    try:
        if not file.filename.endswith('.csv'):
            raise HTTPException(status_code=400, detail="Only CSV files are supported")
        
        content = await file.read()
        csv_content = content.decode('utf-8')
        csv_reader = csv.DictReader(io.StringIO(csv_content))
        
        imported = 0
        failed = 0
        errors = []
        
        for row in csv_reader:
            try:
                # Parse scheduleDate - handle multiple formats
                schedule_date_str = row.get('scheduleDate', str(date.today()))
                try:
                    # Try ISO format first (YYYY-MM-DD)
                    if isinstance(schedule_date_str, str):
                        schedule_date = datetime.strptime(schedule_date_str, "%Y-%m-%d").date()
                    else:
                        schedule_date = date.today()
                except ValueError:
                    try:
                        # Try DD-MM-YYYY format
                        schedule_date = datetime.strptime(schedule_date_str, "%d-%m-%Y").date()
                    except ValueError:
                        # Default to today if parsing fails
                        schedule_date = date.today()
                
                schedule_data = ScheduleCreate(
                    plantName=row.get('plantName', ''),
                    type=row.get('type', 'Day-Ahead'),
                    scheduleDate=schedule_date,
                    capacity=float(row.get('capacity', 0)),
                    forecasted=float(row.get('forecasted', 0)),
                    actual=float(row.get('actual', 0)),
                    status=row.get('status', 'Pending')
                )
                create_schedule(db, schedule_data)
                imported += 1
            except Exception as e:
                failed += 1
                errors.append(f"Row {imported + failed}: {str(e)}")
        
        return {
            "success": True,
            "imported": imported,
            "failed": failed,
            "errors": errors[:10]  # Limit errors to first 10
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/schedules/upload-96-blocks")
async def upload_schedule_96_blocks(
    file: UploadFile = File(...),
    plant_name: str = Query(...),
    schedule_type: str = Query("Day-Ahead"),
    schedule_date: str = Query(..., description="Date in YYYY-MM-DD format"),
    db: Session = Depends(get_db)
):
    """Upload schedule data with 96 time blocks (15-min intervals) from CSV file"""
    try:
        if not file.filename.endswith('.csv'):
            raise HTTPException(status_code=400, detail="Only CSV files are supported")
        
        content = await file.read()
        csv_content = content.decode('utf-8')
        csv_reader = csv.DictReader(io.StringIO(csv_content))
        
        rows = list(csv_reader)
        
        if len(rows) == 0:
            raise HTTPException(status_code=400, detail="CSV file is empty")
        
        # Parse date
        try:
            parsed_date = datetime.strptime(schedule_date, "%Y-%m-%d").date()
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD")
        
        # Parse block data from CSV
        block_data = {}
        total_forecasted = 0
        total_actual = 0
        total_scheduled = 0
        valid_blocks = 0
        
        for idx, row in enumerate(rows):
            try:
                # Get block number (default to row index + 1)
                block_num = int(row.get('block', idx + 1))
                
                # Get time (default to calculated time)
                time_str = row.get('time', '')
                if not time_str:
                    time_str = f"{(idx * 15) // 60:02d}:{(idx * 15) % 60:02d}"
                
                # Parse values
                forecasted = float(row.get('forecasted', row.get('forecast', 0))) or 0
                actual = float(row.get('actual', 0)) or 0
                scheduled = float(row.get('scheduled', forecasted)) or forecasted
                
                block_key = f"block_{block_num}"
                block_data[block_key] = {
                    "block": block_num,
                    "time": time_str,
                    "forecasted": forecasted,
                    "actual": actual,
                    "scheduled": scheduled
                }
                
                total_forecasted += forecasted
                total_actual += actual
                total_scheduled += scheduled
                valid_blocks += 1
                
            except Exception as e:
                print(f"Warning: Could not parse row {idx}: {str(e)}")
                continue
        
        if valid_blocks == 0:
            raise HTTPException(status_code=400, detail="Could not parse any valid blocks from CSV")
        
        # Calculate capacity (average of scheduled values)
        capacity = total_scheduled / valid_blocks if valid_blocks > 0 else 0
        
        # Calculate deviation
        deviation = ((total_actual - total_forecasted) / total_forecasted * 100) if total_forecasted > 0 else 0
        
        # Create schedule with block data
        schedule_create = ScheduleCreate(
            plantName=plant_name,
            type=schedule_type,
            scheduleDate=parsed_date,
            capacity=round(capacity, 2),
            forecasted=round(total_forecasted, 2),
            actual=round(total_actual, 2),
            status="Pending",
            deviation=round(deviation, 2),
            blockData=block_data
        )
        
        created_schedule = create_schedule(db, schedule_create)
        
        return {
            "success": True,
            "message": f"Schedule uploaded successfully with {valid_blocks} time blocks",
            "scheduleId": created_schedule.id,
            "plantName": plant_name,
            "scheduleDate": str(parsed_date),
            "type": schedule_type,
            "totalBlocks": valid_blocks,
            "totalForecasted": round(total_forecasted, 2),
            "totalActual": round(total_actual, 2),
            "deviation": round(deviation, 2)
        }
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/schedules/overwrite-latest", response_model=ScheduleOverwriteResponse)
async def overwrite_latest_schedule(
    request: ScheduleOverwriteRequest,
):
    """Overwrite latest schedule CSV in S3 (Option B)."""
    try:
        source_key = str(request.source_file_key or "").strip()
        if not source_key:
            raise HTTPException(status_code=400, detail="source_file_key is required")
        if not re.search(r"schedule_from_\d+\.csv$", source_key, re.IGNORECASE):
            raise HTTPException(status_code=400, detail="source_file_key must be schedule_from_XX.csv")

        csv_text = str(request.csv_text or "")
        if not csv_text.strip():
            raise HTTPException(status_code=400, detail="csv_text is required")

        bucket = _derive_s3_bucket_name()
        if not bucket:
            raise HTTPException(status_code=500, detail="S3 bucket not configured")

        region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or "ap-south-1"
        output_file_key = source_key
        output_file_url = f"https://{bucket}.s3.{region}.amazonaws.com/{output_file_key}"
        uploaded_at = datetime.utcnow()

        try:
            import boto3  # type: ignore
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"boto3 not available: {e}")

        s3 = boto3.client("s3", region_name=region)
        s3.put_object(
            Bucket=bucket,
            Key=output_file_key,
            Body=csv_text.encode("utf-8"),
            ContentType="text/csv",
        )

        return {
            "success": True,
            "message": "Latest schedule overwritten successfully",
            "bucket": bucket,
            "output_file_key": output_file_key,
            "output_file_url": output_file_url,
            "uploaded_at": uploaded_at,
            "error": None,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/schedules/change-log", response_model=ScheduleChangeLogResponse)
async def append_schedule_change_log(
    request: ScheduleChangeLogRequest,
):
    """Append a manual change log entry for a schedule (shared across users)."""
    try:
        plant_code = str(request.plant_code or "").strip().upper()
        if not plant_code:
            raise HTTPException(status_code=400, detail="plant_code is required")
        if plant_code in {"SHRIMOUR", "SHROMOUR"}:
            plant_code = "SIRMOUR"

        schedule_date = request.schedule_date
        source_key = str(request.source_file_key or "").strip()
        saved_at = request.saved_at or datetime.utcnow()

        entry = {
            "block": int(request.block),
            "time": str(request.time or "").strip(),
            "old_value": str(request.old_value),
            "new_value": str(request.new_value),
            "saved_at": saved_at.isoformat(),
            "source_file_key": source_key,
        }

        bucket = _derive_s3_bucket_name()
        region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or "ap-south-1"
        key = f"generated/vedanjay/{plant_code}/outputs/{schedule_date}/schedule_changes.json"
        output_file_url = f"https://{bucket}.s3.{region}.amazonaws.com/{key}" if bucket else ""

        with _CHANGE_LOG_LOCK:
            rows = []
            if bucket:
                try:
                    import boto3  # type: ignore
                    s3 = boto3.client("s3", region_name=region)
                    try:
                        obj = s3.get_object(Bucket=bucket, Key=key)
                        text = obj["Body"].read().decode("utf-8")
                        rows = json.loads(text) if text else []
                    except Exception:
                        rows = []
                    if not isinstance(rows, list):
                        rows = []
                    rows.append(entry)
                    s3.put_object(
                        Bucket=bucket,
                        Key=key,
                        Body=json.dumps(rows, ensure_ascii=False, indent=2).encode("utf-8"),
                        ContentType="application/json",
                    )
                except Exception:
                    bucket = ""

            if not bucket:
                local_path = os.path.join(
                    CHANGE_LOG_LOCAL_DIR, plant_code, str(schedule_date), "schedule_changes.json"
                )
                rows = _load_change_log_local(local_path)
                if not isinstance(rows, list):
                    rows = []
                rows.append(entry)
                _save_change_log_local(local_path, rows)

        return {
            "success": True,
            "message": "Change log updated",
            "bucket": bucket or "LOCAL_FALLBACK",
            "output_file_key": key,
            "output_file_url": output_file_url,
            "uploaded_at": saved_at,
            "error": None,
            "items": rows,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/schedules/change-log", response_model=ScheduleChangeLogResponse)
async def get_schedule_change_log(
    plant_code: str = Query(...),
    schedule_date: date = Query(...),
):
    """Fetch schedule change log entries."""
    try:
        plant_code = str(plant_code or "").strip().upper()
        if plant_code in {"SHRIMOUR", "SHROMOUR"}:
            plant_code = "SIRMOUR"

        bucket = _derive_s3_bucket_name()
        region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or "ap-south-1"
        key = f"generated/vedanjay/{plant_code}/outputs/{schedule_date}/schedule_changes.json"
        output_file_url = f"https://{bucket}.s3.{region}.amazonaws.com/{key}" if bucket else ""
        rows = []

        if bucket:
            try:
                import boto3  # type: ignore
                s3 = boto3.client("s3", region_name=region)
                obj = s3.get_object(Bucket=bucket, Key=key)
                text = obj["Body"].read().decode("utf-8")
                rows = json.loads(text) if text else []
            except Exception:
                rows = []

        if not rows:
            local_path = os.path.join(
                CHANGE_LOG_LOCAL_DIR, plant_code, str(schedule_date), "schedule_changes.json"
            )
            rows = _load_change_log_local(local_path)

        if not isinstance(rows, list):
            rows = []

        return {
            "success": True,
            "message": "Change log loaded",
            "bucket": bucket or "LOCAL_FALLBACK",
            "output_file_key": key,
            "output_file_url": output_file_url,
            "uploaded_at": datetime.utcnow(),
            "error": None,
            "items": rows,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/schedules/{schedule_id}/blocks")
async def get_schedule_blocks(
    schedule_id: int,
    db: Session = Depends(get_db)
):
    """Get schedule with 96-block data"""
    try:
        from crud import get_schedule_with_blocks
        schedule = get_schedule_with_blocks(db, schedule_id)
        if not schedule:
            raise HTTPException(status_code=404, detail="Schedule not found")
        return schedule
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==================== FORECASTS ENDPOINTS ====================
@app.get("/api/forecasts")
async def list_forecasts(
    plantId: Optional[int] = None,
    db: Session = Depends(get_db)
):
    """List all forecasts"""
    try:
        filters = {}
        if plantId:
            filters['plantId'] = plantId
        forecasts = get_forecasts(db, **filters)
        return forecasts
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/forecasts/{plant_id}")
async def get_forecast_by_plant(plant_id: int, db: Session = Depends(get_db)):
    """Get forecast for a specific plant"""
    try:
        forecast = get_forecast(db, plant_id)
        if not forecast:
            raise HTTPException(status_code=404, detail="Forecast not found")
        return forecast
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/forecasts")
async def create_forecast_data(forecast: ForecastCreate, db: Session = Depends(get_db)):
    """Create a new forecast"""
    try:
        return create_forecast(db, forecast)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/forecasts/{plant_id}/data")
async def get_forecast_data_for_plant(
    plant_id: int,
    date: str = Query(..., description="Date in YYYY-MM-DD format"),
    db: Session = Depends(get_db)
):
    """Get forecast data for a specific plant and date (96 time blocks)"""
    try:
        # Try to get real forecast data first
        forecast = get_forecast(db, plant_id)
        if forecast:
            # Parse the hourlyData and return in expected format
            hourly_data = forecast.hourlyData
            if isinstance(hourly_data, str):
                hourly_data = json.loads(hourly_data)

            # Convert to dataPoints format
            data_points = []
            for hour in range(24):
                hour_data = hourly_data.get(str(hour), {}) if isinstance(hourly_data, dict) else {}
                for quarter in range(4):
                    minute = quarter * 15
                    time_str = f"{hour:02d}:{minute:02d}"

                    data_points.append({
                        "time": time_str,
                        "hour": hour,
                        "minute": minute,
                        "forecast": hour_data.get("forecast", 0),
                        "actual": hour_data.get("actual", 0),
                        "scheduled": hour_data.get("scheduled", 0)
                    })

            return {
                "date": forecast.forecastDate.isoformat() if forecast.forecastDate else date,
                "dataPoints": data_points,
                "totalForecast": sum(d["forecast"] for d in data_points),
                "totalActual": sum(d["actual"] for d in data_points),
                "createdAt": forecast.createdAt.isoformat() if forecast.createdAt else datetime.now().isoformat()
            }

        raise HTTPException(status_code=404, detail="Forecast data not found")

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==================== WEATHER ENDPOINTS ====================
@app.get("/api/weather")
async def list_weather_data(db: Session = Depends(get_db)):
    """List all weather data"""
    try:
        weather = get_weather_data(db)
        return weather
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/weather/{location}")
async def get_weather_by_location(location: str, db: Session = Depends(get_db)):
    """Get weather data for a specific location"""
    try:
        weather = get_weather_data(db, location=location)
        if not weather:
            raise HTTPException(status_code=404, detail="Weather data not found")
        return weather
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==================== DEVIATIONS ENDPOINTS ====================
@app.get("/api/deviations")
async def list_deviations(
    period: str = Query("hourly", regex="^(hourly|daily|weekly)$"),
    limit: int = Query(24, ge=1, le=1000),
    db: Session = Depends(get_db)
):
    """List deviations with period filtering"""
    try:
        deviations = get_deviations(db, period=period, limit=limit)
        return deviations
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==================== REPORTS ENDPOINTS ====================
@app.get("/api/reports")
async def list_reports(
    type: Optional[str] = None,
    state: Optional[str] = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
    db: Session = Depends(get_db)
):
    """List all reports with optional filtering"""
    try:
        reports = get_reports(db, skip=skip, limit=limit, type=type, state=state)
        return reports
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/reports/generate")
async def generate_report(report: ReportCreate, db: Session = Depends(get_db)):
    """Track a new report in the database (PDF is generated client-side)"""
    try:
        # Validate required fields
        if not report.name or not report.name.strip():
            raise HTTPException(status_code=400, detail="Report name is required")
        if not report.type or not report.type.strip():
            raise HTTPException(status_code=400, detail="Report type is required")
        if not report.format or not report.format.strip():
            raise HTTPException(status_code=400, detail="Report format is required")
        
        # Create the report record (no PDF generation on server)
        created_report = create_report(db, report)
        
        # Report is tracked, client handles PDF generation
        # Update status to Ready since no file generation is needed
        update_report(db, created_report.id, status="Ready")
        
        # Refresh to get updated values
        db.refresh(created_report)
        
        return created_report
        
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=400, detail=f"Error tracking report: {str(e)}")


@app.get("/api/reports/{report_id}/download")
async def download_report(report_id: int, db: Session = Depends(get_db)):
    """Download a report PDF
    
    Note: Since PDF files are generated client-side, this endpoint
    returns an error message indicating the report file is not available
    on the server. The client should generate the PDF locally.
    """
    try:
        report = get_report(db, report_id)
        if not report:
            raise HTTPException(status_code=404, detail="Report not found")
        
        # Check if PDF file exists on server
        if report.filePath and os.path.exists(report.filePath):
            # Update status to Ready if it was Generating
            if report.status == "Generating":
                update_report(db, report_id, status="Ready")
            
            # Return the actual PDF file
            return FileResponse(
                path=report.filePath,
                filename=f"{report.name.replace(' ', '_')}.pdf",
                media_type="application/pdf"
            )
        
        # No file exists on server - client-side PDF generation is expected
        raise HTTPException(
            status_code=410, 
            detail="Report file not available on server. Please generate the PDF using the report interface."
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/reports/{report_id}")
async def delete_report_by_id(report_id: int, db: Session = Depends(get_db)):
    """Delete a report"""
    try:
        success = delete_report(db, report_id)
        if not success:
            raise HTTPException(status_code=404, detail="Report not found")
        # Return proper success response format
        return {"success": True, "message": "Report deleted successfully", "id": report_id}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/reports/cleanup/generating")
async def cleanup_generating_reports(db: Session = Depends(get_db)):
    """Remove all reports with 'Generating' status from database"""
    try:
        from sqlalchemy import text
        # Delete reports with "Generating" status
        result = db.execute(
            text("DELETE FROM reports WHERE status = 'Generating'")
        )
        db.commit()
        deleted_count = result.rowcount
        return {
            "success": True, 
            "message": f"Cleaned up {deleted_count} report(s) with 'Generating' status"
        }
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


# ==================== TEMPLATES ENDPOINTS ====================
@app.get("/api/templates")
async def list_templates(
    vendor: Optional[str] = None,
    type: Optional[str] = None,
    db: Session = Depends(get_db)
):
    """List all templates with optional filtering"""
    try:
        filters = {}
        if vendor and vendor != 'all':
            filters['vendor'] = vendor
        if type and type != 'all':
            filters['type'] = type
        templates = get_templates(db, **filters)
        return templates
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/templates")
async def create_new_template(
    template: TemplateCreate,
    db: Session = Depends(get_db)
):
    """Create a new template"""
    try:
        return create_template(db, template)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/api/templates/{template_id}")
async def delete_template_by_id(
    template_id: int,
    db: Session = Depends(get_db)
):
    """Delete a template"""
    try:
        success = delete_template(db, template_id)
        if not success:
            raise HTTPException(status_code=404, detail="Template not found")
        return {"message": "Template deleted successfully"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==================== FILE UPLOAD ENDPOINT ====================
@app.post("/api/upload")
async def upload_file(
    file: UploadFile = File(...),
    vendor: Optional[str] = None,
    type: Optional[str] = None
):
    """Upload a file"""
    try:
        # Create uploads directory if it doesn't exist
        os.makedirs("uploads", exist_ok=True)
        
        # Save file
        file_path = f"uploads/{datetime.now().timestamp()}-{file.filename}"
        with open(file_path, "wb") as buffer:
            content = await file.read()
            buffer.write(content)
        
        return {
            "message": "File uploaded successfully",
            "filename": file.filename,
            "size": len(content),
            "path": file_path
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# ==================== EXPORT ENDPOINTS ====================
@app.get("/api/export/schedules")
async def export_schedules(
    format: str = Query("csv", regex="^(csv|json)$"),
    db: Session = Depends(get_db)
):
    """Export schedules in CSV or JSON format"""
    try:
        schedules = get_schedules(db)
        
        if format == "csv":
            output = io.StringIO()
            if schedules:
                # Convert SQLAlchemy models to dicts
                schedule_dicts = [{
                    "id": s.id,
                    "plantName": s.plantName,
                    "type": s.type,
                    "scheduleDate": str(s.scheduleDate),
                    "capacity": s.capacity,
                    "forecasted": s.forecasted,
                    "actual": s.actual,
                    "status": s.status,
                    "deviation": s.deviation
                } for s in schedules]
                
                if schedule_dicts:
                    writer = csv.DictWriter(output, fieldnames=schedule_dicts[0].keys())
                    writer.writeheader()
                    writer.writerows(schedule_dicts)
            
            return StreamingResponse(
                io.BytesIO(output.getvalue().encode('utf-8')),
                media_type="text/csv",
                headers={"Content-Disposition": "attachment; filename=schedules.csv"}
            )
        else:  # JSON
            schedule_dicts = [{
                "id": s.id,
                "plantName": s.plantName,
                "type": s.type,
                "scheduleDate": str(s.scheduleDate),
                "capacity": s.capacity,
                "forecasted": s.forecasted,
                "actual": s.actual,
                "status": s.status,
                "deviation": s.deviation
            } for s in schedules]
            
            return JSONResponse(
                content=schedule_dicts,
                headers={"Content-Disposition": "attachment; filename=schedules.json"}
            )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/export/plants")
async def export_plants(
    format: str = Query("csv", regex="^(csv|json)$"),
    db: Session = Depends(get_db)
):
    """Export plants in CSV or JSON format"""
    try:
        plants = get_plants(db)
        
        if format == "csv":
            output = io.StringIO()
            if plants:
                # Convert SQLAlchemy models to dicts
                plant_dicts = [{
                    "id": p.id,
                    "name": p.name,
                    "type": p.type,
                    "capacity": p.capacity,
                    "state": p.state,
                    "status": p.status,
                    "efficiency": p.efficiency,
                    "penalty_threshold_percent": p.penalty_threshold_percent,
                    "lastUpdated": str(p.lastUpdated) if p.lastUpdated else ""
                } for p in plants]
                
                if plant_dicts:
                    writer = csv.DictWriter(output, fieldnames=plant_dicts[0].keys())
                    writer.writeheader()
                    writer.writerows(plant_dicts)
            
            return StreamingResponse(
                io.BytesIO(output.getvalue().encode('utf-8')),
                media_type="text/csv",
                headers={"Content-Disposition": "attachment; filename=plants.csv"}
            )
        else:  # JSON
            plant_dicts = [{
                "id": p.id,
                "name": p.name,
                "type": p.type,
                "capacity": p.capacity,
                "state": p.state,
                "status": p.status,
                "efficiency": p.efficiency,
                "penalty_threshold_percent": p.penalty_threshold_percent,
                "lastUpdated": str(p.lastUpdated) if p.lastUpdated else ""
            } for p in plants]
            
            return JSONResponse(
                content=plant_dicts,
                headers={"Content-Disposition": "attachment; filename=plants.json"}
            )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/export/deviations")
async def export_deviations(
    format: str = Query("csv", regex="^(csv|json)$"),
    db: Session = Depends(get_db)
):
    """Export deviations in CSV or JSON format"""
    try:
        deviations = get_deviations(db, period="hourly", limit=1000)
        
        if format == "csv":
            output = io.StringIO()
            if deviations:
                # deviations is already a list of dicts from get_deviations
                if deviations and isinstance(deviations[0], dict):
                    writer = csv.DictWriter(output, fieldnames=deviations[0].keys())
                    writer.writeheader()
                    writer.writerows(deviations)
            
            return StreamingResponse(
                io.BytesIO(output.getvalue().encode('utf-8')),
                media_type="text/csv",
                headers={"Content-Disposition": "attachment; filename=deviations.csv"}
            )
        else:  # JSON
            return JSONResponse(
                content=deviations,
                headers={"Content-Disposition": "attachment; filename=deviations.json"}
            )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==================== WHATSAPP DATA ENDPOINTS ====================
@app.get("/api/whatsapp-data")
async def list_whatsapp_data(
    plant_id: Optional[int] = Query(None),
    date: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
    db: Session = Depends(get_db)
):
    """Get all WhatsApp data entries"""
    try:
        # Parse date with error handling - frontend sends YYYY-MM-DD
        parsed_date = None
        if date:
            try:
                # Try multiple date formats
                try:
                    parsed_date = datetime.strptime(date, "%Y-%m-%d").date()
                except ValueError:
                    try:
                        parsed_date = datetime.strptime(date, "%d-%m-%Y").date()
                    except ValueError:
                        try:
                            parsed_date = datetime.strptime(date, "%d/%m/%Y").date()
                        except ValueError:
                            pass  # Keep parsed_date as None if all formats fail
            except Exception:
                pass  # Keep parsed_date as None on any error
        
        whatsapp_data = get_whatsapp_data(db, skip=skip, limit=limit, plant_id=plant_id, date=parsed_date, status=status)
        # Return in format expected by frontend: { data: [...], total: X }
        return {"data": whatsapp_data, "total": len(whatsapp_data)}
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/whatsapp-instant")
async def get_whatsapp_instant_data(
    plant_id: Optional[str] = Query(None, min_length=1),
    since: Optional[str] = Query(None)
):
    """Get latest WhatsApp instant data from DynamoDB (single plant or updates feed)."""
    try:
        table = _get_dynamodb_table("WHATSAPP_INSTANT_TABLE")

        if plant_id:
            item = _find_ddb_item_by_plant_id(table, plant_id)
            if not item:
                return {"data": None}

            message = str(
                item.get("last_message")
                or item.get("lastMessage")
                or item.get("message")
                or ""
            )
            parsed = _parse_whatsapp_message(message)
            if "curtailmentCapacity" not in parsed:
                capacity = item.get("curtailment_capacity")
                if capacity is not None:
                    parsed["curtailmentCapacity"] = capacity
            if "curtailmentStatus" not in parsed:
                status_value = str(item.get("plant_status") or item.get("status") or "").strip().lower()
                if status_value:
                    parsed["curtailmentStatus"] = status_value == "curtailment"
            if "remarks" not in parsed and message:
                parsed["remarks"] = message
            return {
                "plantId": item.get("plant_id") or plant_id,
                "message": message,
                "status": item.get("plant_status") or item.get("status"),
                "updatedAt": item.get("updated_at") or item.get("updatedAt"),
                "parsed": parsed
            }

        if since:
            since_ms = _parse_ddb_timestamp(since) or 0
            results = []
            last_evaluated_key = None
            pages = 0
            while pages < 5:
                kwargs = {}
                if last_evaluated_key:
                    kwargs["ExclusiveStartKey"] = last_evaluated_key
                response = table.scan(**kwargs)
                raw_items = response.get("Items") or []
                for raw in raw_items:
                    item = _normalize_ddb_item(raw)
                    payload = _whatsapp_item_to_payload(item)
                    ts = payload.get("timestamp_ms") or 0
                    if ts > since_ms:
                        results.append(payload)
                last_evaluated_key = response.get("LastEvaluatedKey")
                pages += 1
                if not last_evaluated_key:
                    break
            results.sort(key=lambda r: r.get("timestamp_ms") or 0)
            return results

        return {"data": None}
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/whatsapp-data/{whatsapp_id}")
async def get_whatsapp_data_by_id_endpoint(
    whatsapp_id: int,
    db: Session = Depends(get_db)
):
    """Get a single WhatsApp data entry"""
    try:
        whatsapp_data = get_whatsapp_data_by_id(db, whatsapp_id)
        if not whatsapp_data:
            raise HTTPException(status_code=404, detail="WhatsApp data not found")
        return whatsapp_data
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/whatsapp-data")
async def create_whatsapp_data_endpoint(
    whatsapp_data: WhatsAppDataCreate,
    db: Session = Depends(get_db)
):
    """Create a new WhatsApp data entry"""
    try:
        created = create_whatsapp_data(db, whatsapp_data)
        # Return the created record in a format the frontend expects
        return {
            "id": created.id,
            "plantId": created.plantId,
            "plantName": created.plantName,
            "state": created.state,
            "date": created.date,
            "time": created.time,
            "currentGeneration": created.currentGeneration,
            "expectedTrend": created.expectedTrend,
            "curtailmentStatus": created.curtailmentStatus,
            "curtailmentReason": created.curtailmentReason,
            "weatherCondition": created.weatherCondition,
            "inverterAvailability": created.inverterAvailability,
            "remarks": created.remarks,
            "status": created.status,
            "createdAt": created.createdAt.isoformat() if created.createdAt else datetime.now().isoformat()
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.put("/api/whatsapp-data/{whatsapp_id}")
async def update_whatsapp_data_endpoint(
    whatsapp_id: int,
    whatsapp_data: WhatsAppDataUpdate,
    db: Session = Depends(get_db)
):
    """Update a WhatsApp data entry"""
    try:
        updated = update_whatsapp_data(db, whatsapp_id, whatsapp_data)
        if not updated:
            raise HTTPException(status_code=404, detail="WhatsApp data not found")
        return updated
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/api/whatsapp-data/{whatsapp_id}")
async def delete_whatsapp_data_endpoint(
    whatsapp_id: int,
    db: Session = Depends(get_db)
):
    """Delete a WhatsApp data entry"""
    try:
        success = delete_whatsapp_data(db, whatsapp_id)
        if not success:
            raise HTTPException(status_code=404, detail="WhatsApp data not found")
        return {"message": "WhatsApp data deleted successfully"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==================== METER DATA ENDPOINTS ====================
@app.get("/api/meter-data")
async def list_meter_data(
    plant_id: Optional[int] = Query(None),
    data_date: Optional[str] = Query(None),
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
    db: Session = Depends(get_db)
):
    """Get all meter data entries"""
    try:
        parsed_date = datetime.strptime(data_date, "%Y-%m-%d").date() if data_date else None
        meter_data = get_meter_data(db, skip=skip, limit=limit, plant_id=plant_id, data_date=parsed_date)
        # Parse blockData JSON string back to dict for response
        result = []
        for md in meter_data:
            md_dict = {
                "id": md.id,
                "plantId": md.plantId,
                "plantName": md.plantName,
                "dataDate": md.dataDate,
                "blockData": json.loads(md.blockData) if isinstance(md.blockData, str) else md.blockData,
                "source": md.source,
                "lastReading": md.lastReading,
                "dataPoints": md.dataPoints,
                "delay": md.delay,
                "createdAt": md.createdAt,
                "updatedAt": md.updatedAt
            }
            result.append(md_dict)
        return {"data": result, "total": len(result)}
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/meter-data/{meter_id}")
async def get_meter_data_by_id_endpoint(
    meter_id: int,
    db: Session = Depends(get_db)
):
    """Get a single meter data entry"""
    try:
        meter_data = get_meter_data_by_id(db, meter_id)
        if not meter_data:
            raise HTTPException(status_code=404, detail="Meter data not found")
        # Parse blockData JSON string back to dict
        result = {
            "id": meter_data.id,
            "plantId": meter_data.plantId,
            "plantName": meter_data.plantName,
            "dataDate": meter_data.dataDate,
            "blockData": json.loads(meter_data.blockData) if isinstance(meter_data.blockData, str) else meter_data.blockData,
            "source": meter_data.source,
            "lastReading": meter_data.lastReading,
            "dataPoints": meter_data.dataPoints,
            "delay": meter_data.delay,
            "createdAt": meter_data.createdAt,
            "updatedAt": meter_data.updatedAt
        }
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/meter-data/plant/{plant_id}/latest")
async def get_latest_meter_data_endpoint(
    plant_id: int,
    db: Session = Depends(get_db)
):
    """Get the latest meter data for a plant"""
    try:
        meter_data = get_latest_meter_data(db, plant_id)
        if not meter_data:
            raise HTTPException(status_code=404, detail="Meter data not found")
        # Parse blockData JSON string back to dict
        result = {
            "id": meter_data.id,
            "plantId": meter_data.plantId,
            "plantName": meter_data.plantName,
            "dataDate": meter_data.dataDate,
            "blockData": json.loads(meter_data.blockData) if isinstance(meter_data.blockData, str) else meter_data.blockData,
            "source": meter_data.source,
            "lastReading": meter_data.lastReading,
            "dataPoints": meter_data.dataPoints,
            "delay": meter_data.delay,
            "createdAt": meter_data.createdAt,
            "updatedAt": meter_data.updatedAt
        }
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/meter-data")
async def create_meter_data_endpoint(
    meter_data: MeterDataCreate,
    db: Session = Depends(get_db)
):
    """Create a new meter data entry"""
    try:
        return create_meter_data(db, meter_data)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/meter-data/upload-csv")
async def upload_meter_data_csv(
    file: UploadFile = File(...),
    plant_id: int = Query(...),
    plant_name: str = Query(...),
    data_date: str = Query(...),
    db: Session = Depends(get_db)
):
    """Upload meter data from CSV file"""
    try:
        # Parse date
        parsed_date = datetime.strptime(data_date, "%Y-%m-%d").date()
        
        # Read CSV file
        contents = await file.read()
        csv_content = contents.decode('utf-8')
        csv_reader = csv.DictReader(io.StringIO(csv_content))
        
        # Parse CSV and create block data
        block_data = {}
        rows = list(csv_reader)
        
        # Expected CSV format: Time Block, Generation (MW), etc.
        for idx, row in enumerate(rows):
            # Try to find time or block number
            time_key = None
            gen_key = None
            
            for key in row.keys():
                key_lower = key.lower()
                if 'time' in key_lower or 'block' in key_lower or 'blk' in key_lower:
                    time_key = key
                if 'generation' in key_lower or 'mw' in key_lower or 'actual' in key_lower:
                    gen_key = key
            
            if time_key and gen_key:
                block_num = idx + 1
                time_str = row[time_key].strip()
                gen_value = float(row[gen_key]) if row[gen_key] else 0.0
                block_data[f"block_{block_num}"] = {
                    "block": block_num,
                    "time": time_str,
                    "generation": gen_value
                }
            elif gen_key:
                # If no time key, use index
                block_num = idx + 1
                gen_value = float(row[gen_key]) if row[gen_key] else 0.0
                block_data[f"block_{block_num}"] = {
                    "block": block_num,
                    "time": f"{(block_num-1)*15:02d}:00",
                    "generation": gen_value
                }
        
        # Create meter data entry
        meter_data_create = MeterDataCreate(
            plantId=plant_id,
            plantName=plant_name,
            dataDate=parsed_date,
            blockData=block_data,
            source="Manual Upload",
            dataPoints=len(block_data),
            lastReading=datetime.now()
        )
        
        created = create_meter_data(db, meter_data_create)
        return {
            "message": "Meter data uploaded successfully",
            "data": {
                "id": created.id,
                "dataPoints": created.dataPoints,
                "blocks": len(block_data)
            }
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid date format or CSV structure: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/api/meter-data/{meter_id}")
async def update_meter_data_endpoint(
    meter_id: int,
    meter_data: MeterDataUpdate,
    db: Session = Depends(get_db)
):
    """Update a meter data entry"""
    try:
        updated = update_meter_data(db, meter_id, meter_data)
        if not updated:
            raise HTTPException(status_code=404, detail="Meter data not found")
        return updated
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/api/meter-data/{meter_id}")
async def delete_meter_data_endpoint(
    meter_id: int,
    db: Session = Depends(get_db)
):
    """Delete a meter data entry"""
    try:
        success = delete_meter_data(db, meter_id)
        if not success:
            raise HTTPException(status_code=404, detail="Meter data not found")
        return {"message": "Meter data deleted successfully"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/meter-data/plant/{plant_id}/data")
async def get_meter_data_points_for_plant(
    plant_id: int,
    date: str = Query(..., description="Date in YYYY-MM-DD format"),
    db: Session = Depends(get_db)
):
    """Get meter data points for a specific plant and date (96 time blocks)"""
    try:
        # Try to get real meter data first
        meter_data = get_latest_meter_data(db, plant_id)
        if meter_data:
            # Parse the blockData and return in expected format
            block_data = meter_data.blockData
            if isinstance(block_data, str):
                block_data = json.loads(block_data)

            # Convert to dataPoints format
            data_points = []
            for block_key, block_info in block_data.items():
                if isinstance(block_info, dict):
                    time_parts = block_info.get("time", "00:00").split(":")
                    hour = int(time_parts[0]) if len(time_parts) > 0 else 0
                    minute = int(time_parts[1]) if len(time_parts) > 1 else 0

                    data_points.append({
                        "time": block_info.get("time", "00:00"),
                        "hour": hour,
                        "minute": minute,
                        "generation": block_info.get("generation", 0),
                        "availableCapacity": block_info.get("availableCapacity", 95),
                        "availability": block_info.get("availability", 95)
                    })

            return {
                "date": meter_data.dataDate.isoformat() if meter_data.dataDate else date,
                "dataPoints": data_points,
                "totalGeneration": sum(d["generation"] for d in data_points),
                "lastReading": meter_data.lastReading.isoformat() if meter_data.lastReading else datetime.now().isoformat(),
                "source": meter_data.source or "SCADA",
                "status": "Live"
            }

        raise HTTPException(status_code=404, detail="Meter data not found")

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==================== HEALTH CHECK ====================
@app.get("/api/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "ok", "message": "Server is running"}


@app.get("/")
async def root():
    """Root endpoint with API information"""
    return {
        "message": "Renewable Energy Dashboard API",
        "version": "1.0.0",
        "endpoints": {
            "dashboard": "/api/dashboard/stats",
            "plants": "/api/plants",
            "schedules": "/api/schedules",
            "forecasts": "/api/forecasts",
            "weather": "/api/weather",
            "deviations": "/api/deviations",
            "reports": "/api/reports",
            "templates": "/api/templates",
            "template_transform": "/api/template-transform/preview",
            "template_transform_source_files": "/api/template-transform/source-files",
            "template_transform_download": "/api/template-transform/download/{run_id}",
            "whatsapp-data": "/api/whatsapp-data",
            "meter-data": "/api/meter-data",
            "health": "/api/health"
        }
    }




# ==================== SCHEDULE READINESS ENDPOINTS ====================
@app.get("/api/schedule-readiness")
async def list_schedule_readiness(
    status: Optional[str] = Query(None, description="Filter by status: READY, PENDING, NO_ACTION"),
    db: Session = Depends(get_db)
):
    """List all site schedule readiness statuses with summary"""
    try:
        summary = get_schedule_readiness_summary(db)
        return summary
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/schedule-readiness/summary")
async def get_schedule_readiness_summary_endpoint(
    db: Session = Depends(get_db)
):
    """Get quick summary of all plant readiness statuses"""
    try:
        summary = get_schedule_readiness_summary(db)
        return {
            "total": summary["total_plants"],
            "ready": summary["ready_count"],
            "pending": summary["pending_count"],
            "no_action": summary["no_action_count"]
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==================== SCHEDULE NOTIFICATIONS ENDPOINTS ====================
@app.get("/api/schedule-readiness/notifications")
async def get_notifications(
    unread_only: bool = Query(False, description="Show only unread notifications"),
    plant_id: Optional[int] = Query(None, description="Filter by plant ID"),
    limit: int = Query(50, ge=1, le=100),
    db: Session = Depends(get_db)
):
    """Get pending notifications"""
    try:
        notifications = get_schedule_notifications(db, plant_id=plant_id, unread_only=unread_only, limit=limit)
        unread_count = sum(1 for n in notifications if not n.read)

        return {
            "notifications": notifications,
            "total": len(notifications),
            "unread_count": unread_count
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/api/schedule-readiness/notifications/{notification_id}/read")
async def mark_notification_read_endpoint(
    notification_id: int,
    db: Session = Depends(get_db)
):
    """Mark a notification as read"""
    try:
        notification = mark_notification_read(db, notification_id)
        if not notification:
            raise HTTPException(status_code=404, detail="Notification not found")
        return {
            "success": True,
            "message": "Notification marked as read",
            "notification_id": notification_id
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==================== SCHEDULE TRIGGERS ENDPOINTS ====================
@app.get("/api/schedule-readiness/triggers")
async def get_schedule_triggers_endpoint(
    plant_id: Optional[int] = Query(None),
    trigger_type: Optional[str] = Query(None),
    processed: Optional[bool] = Query(None),
    limit: int = Query(50, ge=1, le=100),
    db: Session = Depends(get_db)
):
    """Get schedule trigger records"""
    try:
        triggers = get_schedule_triggers(db, plant_id=plant_id, trigger_type=trigger_type, processed=processed, limit=limit)
        return {"triggers": triggers, "total": len(triggers)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/schedule-readiness/{plant_id:int}")
async def get_plant_readiness(
    plant_id: int,
    db: Session = Depends(get_db)
):
    """Get specific plant's schedule readiness status"""
    try:
        readiness = get_schedule_readiness_by_plant(db, plant_id)
        if not readiness:
            # Get plant info to create readiness record
            plant = get_plant(db, plant_id)
            if not plant:
                raise HTTPException(status_code=404, detail="Plant not found")
            # Create new readiness record
            readiness_data = {
                "plant_id": plant_id,
                "plant_name": plant.name,
                "status": "NO_ACTION",
                "schedule_date": date.today()
            }
            readiness = create_schedule_readiness(db, readiness_data)
        return readiness
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/schedule-readiness/{plant_id:int}/trigger")
async def trigger_schedule_revision(
    plant_id: int,
    reason: str = Query(..., description="Reason for revision"),
    db: Session = Depends(get_db)
):
    """Manually trigger schedule revision for a plant"""
    try:
        # Check plant exists
        plant = get_plant(db, plant_id)
        if not plant:
            raise HTTPException(status_code=404, detail="Plant not found")
        
        # Use schedule service to trigger
        from services.schedule_service import ScheduleReadinessService
        service = ScheduleReadinessService(db)
        readiness = service.trigger_manual_revision(plant_id, reason)
        
        return {
            "success": True,
            "message": f"Schedule revision triggered for {plant.name}",
            "plant_id": plant_id,
            "status": readiness.status,
            "trigger_reason": reason
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/schedule-readiness/{plant_id:int}/continue")
async def continue_existing_schedule(
    plant_id: int,
    db: Session = Depends(get_db)
):
    """Continue with existing (day-ahead) schedule - clears triggers"""
    try:
        # Check plant exists
        plant = get_plant(db, plant_id)
        if not plant:
            raise HTTPException(status_code=404, detail="Plant not found")
        
        # Use schedule service to continue
        from services.schedule_service import ScheduleReadinessService
        service = ScheduleReadinessService(db)
        readiness = service.continue_existing_schedule(plant_id)
        
        return {
            "success": True,
            "message": f"Continuing existing schedule for {plant.name}",
            "plant_id": plant_id,
            "status": readiness.status if readiness else "NO_ACTION"
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/schedule-readiness/{plant_id:int}/mark-ready")
async def mark_schedule_ready(
    plant_id: int,
    upload_deadline: Optional[str] = Query(None, description="Upload deadline in ISO format"),
    db: Session = Depends(get_db)
):
    """Mark schedule as ready for upload"""
    try:
        # Check plant exists
        plant = get_plant(db, plant_id)
        if not plant:
            raise HTTPException(status_code=404, detail="Plant not found")
        
        # Parse deadline if provided
        deadline = None
        if upload_deadline:
            try:
                deadline = datetime.fromisoformat(upload_deadline)
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid date format. Use ISO format")
        
        # Use schedule service to mark ready
        from services.schedule_service import ScheduleReadinessService
        service = ScheduleReadinessService(db)
        readiness = service.mark_schedule_ready(plant_id, deadline)
        
        return {
            "success": True,
            "message": f"Schedule marked as ready for {plant.name}",
            "plant_id": plant_id,
            "status": readiness.status,
            "upload_deadline": readiness.upload_deadline.isoformat() if readiness.upload_deadline else None
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/schedule-readiness/check-triggers")
async def check_triggers_and_update_statuses(
    db: Session = Depends(get_db)
):
    """Run trigger check algorithm for all plants"""
    try:
        from services.schedule_service import ScheduleReadinessService
        service = ScheduleReadinessService(db)
        status_counts = service.check_all_plants()
        
        return {
            "success": True,
            "message": "Trigger check completed for all plants",
            "plants_checked": status_counts['READY'] + status_counts['PENDING'] + status_counts['NO_ACTION'],
            "ready_count": status_counts['READY'],
            "pending_count": status_counts['PENDING'],
            "no_action_count": status_counts['NO_ACTION']
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==================== TEMPLATE TRANSFORM PIPELINE ENDPOINTS ====================
DEFAULT_TEMPLATE_S3_BASE_URL = os.getenv(
    "TEMPLATE_PIPELINE_S3_BASE_URL",
    "https://vedanjay-solar-prod-989625237479.s3.ap-south-1.amazonaws.com"
)
DEFAULT_TEMPLATE_S3_PREFIXES = os.getenv(
    "TEMPLATE_PIPELINE_S3_PREFIXES",
    "generated/vedanjay/BHUPALPALLY/outputs,generated/vedanjay/CME/outputs,generated/vedanjay/GSNP/outputs,generated/vedanjay/KASIPET/outputs,generated/vedanjay/KILAJ/outputs,generated/vedanjay/KOTHAGUDEM/outputs,generated/vedanjay/OSEPL/outputs,generated/vedanjay/SIRMOUR/outputs,raw/vedanjay/BHUPALPALLY,raw/vedanjay/CME,raw/vedanjay/GSNP,raw/vedanjay/KASIPET,raw/vedanjay/KILAJ,raw/vedanjay/KOTHAGUDEM,raw/vedanjay/OSEPL,raw/vedanjay/SIRMOUR,raw/GSNP/gsnp,generated/GSNP/gsnp/outputs,raw/Sirmour/sirmour,generated/Sirmour/sirmour/outputs,outputs"
)

DEFAULT_READINESS_UPLOAD_PREFIX = os.getenv(
    "READINESS_UPLOAD_PREFIX",
    "uploads/vedanjay"
).strip().strip("/")

READINESS_UPLOAD_LOCAL_DIR = os.path.join(os.path.dirname(__file__), "uploads", "readiness")
READINESS_UPLOAD_HISTORY_FILE = os.path.join(READINESS_UPLOAD_LOCAL_DIR, "upload_history.json")
_READINESS_UPLOAD_HISTORY_LOCK = Lock()

CHANGE_LOG_LOCAL_DIR = os.path.join(os.path.dirname(__file__), "uploads", "schedule_changes")
_CHANGE_LOG_LOCK = Lock()


def _ensure_change_log_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def _load_change_log_local(path: str) -> list:
    _ensure_change_log_dir(os.path.dirname(path))
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _save_change_log_local(path: str, rows: list) -> None:
    _ensure_change_log_dir(os.path.dirname(path))
    with open(path, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2, default=str)


def _ensure_readiness_upload_dirs() -> None:
    os.makedirs(READINESS_UPLOAD_LOCAL_DIR, exist_ok=True)


def _load_readiness_upload_history() -> list:
    _ensure_readiness_upload_dirs()
    if not os.path.exists(READINESS_UPLOAD_HISTORY_FILE):
        return []
    try:
        with open(READINESS_UPLOAD_HISTORY_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _save_readiness_upload_history(rows: list) -> None:
    _ensure_readiness_upload_dirs()
    with open(READINESS_UPLOAD_HISTORY_FILE, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2, default=str)


def _append_readiness_upload_history(entry: dict) -> None:
    with _READINESS_UPLOAD_HISTORY_LOCK:
        rows = _load_readiness_upload_history()
        rows.append(entry)
        _save_readiness_upload_history(rows)


def _extract_upload_path_parts_from_key(key: str) -> Optional[Dict[str, str]]:
    """
    Parse uploads key pattern:
    uploads/vedanjay/{plant_code}/{YYYY-MM-DD}/{file_name}
    """
    text = str(key or "").strip()
    if not text:
        return None
    normalized = text.replace("\\", "/")
    parts = [p for p in normalized.split("/") if p]
    if len(parts) < 5:
        return None
    if parts[0].lower() != "uploads" or parts[1].lower() != "vedanjay":
        return None
    plant_code = str(parts[2]).upper()
    schedule_date = str(parts[3]).strip()
    file_name = parts[-1]
    if not plant_code or not re.fullmatch(r"[A-Z0-9_-]{1,32}", plant_code):
        return None
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", schedule_date):
        return None
    return {
        "plant_code": plant_code,
        "schedule_date": schedule_date,
        "template_file_name": file_name,
    }


def _list_s3_upload_objects_safe(
    *,
    s3_client: Any,
    bucket: str,
    prefix: str,
) -> List[Dict[str, str]]:
    objects: List[Dict[str, str]] = []

    if s3_client is not None and bucket:
        continuation = None
        while True:
            payload: Dict[str, Any] = {"Bucket": bucket, "Prefix": prefix}
            if continuation:
                payload["ContinuationToken"] = continuation
            try:
                response = s3_client.list_objects_v2(**payload)
            except Exception:
                break

            for item in response.get("Contents", []) or []:
                key = str(item.get("Key", "")).strip()
                if not key:
                    continue
                last_modified = item.get("LastModified")
                last_modified_text = ""
                try:
                    if last_modified is not None:
                        last_modified_text = last_modified.isoformat()
                except Exception:
                    last_modified_text = ""
                objects.append({"key": key, "last_modified": last_modified_text})

            if response.get("IsTruncated"):
                continuation = response.get("NextContinuationToken")
                if not continuation:
                    break
            else:
                break

        return objects

    # Public/listable bucket fallback via XML listing endpoint.
    try:
        url = f"{DEFAULT_TEMPLATE_S3_BASE_URL.rstrip('/')}/?list-type=2&prefix={quote(prefix)}"
        with urlopen(url, timeout=20) as resp:
            xml = resp.read().decode("utf-8", errors="replace")
        root = ElementTree.fromstring(xml)
        for node in root.findall(".//{*}Contents"):
            key = node.findtext("{*}Key", default="")
            last_modified = node.findtext("{*}LastModified", default="")
            if key:
                objects.append({"key": key, "last_modified": last_modified})
    except Exception:
        return []

    return objects


def _load_s3_upload_history_rows(
    *,
    schedule_date: Optional[date],
    plant_code: Optional[str],
    limit: int,
) -> List[Dict[str, Any]]:
    bucket = _derive_s3_bucket_name()
    region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or "ap-south-1"
    s3 = None
    try:
        import boto3  # type: ignore
        if bucket:
            s3 = boto3.client("s3", region_name=region)
    except Exception:
        s3 = None

    date_values: List[str] = []
    if schedule_date is not None:
        date_values = [schedule_date.isoformat()]
    else:
        # Keep breadth bounded for endpoint performance.
        today_utc = datetime.utcnow().date()
        date_values = [(today_utc - timedelta(days=i)).isoformat() for i in range(0, 14)]

    plant_values: List[str] = []
    if plant_code:
        plant_values = [str(plant_code).strip().upper()]
    else:
        plant_values = ["GSNP", "SIRMOUR"]

    discovered: List[Dict[str, Any]] = []
    for p in plant_values:
        for d in date_values:
            prefix = f"{DEFAULT_READINESS_UPLOAD_PREFIX}/{p}/{d}/"
            for obj in _list_s3_upload_objects_safe(s3_client=s3, bucket=bucket, prefix=prefix):
                key = str(obj.get("key", "")).strip()
                if not key.lower().endswith(".csv"):
                    continue
                parsed = _extract_upload_path_parts_from_key(key)
                if not parsed:
                    continue
                discovered.append(
                    {
                        "id": int(datetime.utcnow().timestamp() * 1000),
                        "plant_code": parsed["plant_code"],
                        "schedule_date": parsed["schedule_date"],
                        "template_file_name": parsed["template_file_name"],
                        "source_file_key": "",
                        "requested_by": "",
                        "bucket": bucket or "UNKNOWN",
                        "output_file_key": key,
                        "output_file_url": f"https://{bucket}.s3.{region}.amazonaws.com/{key}" if bucket else "",
                        "uploaded_at": str(obj.get("last_modified", "")).strip(),
                        "storage_mode": "s3_discovered",
                        "error": None,
                        "csv_text": "",
                    }
                )

    discovered = sorted(
        discovered,
        key=lambda r: str(r.get("uploaded_at", "")),
        reverse=True,
    )
    return discovered[: max(1, int(limit))]


def _derive_s3_bucket_name() -> str:
    explicit_bucket = os.getenv("READINESS_UPLOAD_BUCKET", "").strip() or os.getenv("TEMPLATE_OUTPUT_BUCKET", "").strip()
    if explicit_bucket:
        return explicit_bucket
    parsed = urlparse(DEFAULT_TEMPLATE_S3_BASE_URL)
    host = parsed.netloc or ""
    if host:
        return host.split(".")[0]
    return ""


def _get_dynamodb_table(table_env_key: str) -> Any:
    table_name = os.getenv(table_env_key, "").strip()
    if not table_name and table_env_key == "WHATSAPP_INSTANT_TABLE":
        table_name = os.getenv("DDB_WHATSAPP_TABLE", "").strip()
    if not table_name:
        raise RuntimeError(f"{table_env_key} is not configured")
    region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or "ap-south-1"
    try:
        import boto3  # type: ignore
    except Exception as exc:
        raise RuntimeError(f"boto3 not available: {exc}") from exc
    dynamodb = boto3.resource("dynamodb", region_name=region)
    return dynamodb.Table(table_name)


def _unwrap_ddb_value(value: Any) -> Any:
    if not isinstance(value, dict) or len(value) != 1:
        return value
    if "S" in value:
        return value["S"]
    if "N" in value:
        try:
            return int(value["N"])
        except Exception:
            try:
                return float(value["N"])
            except Exception:
                return value["N"]
    if "BOOL" in value:
        return bool(value["BOOL"])
    if "M" in value:
        return {k: _unwrap_ddb_value(v) for k, v in value["M"].items()}
    if "L" in value:
        return [_unwrap_ddb_value(v) for v in value["L"]]
    return value


def _normalize_ddb_item(item: Any) -> Dict[str, Any]:
    if not isinstance(item, dict):
        return {}
    return {k: _unwrap_ddb_value(v) for k, v in item.items()}

def _parse_ddb_timestamp(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).strip()
    if not text:
        return None
    if re.fullmatch(r"\d{10,}", text):
        try:
            return int(text)
        except Exception:
            return None
    try:
        cleaned = text.replace("Z", "+00:00") if "Z" in text else text
        return int(datetime.fromisoformat(cleaned).timestamp() * 1000)
    except Exception:
        return None

def _whatsapp_item_to_payload(item: Dict[str, Any]) -> Dict[str, Any]:
    message = str(
        item.get("last_message")
        or item.get("lastMessage")
        or item.get("message")
        or ""
    )
    plant = item.get("plant_id") or item.get("plant") or ""
    ts = (
        _parse_ddb_timestamp(item.get("updated_at"))
        or _parse_ddb_timestamp(item.get("updatedAt"))
        or _parse_ddb_timestamp(item.get("timestamp"))
    )
    ts = ts or 0
    msg_hash = hashlib.md5(message.encode("utf-8")).hexdigest()[:10] if message else "nomsg"
    item_id = f"{plant}:{ts}:{msg_hash}"
    return {
        "id": item_id,
        "plant": plant,
        "message": message,
        "templateType": "whatsapp",
        "timestamp": datetime.utcfromtimestamp(ts / 1000).isoformat() + "Z" if ts else "",
        "timestamp_ms": ts,
    }

def _normalize_plant_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").strip().lower())

def _plant_id_candidates(raw: str) -> List[str]:
    base = str(raw or "").strip()
    if not base:
        return []
    no_space = re.sub(r"\s+", "", base)
    candidates = [
        base,
        base.upper(),
        base.lower(),
        base.title(),
        base.capitalize(),
        no_space,
        no_space.upper(),
        no_space.lower(),
        no_space.title(),
    ]
    seen = set()
    ordered = []
    for c in candidates:
        if c and c not in seen:
            ordered.append(c)
            seen.add(c)
    return ordered

def _find_ddb_item_by_plant_id(table: Any, plant_id: str) -> Dict[str, Any]:
    """Try exact and common-case variants; fall back to a small scan for case-insensitive match."""
    for candidate in _plant_id_candidates(plant_id):
        try:
            response = table.get_item(Key={"plant_id": candidate})
            item = _normalize_ddb_item(response.get("Item"))
            if item:
                return item
        except Exception:
            continue

    target_key = _normalize_plant_key(plant_id)
    if not target_key:
        return {}
    try:
        last_evaluated_key = None
        pages = 0
        while pages < 5:
            kwargs = {}
            if last_evaluated_key:
                kwargs["ExclusiveStartKey"] = last_evaluated_key
            response = table.scan(**kwargs)
            items = response.get("Items") or []
            for raw_item in items:
                item = _normalize_ddb_item(raw_item)
                if _normalize_plant_key(item.get("plant_id")) == target_key:
                    return item
            last_evaluated_key = response.get("LastEvaluatedKey")
            pages += 1
            if not last_evaluated_key:
                break
    except Exception:
        return {}
    return {}


def _parse_whatsapp_message(message: str) -> Dict[str, Any]:
    if not message:
        return {}
    parsed: Dict[str, Any] = {}

    lines = [line.strip() for line in re.split(r"[\r\n]+", message) if line.strip()]
    for line in lines:
        match = re.match(r"^([^:]+?)\s*[:\-]\s*(.+)$", line)
        if not match:
            continue
        raw_label = match.group(1).strip().lower()
        value = match.group(2).strip()

        label = re.sub(r"\s+", " ", raw_label)
        if "plant" in label and ("id" in label or "name" in label):
            parsed["plantName"] = value
        elif label.startswith("state"):
            parsed["state"] = value
        elif label.startswith("date"):
            parsed["date"] = value
        elif label.startswith("time"):
            parsed["time"] = value
        elif "current generation" in label:
            num_match = re.search(r"(\d+(?:\.\d+)?)", value)
            if num_match:
                try:
                    parsed["currentGeneration"] = float(num_match.group(1))
                except ValueError:
                    pass
        elif "expected" in label and "trend" in label:
            parsed["expectedTrend"] = value
        elif "curtailment status" in label:
            parsed["curtailmentStatus"] = value.strip().lower() in {"yes", "true", "1"}
        elif "curtailment reason" in label:
            parsed["curtailmentReason"] = value
        elif "weather" in label:
            parsed["weatherCondition"] = value
        elif "inverter" in label:
            num_match = re.search(r"(\d+(?:\.\d+)?)", value)
            if num_match:
                try:
                    parsed["inverterAvailability"] = float(num_match.group(1))
                except ValueError:
                    pass
        elif "remark" in label:
            parsed["remarks"] = value

    if "date" not in parsed:
        date_match = re.search(r"(\d{4}-\d{2}-\d{2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})", message)
        if date_match:
            parsed["date"] = date_match.group(1)
    if "time" not in parsed:
        time_match = re.search(r"\b([01]?\d|2[0-3]):[0-5]\d\b", message)
        if time_match:
            parsed["time"] = time_match.group(0)
    if "currentGeneration" not in parsed:
        gen_match = re.search(r"(\d+(?:\.\d+)?)\s*MW\b", message, re.IGNORECASE)
        if gen_match:
            try:
                parsed["currentGeneration"] = float(gen_match.group(1))
            except ValueError:
                pass
    if "expectedTrend" not in parsed:
        trend_match = re.search(r"\b(increasing|decreasing|stable)\b", message, re.IGNORECASE)
        if trend_match:
            parsed["expectedTrend"] = trend_match.group(1).capitalize()
    if "remarks" not in parsed:
        remarks_match = re.search(r"\bremarks?\b[:\-]\s*(.+)$", message, re.IGNORECASE)
        if remarks_match:
            parsed["remarks"] = remarks_match.group(1).strip()

    status_match = re.search(r"\b(curtaile?ment|normal)\b", message, re.IGNORECASE)
    if status_match and "curtailmentStatus" not in parsed:
        parsed["curtailmentStatus"] = status_match.group(1).lower().startswith("curtail")
    capacity_match = re.search(r"\bcurtaile?ment\s+(\d+(?:\.\d+)?)\b", message, re.IGNORECASE)
    if capacity_match and "curtailmentCapacity" not in parsed:
        try:
            parsed["curtailmentCapacity"] = float(capacity_match.group(1))
        except ValueError:
            pass

    return parsed


_TRIGGER_REASON_MAP = {
    "abrupt_weather": "ABRUPT_WEATHER",
    "curtailment": "CURTAILMENT",
    "dynamic_start": "DYNAMIC_START",
    "plant_status_change": "PLANT_STATUS_CHANGE",
}


def _sanitize_schedule_reason_plant(plant: str) -> str:
    value = str(plant or "").strip().upper()
    if not value or not re.fullmatch(r"[A-Z0-9_-]{1,32}", value):
        raise HTTPException(status_code=400, detail="Invalid plant")
    if value in {"SHRIMOUR", "SHROMOUR"}:
        return "SIRMOUR"
    return value


def _sanitize_schedule_reason_file_name(schedule_file: str) -> str:
    value = os.path.basename(str(schedule_file or "").strip())
    if not value:
        raise HTTPException(status_code=400, detail="schedule_file is required")
    if len(value) > 255:
        raise HTTPException(status_code=400, detail="Invalid schedule_file")
    if any(ch in value for ch in ["/", "\\", "\x00"]):
        raise HTTPException(status_code=400, detail="Invalid schedule_file")
    return value


def _sanitize_schedule_reason_date(date_str: str) -> str:
    value = str(date_str or "").strip()
    try:
        return datetime.strptime(value, "%Y-%m-%d").date().isoformat()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid date; expected YYYY-MM-DD")


def _extract_schedule_id_from_name(file_name: str) -> Optional[str]:
    match = re.search(r"(\d+)", str(file_name or ""))
    return match.group(1) if match else None


def _expand_schedule_reason_prefix(template: str, plant: str, date_str: str) -> str:
    raw = str(template or "").strip()
    if not raw:
        return ""
    plant_text = str(plant or "").strip()
    expanded = (
        raw.replace("{plant}", plant_text)
        .replace("{plant_lower}", plant_text.lower())
        .replace("{date}", date_str)
        .strip()
    )
    return expanded.rstrip("/") + "/"


def _get_schedule_reason_log_prefixes(plant: str, date_str: str) -> List[str]:
    default_prefix = "generated/vedanjay/{plant}/logs/{date}/,generated/{plant}/{plant_lower}/logs/{date}/"
    raw = os.getenv("SCHEDULE_REASON_LOG_PREFIXES", default_prefix)
    # Allow comma or newline separated env values.
    parts = [p.strip() for p in re.split(r"[\r\n,]+", str(raw or "")) if p.strip()]
    prefixes = [_expand_schedule_reason_prefix(p, plant, date_str) for p in parts]
    prefixes = [p for p in prefixes if p]
    if not prefixes:
        prefixes = [_expand_schedule_reason_prefix(default_prefix, plant, date_str)]
    # Preserve order, dedupe.
    return list(dict.fromkeys(prefixes))


def _extract_trigger_reason_from_text(raw_text: str) -> str:
    text = str(raw_text or "")
    lower_text = text.lower()

    def _normalize_token(token: str) -> str:
        return re.sub(r"[\s-]+", "_", str(token or "").strip().lower())

    # 1) Prefer explicit reason markers from log lines.
    explicit_tokens: List[str] = []
    explicit_tokens.extend(
        re.findall(r"schedule\s+reason\s*:\s*([a-zA-Z_\-\s]+)", text, flags=re.IGNORECASE)
    )
    explicit_tokens.extend(
        re.findall(r"\breason\s*=\s*([a-zA-Z_\-\s]+)", text, flags=re.IGNORECASE)
    )
    for token in explicit_tokens:
        normalized = _normalize_token(token)
        if normalized in _TRIGGER_REASON_MAP:
            return _TRIGGER_REASON_MAP[normalized]

    # 2) Fallback keyword scan.
    if re.search(r"\bplant[_\s-]?status[_\s-]?change\b", lower_text):
        return _TRIGGER_REASON_MAP["plant_status_change"]
    if re.search(r"\bdynamic[_\s-]?start\b", lower_text):
        return _TRIGGER_REASON_MAP["dynamic_start"]
    if re.search(r"\bcurtailment\b", lower_text):
        return _TRIGGER_REASON_MAP["curtailment"]
    if re.search(r"\babrupt[_\s-]?weather\b", lower_text):
        return _TRIGGER_REASON_MAP["abrupt_weather"]
    return "-"


def _extract_trigger_reason_from_metadata_value(value: Any) -> str:
    if isinstance(value, str):
        return _extract_trigger_reason_from_text(value)
    if isinstance(value, dict):
        plant_status_value = value.get("plant_status")
        if isinstance(plant_status_value, str) and plant_status_value.strip().upper() == "CURTAILMENT":
            return _TRIGGER_REASON_MAP["curtailment"]
        preferred_keys = [
            "reason",
            "trigger_reason",
            "schedule_reason",
            "triggerReason",
            "scheduleReason",
        ]
        for key in preferred_keys:
            if key in value:
                reason = _extract_trigger_reason_from_metadata_value(value.get(key))
                if reason != "-":
                    return reason
        for _, nested in value.items():
            reason = _extract_trigger_reason_from_metadata_value(nested)
            if reason != "-":
                return reason
    if isinstance(value, list):
        for item in value:
            reason = _extract_trigger_reason_from_metadata_value(item)
            if reason != "-":
                return reason
    return "-"


def _read_s3_text_safe(s3_client: Any, bucket: str, key: str) -> Optional[str]:
    if s3_client is not None and bucket:
        try:
            obj = s3_client.get_object(Bucket=bucket, Key=key)
            return obj["Body"].read().decode("utf-8", errors="replace")
        except Exception:
            pass
    try:
        encoded_key = "/".join(quote(segment) for segment in str(key or "").split("/"))
        url = f"{DEFAULT_TEMPLATE_S3_BASE_URL.rstrip('/')}/{encoded_key}"
        with urlopen(url, timeout=30) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except Exception:
        return None


def _list_s3_keys_safe(s3_client: Any, bucket: str, prefix: str) -> List[str]:
    if (s3_client is None or not bucket) and prefix:
        try:
            url = f"{DEFAULT_TEMPLATE_S3_BASE_URL.rstrip('/')}/?list-type=2&prefix={quote(prefix)}"
            with urlopen(url, timeout=20) as resp:
                xml = resp.read().decode("utf-8", errors="replace")
            root = ElementTree.fromstring(xml)
            keys: List[str] = []
            for node in root.findall(".//{*}Contents"):
                key = node.findtext("{*}Key", default="")
                if key:
                    keys.append(key)
            return keys
        except Exception:
            return []

    keys: List[str] = []
    continuation = None
    while True:
        payload: Dict[str, Any] = {"Bucket": bucket, "Prefix": prefix}
        if continuation:
            payload["ContinuationToken"] = continuation
        try:
            response = s3_client.list_objects_v2(**payload)
        except Exception:
            return keys

        for item in response.get("Contents", []) or []:
            key = str(item.get("Key", "")).strip()
            if key:
                keys.append(key)

        if response.get("IsTruncated"):
            continuation = response.get("NextContinuationToken")
            if not continuation:
                break
        else:
            break
    return keys


def _find_trigger_reason_from_s3_logs(
    *,
    s3_client: Any,
    bucket: str,
    plant: str,
    schedule_id: str,
    date_str: str,
) -> str:
    id_regex = re.compile(rf"(?<!\d){re.escape(str(schedule_id))}(?!\d)")
    direct_name_templates = [
        "schedule from {id} block.log",
        "schedule from {id} block.log.txt",
        "schedule_from_{id}.log",
    ]

    for prefix in _get_schedule_reason_log_prefixes(plant, date_str):
        # Step 1: direct key match.
        for name_template in direct_name_templates:
            key = f"{prefix}{name_template.format(id=schedule_id)}"
            text = _read_s3_text_safe(s3_client, bucket, key)
            if text:
                reason = _extract_trigger_reason_from_text(text)
                if reason != "-":
                    return reason

        # Step 2: list and filter by schedule ID.
        candidate_keys = _list_s3_keys_safe(s3_client, bucket, prefix)
        for key in candidate_keys:
            base = os.path.basename(str(key or ""))
            if not base:
                continue
            if not id_regex.search(base):
                continue
            text = _read_s3_text_safe(s3_client, bucket, key)
            if not text:
                continue
            reason = _extract_trigger_reason_from_text(text)
            if reason != "-":
                return reason

    return "-"


def _find_trigger_reason_from_metadata(
    *,
    s3_client: Any,
    bucket: str,
    plant: str,
    date_str: str,
    schedule_id: Optional[str] = None,
) -> str:
    plant_code = str(plant or "").strip().upper()
    plant_folder = None
    plant_lower = None
    if plant_code == "SIRMOUR":
        plant_folder = "Sirmour"
        plant_lower = "sirmour"
    elif plant_code == "GSNP":
        plant_folder = "GSNP"
        plant_lower = "gsnp"

    metadata_keys = [
        f"generated/vedanjay/{plant_code}/outputs/{date_str}/metadata.json",
        f"generated/{plant_code}/outputs/{date_str}/metadata.json",
        f"outputs/{date_str}/metadata.json",
    ]
    if plant_folder and plant_lower:
        metadata_keys.insert(1, f"generated/{plant_folder}/{plant_lower}/outputs/{date_str}/metadata.json")

    if schedule_id:
        schedule_metadata_names = [
            f"schedule_from_{schedule_id}.meta.json",
            f"schedule_{schedule_id}.meta.json",
        ]
        for name in schedule_metadata_names:
            metadata_keys.insert(
                0,
                f"generated/vedanjay/{plant_code}/outputs/{date_str}/{name}",
            )
            metadata_keys.insert(
                1,
                f"generated/{plant_code}/outputs/{date_str}/{name}",
            )
            if plant_folder and plant_lower:
                metadata_keys.insert(
                    2,
                    f"generated/{plant_folder}/{plant_lower}/outputs/{date_str}/{name}",
                )
            metadata_keys.insert(2, f"outputs/{date_str}/{name}")

    for key in metadata_keys:
        text = _read_s3_text_safe(s3_client, bucket, key)
        if not text:
            continue
        try:
            payload = json.loads(text)
        except Exception:
            continue
        reason = _extract_trigger_reason_from_metadata_value(payload)
        if reason != "-":
            return reason
    return "-"

def _normalize_plant_name(value: str) -> str:
    return "".join(ch for ch in str(value or "").strip().lower() if ch.isalnum())


@app.get("/api/schedule/reason", response_class=PlainTextResponse)
async def get_schedule_trigger_reason(
    plant: str = Query(..., description="Plant code, e.g. GSNP"),
    schedule_file: str = Query(..., description="Schedule file name, e.g. schedule_from_72.csv"),
    date: str = Query(..., description="Date in YYYY-MM-DD format"),
):
    """
    Resolve trigger reason for a schedule file by scanning S3 log files.
    Returns one of: CURTAILMENT, ABRUPT_WEATHER, DYNAMIC_START, or '-'.
    """
    safe_plant = _sanitize_schedule_reason_plant(plant)
    safe_file = _sanitize_schedule_reason_file_name(schedule_file)
    safe_date = _sanitize_schedule_reason_date(date)
    schedule_id = _extract_schedule_id_from_name(safe_file)
    if not schedule_id:
        return "-"

    s3 = None
    bucket = _derive_s3_bucket_name()
    region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or "ap-south-1"
    try:
        import boto3  # type: ignore
        if bucket:
            s3 = boto3.client("s3", region_name=region)
    except Exception:
        s3 = None

    reason = _find_trigger_reason_from_s3_logs(
        s3_client=s3,
        bucket=bucket,
        plant=safe_plant,
        schedule_id=schedule_id,
        date_str=safe_date,
    )
    metadata_reason = _find_trigger_reason_from_metadata(
        s3_client=s3,
        bucket=bucket,
        plant=safe_plant,
        date_str=safe_date,
        schedule_id=schedule_id,
    )
    if metadata_reason == _TRIGGER_REASON_MAP["curtailment"]:
        return metadata_reason
    if reason != "-":
        return reason
    return metadata_reason if metadata_reason in set(_TRIGGER_REASON_MAP.values()) else "-"


def _resolve_pipeline_plant_id(requested_plant_id: int, db: Session) -> int:
    """
    Resolve runtime plant ID (from DB) to pipeline-config plant ID.
    Falls back to name-based match so pipeline configs stay stable across DB reseeds.
    """
    configs = load_pipeline_configs()
    try:
        get_plant_config(requested_plant_id, configs)
        return requested_plant_id
    except Exception:
        pass

    db_plant = get_plant(db, requested_plant_id)
    if db_plant:
        requested_name = _normalize_plant_name(getattr(db_plant, "name", ""))
        for plant in configs.get("plants", []):
            if _normalize_plant_name(plant.get("name", "")) == requested_name:
                return int(plant.get("plant_id"))

    raise ValueError(
        f"No template pipeline mapping found for plant_id={requested_plant_id}. "
        "Add/update backend/config/template_pipeline/plants.json."
    )


@app.get("/api/template-transform/active-plants")
async def list_template_transform_active_plants():
    """Return plant ids that have active template definitions configured."""
    configs = load_pipeline_configs()
    templates = configs.get("template_definitions", []) or []
    plants = configs.get("plants", []) or []
    plant_by_id = {
        int(p.get("plant_id")): p
        for p in plants
        if p.get("plant_id") is not None
    }
    active_templates = [t for t in templates if bool(t.get("is_active", False))]
    plant_ids = sorted({int(t.get("plant_id")) for t in active_templates if t.get("plant_id") is not None})
    plant_names = sorted({
        str(plant_by_id.get(int(pid), {}).get("name", "")).strip()
        for pid in plant_ids
        if str(plant_by_id.get(int(pid), {}).get("name", "")).strip()
    })
    return {
        "plant_ids": plant_ids,
        "plant_names": plant_names,
        "templates": [
            {
                "plant_id": int(t.get("plant_id")) if t.get("plant_id") is not None else None,
                "template_id": str(t.get("template_id", "")),
                "version": str(t.get("version", "")),
                "is_active": bool(t.get("is_active", False)),
                "name": str(t.get("name", "")),
                "plant_name": str(plant_by_id.get(int(t.get("plant_id", 0)), {}).get("name", "")).strip(),
            }
            for t in active_templates
        ],
    }


@app.get("/api/template-transform/source-files")
async def list_template_transform_source_files(
    plant_id: Optional[int] = Query(None),
    target_date: date = Query(..., description="Date in YYYY-MM-DD format"),
    db: Session = Depends(get_db),
):
    """List available schedule_from_*.csv files for a date across configured prefixes."""
    try:
        prefixes = [p.strip() for p in DEFAULT_TEMPLATE_S3_PREFIXES.split(",") if p.strip()]

        files: List[Dict[str, str]] = []
        bucket = _derive_s3_bucket_name()
        region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or "ap-south-1"
        s3_client = None
        try:
            import boto3  # type: ignore
            if bucket:
                s3_client = boto3.client("s3", region_name=region)
        except Exception:
            s3_client = None

        if s3_client is not None and bucket:
            date_str = target_date.isoformat()
            date_prefixes = [f"{prefix.rstrip('/')}/{date_str}/" for prefix in prefixes]
            objects: List[Dict[str, str]] = []
            for prefix in date_prefixes:
                continuation = None
                while True:
                    payload: Dict[str, Any] = {"Bucket": bucket, "Prefix": prefix}
                    if continuation:
                        payload["ContinuationToken"] = continuation
                    try:
                        response = s3_client.list_objects_v2(**payload)
                    except Exception:
                        break
                    for item in response.get("Contents", []) or []:
                        key = str(item.get("Key", "")).strip()
                        if not key:
                            continue
                        last_modified = item.get("LastModified")
                        last_modified_text = ""
                        try:
                            if last_modified is not None:
                                last_modified_text = last_modified.isoformat()
                        except Exception:
                            last_modified_text = ""
                        objects.append({"key": key, "last_modified": last_modified_text})
                    if response.get("IsTruncated"):
                        continuation = response.get("NextContinuationToken")
                        if not continuation:
                            break
                    else:
                        break

            unique = {obj["key"]: obj for obj in objects}
            files = [
                obj for obj in unique.values()
                if obj["key"].lower().endswith(".csv")
                and SCHEDULE_FILE_PREFIX in obj["key"].lower()
            ]
            files.sort(key=lambda item: item.get("last_modified", ""), reverse=True)

        if not files:
            files = list_schedule_files_for_date(
                target_date=target_date,
                s3_base_url=DEFAULT_TEMPLATE_S3_BASE_URL,
                prefixes=prefixes,
            )
        if plant_id is not None:
            try:
                configs = load_pipeline_configs()
                resolved_plant_id = _resolve_pipeline_plant_id(plant_id, db)
                plant = get_plant_config(resolved_plant_id, configs)
                plant_name = str(plant.get("name", "")).strip().lower()
                tokens = {
                    plant_name.replace(" ", ""),
                    plant_name.replace(" ", "_"),
                    plant_name.replace(" ", "-"),
                }
                code_match = re.search(r"\(([A-Za-z0-9_-]+)\)", plant_name, flags=re.IGNORECASE)
                if code_match:
                    tokens.add(code_match.group(1).strip().lower())
                if plant_name.isupper() and 2 <= len(plant_name) <= 6:
                    tokens.add(plant_name.lower())
                filtered = [f for f in files if any(token in f.get("key", "").lower().replace(" ", "") for token in tokens if token)]
                if filtered:
                    files = filtered
            except Exception:
                # Keep original file list if plant filter cannot be applied.
                pass
        return {"date": target_date, "files": files, "total": len(files)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/template-transform/preview", response_model=TemplateTransformPreviewResponse)
async def preview_template_transform(
    request: TemplateTransformRequest,
    db: Session = Depends(get_db),
):
    """
    Preview transformation:
    - Ingest source CSV from S3 key
    - Parse to canonical rows
    - Apply active plant template mapping
    - Validate + return preview rows
    """
    try:
        pipeline_plant_id = _resolve_pipeline_plant_id(request.plant_id, db)
        result = run_preview_pipeline(
            plant_id=pipeline_plant_id,
            target_date=request.date,
            source_file_key=request.source_file_key,
            s3_base_url=DEFAULT_TEMPLATE_S3_BASE_URL,
        )

        template = result["template"]
        validation = result["validation"]
        status = "PREVIEW_VALID" if validation.get("is_valid") else "PREVIEW_FAILED"

        save_transform_audit_run(
            db,
            plant_id=request.plant_id,
            source_file_key=request.source_file_key,
            source_hash=result["source_hash"],
            template_id=str(template.get("template_id", "")),
            template_version=str(template.get("version", "")),
            status=status,
            validation_errors=validation.get("errors", []),
            output_file_key=None,
            output_file_url=None,
            requested_by=request.requested_by,
            run_date=request.date,
        )

        return {
            "plant_id": request.plant_id,
            "template_id": str(template.get("template_id", "")),
            "template_version": str(template.get("version", "")),
            "source_file_key": request.source_file_key,
            "source_hash": result["source_hash"],
            "canonical_row_count": int(result["canonical_row_count"]),
            "validation": validation,
            "target_columns": result["target_columns"],
            "canonical_preview": result["canonical_preview"],
            "transformed_preview": result["transformed_preview"],
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/template-transform/generate", response_model=TemplateTransformGenerateResponse)
async def generate_template_transform(
    request: TemplateTransformRequest,
    db: Session = Depends(get_db),
):
    """
    Generate transformation output file.
    Generation is blocked on validation failure.
    """
    try:
        pipeline_plant_id = _resolve_pipeline_plant_id(request.plant_id, db)
        configs = load_pipeline_configs()
        template = get_active_template(pipeline_plant_id, configs)
        plant = get_plant_config(pipeline_plant_id, configs)
        mappings = get_template_mappings(str(template["template_id"]), configs)

        source_text = fetch_s3_text(request.source_file_key, DEFAULT_TEMPLATE_S3_BASE_URL)
        source_hash = compute_source_hash(source_text)
        canonical_rows = parse_to_canonical_rows(source_text)
        expected_blocks = int(template.get("expected_blocks", 96) or 96)
        auto_fill_missing = bool(template.get("auto_fill_missing_blocks", False))
        canonical_rows, missing_blocks = normalize_canonical_blocks(
            canonical_rows,
            expected_blocks=expected_blocks,
            auto_fill_missing=auto_fill_missing,
        )
        validation = validate_canonical_rows(canonical_rows, float(plant.get("capacity", 0)))
        if auto_fill_missing and missing_blocks:
            validation["warnings"].append(format_missing_blocks_summary(missing_blocks))

        if not validation.get("is_valid"):
            run = save_transform_audit_run(
                db,
                plant_id=request.plant_id,
                source_file_key=request.source_file_key,
                source_hash=source_hash,
                template_id=str(template.get("template_id", "")),
                template_version=str(template.get("version", "")),
                status="PREVIEW_FAILED",
                validation_errors=validation.get("errors", []),
                output_file_key=None,
                output_file_url=None,
                requested_by=request.requested_by,
                run_date=request.date,
            )
            raise HTTPException(
                status_code=400,
                detail={
                    "message": "Validation failed. Generation blocked.",
                    "run_id": run.id,
                    "errors": validation.get("errors", []),
                    "warnings": validation.get("warnings", []),
                },
            )

        target_columns, transformed_rows = transform_rows(canonical_rows, mappings)
        payload = to_csv_bytes(
            target_columns,
            transformed_rows,
            template=template,
            plant=plant,
            target_date=request.date,
        )
        published = publish_output_file(
            payload,
            plant_id=request.plant_id,
            template_id=str(template.get("template_id", "")),
            run_ts=datetime.utcnow(),
        )

        run = save_transform_audit_run(
            db,
            plant_id=request.plant_id,
            source_file_key=request.source_file_key,
            source_hash=source_hash,
            template_id=str(template.get("template_id", "")),
            template_version=str(template.get("version", "")),
            status="GENERATED",
            validation_errors=[],
            output_file_key=published["output_file_key"],
            output_file_url=published["output_file_url"],
            requested_by=request.requested_by,
            run_date=request.date,
        )

        return {
            "run_id": run.id,
            "plant_id": request.plant_id,
            "template_id": str(template.get("template_id", "")),
            "template_version": str(template.get("version", "")),
            "source_file_key": request.source_file_key,
            "source_hash": source_hash,
            "output_file_key": published["output_file_key"],
            "output_file_url": published["output_file_url"],
            "status": "GENERATED",
            "validation": validation,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/template-transform/history")
async def get_template_transform_history(
    plant_id: Optional[int] = Query(None),
    run_date: Optional[date] = Query(None),
    status: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
):
    """Get template transformation run history with optional filters."""
    try:
        rows = query_transform_history(
            db,
            plant_id=plant_id,
            run_date=run_date,
            status=status,
            limit=limit,
        )

        history = []
        for row in rows:
            parsed_errors = []
            if row.validation_errors:
                try:
                    parsed_errors = json.loads(row.validation_errors)
                except Exception:
                    parsed_errors = [str(row.validation_errors)]

            history.append(
                {
                    "id": row.id,
                    "plant_id": row.plant_id,
                    "run_date": row.run_date,
                    "source_file_key": row.source_file_key,
                    "source_hash": row.source_hash,
                    "template_id": row.template_id,
                    "template_version": row.template_version,
                    "status": row.status,
                    "validation_errors": parsed_errors,
                    "output_file_key": row.output_file_key,
                    "output_file_url": row.output_file_url,
                    "requested_by": row.requested_by,
                    "created_at": row.created_at,
                }
            )

        return {"items": history, "total": len(history)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/template-transform/download/{run_id}")
async def download_generated_template(
    run_id: int,
    db: Session = Depends(get_db),
):
    """Download generated template artifact for a given run."""
    try:
        run = get_transform_run_by_id(db, run_id)
        if not run:
            raise HTTPException(status_code=404, detail="Run not found")

        if run.status != "GENERATED":
            raise HTTPException(status_code=400, detail="Run is not in GENERATED state")

        local_path = (run.output_file_url or "").strip()
        if local_path and os.path.exists(local_path):
            return FileResponse(
                path=local_path,
                filename=os.path.basename(local_path),
                media_type="text/csv",
            )

        if run.output_file_url and str(run.output_file_url).startswith("http"):
            # Return URL for clients to redirect/open.
            return {"download_url": run.output_file_url}

        raise HTTPException(status_code=404, detail="Generated file not found")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/schedule-readiness/upload-template", response_model=ScheduleReadinessUploadTemplateResponse)
async def upload_schedule_readiness_template(
    request: ScheduleReadinessUploadTemplateRequest,
):
    """Upload confirmed SLDC template to S3 at uploads/vedanjay/{plant}/{date}/."""
    try:
        plant_code = str(request.plant_code or "").strip().upper()
        if not plant_code:
            raise HTTPException(status_code=400, detail="plant_code is required")
        if plant_code in {"SHRIMOUR", "SHROMOUR"}:
            plant_code = "SIRMOUR"
        allowed_codes = {"BHUPALPALLY", "CME", "GSNP", "KASIPET", "KILAJ", "KOTHAGUDEM", "OSEPL", "SIRMOUR"}
        if plant_code not in allowed_codes:
            raise HTTPException(status_code=400, detail=f"Unsupported plant_code: {plant_code}")

        csv_text = str(request.csv_text or "")
        if not csv_text.strip():
            raise HTTPException(status_code=400, detail="csv_text is required")

        raw_name = str(request.template_file_name or "").strip()
        safe_name = os.path.basename(raw_name).replace("\\", "_").replace("/", "_")
        if not safe_name:
            safe_name = f"{plant_code}_{request.schedule_date}_sldc_template.csv"
        if not safe_name.lower().endswith(".csv"):
            safe_name = f"{safe_name}.csv"

        bucket = _derive_s3_bucket_name()
        key = f"{DEFAULT_READINESS_UPLOAD_PREFIX}/{plant_code}/{request.schedule_date}/{safe_name}"
        region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or "ap-south-1"
        uploaded_at = datetime.utcnow()
        output_file_key = key
        output_file_url = f"https://{bucket}.s3.{region}.amazonaws.com/{key}" if bucket else ""
        storage_mode = "s3"
        message = "Template uploaded to S3 successfully"
        upload_error = None
        effective_bucket = bucket or "UNKNOWN"

        try:
            if not bucket:
                raise RuntimeError("S3 bucket not configured for readiness uploads")
            try:
                import boto3  # type: ignore
            except Exception as e:
                raise RuntimeError(f"boto3 not available: {e}")

            s3 = boto3.client("s3", region_name=region)
            s3.put_object(
                Bucket=bucket,
                Key=key,
                Body=csv_text.encode("utf-8"),
                ContentType="text/csv",
            )
        except Exception as e:
            # Fallback: persist locally so upload flow does not fail when IAM creds are missing.
            storage_mode = "local"
            upload_error = str(e)
            effective_bucket = "LOCAL_FALLBACK"
            local_dir = os.path.join(
                READINESS_UPLOAD_LOCAL_DIR,
                plant_code,
                str(request.schedule_date),
            )
            os.makedirs(local_dir, exist_ok=True)
            local_path = os.path.join(local_dir, safe_name)
            with open(local_path, "w", encoding="utf-8", newline="") as f:
                f.write(csv_text)
            output_file_key = f"local/readiness/{plant_code}/{request.schedule_date}/{safe_name}"
            output_file_url = local_path
            message = "S3 upload unavailable; template stored in local fallback history"

        history_entry = {
            "id": int(uploaded_at.timestamp() * 1000),
            "plant_code": plant_code,
            "schedule_date": str(request.schedule_date),
            "template_file_name": safe_name,
            "source_file_key": str(request.source_file_key or ""),
            "requested_by": str(request.requested_by or ""),
            "bucket": effective_bucket,
            "output_file_key": output_file_key,
            "output_file_url": output_file_url,
            "uploaded_at": uploaded_at.isoformat(),
            "storage_mode": storage_mode,
            "error": upload_error,
            "csv_text": csv_text,
        }
        _append_readiness_upload_history(history_entry)

        return {
            "success": True,
            "message": message,
            "bucket": effective_bucket,
            "output_file_key": output_file_key,
            "output_file_url": output_file_url,
            "uploaded_at": uploaded_at,
            "storage_mode": storage_mode,
            "error": upload_error,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/schedule-readiness/upload-history")
@app.get("/api/schedule-readiness/uploads/history")
async def get_schedule_readiness_upload_history(
    schedule_date: Optional[date] = Query(None),
    plant_code: Optional[str] = Query(None),
    source_file_key: Optional[str] = Query(None),
    limit: int = Query(200, ge=1, le=2000),
):
    """Get upload confirmation history (persisted even when S3 upload falls back locally)."""
    try:
        rows = _load_readiness_upload_history()
        s3_rows = _load_s3_upload_history_rows(
            schedule_date=schedule_date,
            plant_code=plant_code,
            limit=limit,
        )
        # Merge local persisted history + S3 discovered rows.
        merged = rows + s3_rows
        deduped: Dict[str, Dict[str, Any]] = {}
        for r in merged:
            key = str(r.get("output_file_key", "")).strip()
            if not key:
                key = f"{str(r.get('plant_code','')).strip()}|{str(r.get('schedule_date','')).strip()}|{str(r.get('template_file_name','')).strip()}"
            prev = deduped.get(key)
            if prev is None:
                deduped[key] = r
                continue
            prev_ts = str(prev.get("uploaded_at", ""))
            curr_ts = str(r.get("uploaded_at", ""))
            if curr_ts > prev_ts:
                deduped[key] = r

        filtered = list(deduped.values())

        if schedule_date is not None:
            d = schedule_date.isoformat()
            filtered = [r for r in filtered if str(r.get("schedule_date", "")).strip() == d]

        if plant_code:
            p = str(plant_code).strip().upper()
            filtered = [r for r in filtered if str(r.get("plant_code", "")).strip().upper() == p]

        if source_file_key:
            s = str(source_file_key).strip()
            filtered = [r for r in filtered if str(r.get("source_file_key", "")).strip() == s]

        filtered = sorted(
            filtered,
            key=lambda r: str(r.get("uploaded_at", "")),
            reverse=True,
        )[:limit]

        return {"items": filtered, "total": len(filtered)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==================== HEALTH CHECK ====================
@app.get("/api/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "ok", "message": "Server is running"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=3001)

