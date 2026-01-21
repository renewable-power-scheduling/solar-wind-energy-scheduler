"""
FastAPI Backend for QCA Renewable Energy Schedule Management Dashboard
"""
from fastapi import FastAPI, HTTPException, UploadFile, File, Query, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse, StreamingResponse
from sqlalchemy.orm import Session
from typing import Optional, List
import csv
import io
import json
import math
import random
from datetime import datetime, date
import os

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
    ManualTriggerRequest, ContinueScheduleRequest, MarkReadyRequest
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

app = FastAPI(
    title="QCA Renewable Energy Dashboard API",
    description="Backend API for Renewable Energy Schedule Management",
    version="1.0.0"
)

@app.on_event("startup")
async def startup_event():
    """Create database tables on startup"""
    try:
        Base.metadata.create_all(bind=engine)
        print("Database tables created/verified successfully")
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
            "templates": "/api/templates"
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

        # If no real data, generate mock data
        return generate_mock_forecast_data_for_backend(date, plant_id)

    except Exception as e:
        # Fallback to mock data on any error
        return generate_mock_forecast_data_for_backend(date, plant_id)


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
            # Generate mock data instead of raising 404
            # This ensures the frontend always receives valid data
            return generate_mock_meter_data_for_backend(datetime.now().strftime("%Y-%m-%d"), plant_id)
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

        # If no real data, generate mock data
        return generate_mock_meter_data_for_backend(date, plant_id)

    except Exception as e:
        # Fallback to mock data on any error
        return generate_mock_meter_data_for_backend(date, plant_id)


# Helper function to generate mock meter data for backend
def generate_mock_meter_data_for_backend(date, plant_id):
    """Generate mock meter data in the format expected by frontend"""
    # Get plant type to determine generation pattern
    try:
        from crud import get_plant
        plant = get_plant(SessionLocal(), plant_id)
        is_solar = plant.type == "Solar" if plant else False
    except:
        is_solar = plant_id % 2 == 0  # Alternate based on plant_id

    data_points = []

    for i in range(96):
        hour = i // 4
        minute = (i % 4) * 15
        time_str = f"{hour:02d}:{minute:02d}"

        if is_solar:
            # Solar: Peak at noon, zero at night
            if 6 <= hour <= 18:
                solar_progress = (hour - 6 + minute / 60) / 12
                generation = max(0, math.sin(solar_progress * math.pi) * 82 + random.uniform(-8, 8))
            else:
                generation = 0
        else:
            # Wind: Variable throughout day
            wind_base = 48 + math.sin((i / 96) * 2 * math.pi - math.pi / 2) * 22
            generation = max(0, wind_base + random.uniform(-10, 10))

        available_capacity = 90 if is_solar else 95
        availability = max(0, available_capacity + random.uniform(-5, 5))

        data_points.append({
            "time": time_str,
            "hour": hour,
            "minute": minute,
            "generation": round(generation, 2),
            "availableCapacity": available_capacity,
            "availability": round(availability, 1)
        })

    return {
        "date": date,
        "dataPoints": data_points,
        "totalGeneration": round(sum(d["generation"] for d in data_points), 1),
        "avgGeneration": round(sum(d["generation"] for d in data_points if d["generation"] > 0) / len([d for d in data_points if d["generation"] > 0]), 2),
        "peakGeneration": round(max(d["generation"] for d in data_points), 2),
        "lastReading": datetime.now().isoformat(),
        "source": "SCADA",
        "status": "Live"
    }


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
            "whatsapp-data": "/api/whatsapp-data",
            "meter-data": "/api/meter-data",
            "health": "/api/health"
        }
    }


# Helper function to generate mock forecast data for backend
def generate_mock_forecast_data_for_backend(date, plant_id):
    """Generate mock forecast data in the format expected by frontend"""
    import random
    from datetime import datetime

    # Get plant type to determine generation pattern
    try:
        from crud import get_plant
        plant = get_plant(SessionLocal(), plant_id)
        is_solar = plant.type == "Solar" if plant else False
    except:
        is_solar = plant_id % 2 == 0  # Alternate based on plant_id

    data_points = []

    for i in range(96):
        hour = i // 4
        minute = (i % 4) * 15
        time_str = f"{hour:02d}:{minute:02d}"

        if is_solar:
            # Solar: Peak at noon, zero at night
            if 6 <= hour <= 18:
                solar_progress = (hour - 6 + minute / 60) / 12
                forecast = max(0, math.sin(solar_progress * math.pi) * 85 + random.uniform(-5, 5))
                actual = max(0, forecast + random.uniform(-5, 5))
            else:
                forecast = actual = 0
        else:
            # Wind: Variable throughout day
            wind_base = 45 + math.sin((i / 96) * 2 * math.pi - math.pi / 2) * 20
            forecast = max(0, wind_base + random.uniform(-8, 8))
            actual = max(0, forecast + random.uniform(-6, 6))

        scheduled = max(0, forecast - 1 + random.uniform(-1, 1))

        data_points.append({
            "time": time_str,
            "hour": hour,
            "minute": minute,
            "forecast": round(forecast, 2),
            "actual": round(actual, 2),
            "scheduled": round(scheduled, 2)
        })

    return {
        "date": date,
        "dataPoints": data_points,
        "totalForecast": round(sum(d["forecast"] for d in data_points), 1),
        "totalActual": round(sum(d["actual"] for d in data_points), 1),
        "avgForecast": round(sum(d["forecast"] for d in data_points if d["forecast"] > 0) / len([d for d in data_points if d["forecast"] > 0]), 2),
        "avgActual": round(sum(d["actual"] for d in data_points if d["actual"] > 0) / len([d for d in data_points if d["actual"] > 0]), 2),
        "peakForecast": round(max(d["forecast"] for d in data_points), 2),
        "peakActual": round(max(d["actual"] for d in data_points), 2),
        "createdAt": datetime.now().isoformat()
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


@app.get("/api/schedule-readiness/{plant_id}")
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


@app.post("/api/schedule-readiness/{plant_id}/trigger")
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


@app.post("/api/schedule-readiness/{plant_id}/continue")
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


@app.post("/api/schedule-readiness/{plant_id}/mark-ready")
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


# ==================== HEALTH CHECK ====================
@app.get("/api/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "ok", "message": "Server is running"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=3001)
