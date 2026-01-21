"""
CRUD operations for database models
"""
from sqlalchemy.orm import Session
from sqlalchemy import func, and_, or_
from typing import List, Optional, Dict, Any
from datetime import date, datetime, timedelta
import json
import os

from models import (
    Plant, Schedule, Forecast, Weather, Deviation, Report, Template, WhatsAppData, MeterData
)
from schemas import (
    PlantCreate, PlantUpdate, ScheduleCreate, ScheduleUpdate,
    ForecastCreate, WeatherCreate, DeviationCreate, ReportCreate, TemplateCreate,
    WhatsAppDataCreate, WhatsAppDataUpdate, MeterDataCreate, MeterDataUpdate
)


# ==================== PLANT CRUD ====================
def get_plants(
    db: Session,
    skip: int = 0,
    limit: int = 1000,
    search: Optional[str] = None,
    type: Optional[str] = None,
    state: Optional[str] = None,
    status: Optional[str] = None
) -> List[Plant]:
    """Get all plants with optional filtering"""
    query = db.query(Plant)
    
    if search:
        query = query.filter(Plant.name.ilike(f"%{search}%"))
    if type:
        query = query.filter(Plant.type == type)
    if state:
        query = query.filter(Plant.state == state)
    if status:
        query = query.filter(Plant.status == status)
    
    return query.offset(skip).limit(limit).all()


def get_plant(db: Session, plant_id: int) -> Optional[Plant]:
    """Get a single plant by ID"""
    return db.query(Plant).filter(Plant.id == plant_id).first()


def create_plant(db: Session, plant: PlantCreate) -> Plant:
    """Create a new plant"""
    db_plant = Plant(**plant.dict())
    db.add(db_plant)
    db.commit()
    db.refresh(db_plant)
    return db_plant


def update_plant(db: Session, plant_id: int, plant: PlantUpdate) -> Optional[Plant]:
    """Update an existing plant"""
    db_plant = get_plant(db, plant_id)
    if not db_plant:
        return None
    
    update_data = plant.dict(exclude_unset=True)
    for key, value in update_data.items():
        setattr(db_plant, key, value)
    
    db.commit()
    db.refresh(db_plant)
    return db_plant


def delete_plant(db: Session, plant_id: int) -> bool:
    """Delete a plant"""
    db_plant = get_plant(db, plant_id)
    if not db_plant:
        return False
    
    db.delete(db_plant)
    db.commit()
    return True


# ==================== SCHEDULE CRUD ====================
def get_schedules(
    db: Session,
    skip: int = 0,
    limit: int = 10,  # Default limit to 10
    type: Optional[str] = None,
    status: Optional[str] = None,
    plant: Optional[str] = None,
    startDate: Optional[str] = None,
    endDate: Optional[str] = None
) -> List[Schedule]:
    """Get all schedules with optional filtering"""
    query = db.query(Schedule)
    
    if type:
        query = query.filter(Schedule.type == type)
    if status:
        query = query.filter(Schedule.status == status)
    if plant:
        query = query.filter(Schedule.plantName == plant)
    if startDate:
        try:
            query = query.filter(Schedule.scheduleDate >= datetime.strptime(startDate, "%Y-%m-%d").date())
        except ValueError:
            pass
    if endDate:
        try:
            query = query.filter(Schedule.scheduleDate <= datetime.strptime(endDate, "%Y-%m-%d").date())
        except ValueError:
            pass
    
    # Ensure limit is reasonable (between 1 and 100)
    if limit > 100:
        limit = 100
    if limit < 1:
        limit = 1
    
    results = query.order_by(Schedule.scheduleDate.desc(), Schedule.id.desc()).offset(skip).limit(limit).all()
    
    # Return SQLAlchemy models directly - FastAPI will handle serialization
    return results


def get_schedule(db: Session, schedule_id: int) -> Optional[Schedule]:
    """Get a single schedule by ID"""
    return db.query(Schedule).filter(Schedule.id == schedule_id).first()


def create_schedule(db: Session, schedule: ScheduleCreate) -> Schedule:
    """Create a new schedule with optional block data"""
    schedule_dict = schedule.dict(exclude_unset=True)
    
    # Calculate deviation if actual and forecasted are provided
    deviation = 0.0
    if schedule.forecasted and schedule.actual:
        deviation = ((schedule.actual - schedule.forecasted) / schedule.forecasted * 100) if schedule.forecasted > 0 else 0.0
    schedule_dict['deviation'] = deviation
    
    # Convert blockData dict to JSON string if present
    if schedule_dict.get('blockData'):
        schedule_dict['blockData'] = json.dumps(schedule_dict['blockData'])
    
    db_schedule = Schedule(**schedule_dict)
    db.add(db_schedule)
    db.commit()
    db.refresh(db_schedule)
    return db_schedule


def update_schedule(db: Session, schedule_id: int, schedule: ScheduleUpdate) -> Optional[Schedule]:
    """Update an existing schedule"""
    db_schedule = get_schedule(db, schedule_id)
    if not db_schedule:
        return None
    
    update_data = schedule.dict(exclude_unset=True)
    
    # Recalculate deviation if forecasted or actual changed
    if 'forecasted' in update_data or 'actual' in update_data:
        forecasted = update_data.get('forecasted', db_schedule.forecasted)
        actual = update_data.get('actual', db_schedule.actual)
        if forecasted and actual:
            update_data['deviation'] = ((actual - forecasted) / forecasted * 100) if forecasted > 0 else 0.0
    
    # Convert blockData dict to JSON string if present
    if 'blockData' in update_data and update_data['blockData']:
        update_data['blockData'] = json.dumps(update_data['blockData'])
    
    for key, value in update_data.items():
        setattr(db_schedule, key, value)
    
    db.commit()
    db.refresh(db_schedule)
    return db_schedule


def delete_schedule(db: Session, schedule_id: int) -> bool:
    """Delete a schedule"""
    db_schedule = get_schedule(db, schedule_id)
    if not db_schedule:
        return False
    
    db.delete(db_schedule)
    db.commit()
    return True


def get_schedule_with_blocks(db: Session, schedule_id: int) -> Optional[Dict[str, Any]]:
    """Get schedule with parsed block data"""
    db_schedule = get_schedule(db, schedule_id)
    if not db_schedule:
        return None
    
    schedule_dict = {
        "id": db_schedule.id,
        "plantName": db_schedule.plantName,
        "type": db_schedule.type,
        "scheduleDate": db_schedule.scheduleDate,
        "capacity": db_schedule.capacity,
        "forecasted": db_schedule.forecasted,
        "actual": db_schedule.actual,
        "status": db_schedule.status,
        "deviation": db_schedule.deviation,
        "createdAt": db_schedule.createdAt
    }
    
    # Parse blockData
    if db_schedule.blockData:
        try:
            schedule_dict["blockData"] = json.loads(db_schedule.blockData)
        except json.JSONDecodeError:
            schedule_dict["blockData"] = {}
    else:
        schedule_dict["blockData"] = {}
    
    return schedule_dict


def calculate_deviations_from_blocks(blockData: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Calculate deviations from schedule block data"""
    if not blockData:
        return []
    
    deviations = []
    for block_key, block_info in blockData.items():
        if isinstance(block_info, dict):
            forecasted = block_info.get("forecasted", 0)
            actual = block_info.get("actual", 0)
            scheduled = block_info.get("scheduled", 0)
            
            deviation = actual - forecasted
            percentage = (deviation / forecasted * 100) if forecasted > 0 else 0
            
            deviations.append({
                "time": block_info.get("time", block_key),
                "block": block_info.get("block", 0),
                "forecasted": forecasted,
                "actual": actual,
                "scheduled": scheduled,
                "deviation": deviation,
                "percentage": round(percentage, 2)
            })
    
    return deviations


def create_deviation_from_schedule(db: Session, schedule: Schedule) -> List[Deviation]:
    """Create deviation records from a schedule's block data"""
    if not schedule.blockData:
        return []
    
    try:
        blockData = json.loads(schedule.blockData)
    except json.JSONDecodeError:
        return []
    
    deviations = []
    for block_key, block_info in blockData.items():
        if isinstance(block_info, dict):
            # Get hour from time
            time_str = block_info.get("time", "00:00")
            try:
                hour = int(time_str.split(":")[0])
            except (ValueError, IndexError):
                hour = 0
            
            forecasted = block_info.get("forecasted", 0)
            actual = block_info.get("actual", 0)
            deviation = actual - forecasted
            
            # Create deviation record
            deviation_record = Deviation(
                hour=hour,
                deviation=deviation,
                forecasted=forecasted,
                actual=actual,
                plantId=None  # Will be set by join query
            )
            db.add(deviation_record)
            deviations.append(deviation_record)
    
    db.commit()
    # Refresh to get IDs
    for dev in deviations:
        db.refresh(dev)
    
    return deviations


# ==================== FORECAST CRUD ====================
def get_forecasts(
    db: Session,
    skip: int = 0,
    limit: int = 100,
    plantId: Optional[int] = None
) -> List[Forecast]:
    """Get all forecasts with optional filtering"""
    query = db.query(Forecast)
    
    if plantId:
        query = query.filter(Forecast.plantId == plantId)
    
    return query.offset(skip).limit(limit).all()


def get_forecast(db: Session, plant_id: int) -> Optional[Forecast]:
    """Get forecast for a specific plant"""
    return db.query(Forecast).filter(Forecast.plantId == plant_id).first()


def create_forecast(db: Session, forecast: ForecastCreate) -> Forecast:
    """Create a new forecast"""
    forecast_dict = forecast.dict()
    if forecast_dict.get('hourlyData'):
        forecast_dict['hourlyData'] = json.dumps(forecast_dict['hourlyData'])
    
    db_forecast = Forecast(**forecast_dict)
    db.add(db_forecast)
    db.commit()
    db.refresh(db_forecast)
    return db_forecast


# ==================== WEATHER CRUD ====================
def get_weather_data(
    db: Session,
    location: Optional[str] = None
) -> List[Weather]:
    """Get weather data with optional location filter"""
    query = db.query(Weather)
    
    if location:
        query = query.filter(Weather.location == location)
    
    return query.all()


def create_weather(db: Session, weather: WeatherCreate) -> Weather:
    """Create new weather data"""
    weather_dict = weather.dict()
    if weather_dict.get('forecast'):
        weather_dict['forecast'] = json.dumps(weather_dict['forecast'])
    
    db_weather = Weather(**weather_dict)
    db.add(db_weather)
    db.commit()
    db.refresh(db_weather)
    return db_weather


# ==================== DEVIATION CRUD ====================
def get_deviations(
    db: Session,
    skip: int = 0,
    limit: int = 100,
    period: str = "hourly",
    plantId: Optional[int] = None
) -> List[Dict[str, Any]]:
    """Get deviations with plant information"""
    # Left join with Plant table to get plant details (handles null plantId)
    query = db.query(Deviation, Plant).outerjoin(Plant, Deviation.plantId == Plant.id)

    if plantId:
        query = query.filter(Deviation.plantId == plantId)

    # Adjust limit based on period to get enough data for aggregation
    adjusted_limit = limit
    if period == "daily":
        adjusted_limit = limit * 24  # Get 24 hours per day
    elif period == "weekly":
        adjusted_limit = limit * 168  # Get 168 hours per week

    results = query.order_by(Deviation.hour).offset(skip).limit(adjusted_limit).all()

    # Transform to expected format with plant information
    deviations = []
    for dev, plant in results:
        percentage = ((dev.actual - dev.forecasted) / dev.forecasted * 100) if dev.forecasted > 0 else 0.0
        # Handle case where plant is None (null plantId)
        plant_name = plant.name if plant else f"Plant {dev.plantId or 'Unknown'}"
        plant_type = plant.type if plant else "Unknown"
        deviations.append({
            "time": f"{dev.hour % 24:02d}:00",  # Format hour as HH:00
            "hour": dev.hour,
            "plant": plant_name,
            "type": plant_type,
            "scheduled": dev.forecasted,
            "actual": dev.actual,
            "deviation": dev.deviation,
            "percentage": round(percentage, 1)
        })

    return deviations


def create_deviation(db: Session, deviation: DeviationCreate) -> Deviation:
    """Create a new deviation record"""
    db_deviation = Deviation(**deviation.dict())
    db.add(db_deviation)
    db.commit()
    db.refresh(db_deviation)
    return db_deviation


# ==================== REPORT CRUD ====================
def get_reports(db: Session, skip: int = 0, limit: int = 100, type: Optional[str] = None, state: Optional[str] = None) -> List[Report]:
    """Get all reports with optional filtering by type and state"""
    query = db.query(Report)
    
    # Apply type filter
    if type and type != 'all':
        query = query.filter(Report.type.ilike(f"%{type}%"))
    
    # Apply state filter (search in name for state-like content)
    if state and state != 'all':
        query = query.filter(Report.name.ilike(f"%{state}%"))
    
    reports = query.order_by(Report.generatedDate.desc()).offset(skip).limit(limit).all()
    
    # Update status based on file existence for reports marked as "Generating"
    for report in reports:
        if report.status == "Generating" and report.filePath:
            if os.path.exists(report.filePath):
                report.status = "Ready"
                db.commit()
                db.refresh(report)
            elif report.createdAt:
                # If file doesn't exist and report is old (more than 5 minutes), mark as Failed
                if (datetime.now() - report.createdAt).total_seconds() > 300:
                    report.status = "Failed"
                    db.commit()
                    db.refresh(report)
    
    return reports


def get_report(db: Session, report_id: int) -> Optional[Report]:
    """Get a single report by ID"""
    return db.query(Report).filter(Report.id == report_id).first()


def update_report(db: Session, report_id: int, filePath: Optional[str] = None, status: Optional[str] = None) -> Optional[Report]:
    """Update a report's file path and status"""
    db_report = get_report(db, report_id)
    if not db_report:
        return None
    
    if filePath is not None:
        db_report.filePath = filePath
    if status is not None:
        db_report.status = status
    
    db.commit()
    db.refresh(db_report)
    return db_report


def create_report(db: Session, report: ReportCreate) -> Report:
    """Create a new report"""
    db_report = Report(**report.dict())
    db.add(db_report)
    db.commit()
    db.refresh(db_report)
    return db_report


def delete_report(db: Session, report_id: int) -> Dict[str, Any]:
    """Delete a report and return structured response"""
    db_report = get_report(db, report_id)
    if not db_report:
        return {"success": False, "message": "Report not found", "id": report_id}

    # Delete associated file if it exists
    if db_report.filePath and os.path.exists(db_report.filePath):
        try:
            os.remove(db_report.filePath)
        except OSError:
            pass  # Ignore file deletion errors

    # Store ID before deletion
    deleted_id = db_report.id
    
    db.delete(db_report)
    db.commit()
    
    return {"success": True, "message": "Report deleted successfully", "id": deleted_id}


# ==================== TEMPLATE CRUD ====================
def get_templates(
    db: Session,
    skip: int = 0,
    limit: int = 100,
    vendor: Optional[str] = None,
    type: Optional[str] = None
) -> List[Template]:
    """Get all templates with optional filtering"""
    query = db.query(Template)
    
    if vendor:
        query = query.filter(Template.vendor == vendor)
    if type:
        query = query.filter(Template.type == type)
    
    return query.offset(skip).limit(limit).all()


def get_template(db: Session, template_id: int) -> Optional[Template]:
    """Get a single template by ID"""
    return db.query(Template).filter(Template.id == template_id).first()


def create_template(db: Session, template: TemplateCreate) -> Template:
    """Create a new template"""
    db_template = Template(**template.dict())
    db.add(db_template)
    db.commit()
    db.refresh(db_template)
    return db_template


def delete_template(db: Session, template_id: int) -> bool:
    """Delete a template"""
    db_template = get_template(db, template_id)
    if not db_template:
        return False
    
    db.delete(db_template)
    db.commit()
    return True


# ==================== DASHBOARD STATS ====================
def get_dashboard_stats(db: Session) -> Dict[str, Any]:
    """Get dashboard statistics"""
    try:
        plants = db.query(Plant).all()
        all_schedules = db.query(Schedule).all()
        
        # Filter schedules by status for the schedules object
        pending_schedules = [s for s in all_schedules if s.status == "Pending"]
        approved_schedules = [s for s in all_schedules if s.status == "Approved"]
        revised_schedules = [s for s in all_schedules if s.status == "Revised"]
        # Active schedules for generation calculation
        active_schedules = [s for s in all_schedules if s.status == "Active"]
        
        active_plants = [p for p in plants if p.status == "Active"]
        wind_plants = [p for p in active_plants if p.type == "Wind"]
        solar_plants = [p for p in active_plants if p.type == "Solar"]
        
        # Handle null capacity values safely
        total_capacity = sum(p.capacity or 0 for p in active_plants)
        wind_capacity = sum(p.capacity or 0 for p in wind_plants)
        solar_capacity = sum(p.capacity or 0 for p in solar_plants)
        current_generation = sum(s.actual or 0 for s in active_schedules if s.actual)
        
        efficiency = (current_generation / total_capacity * 100) if total_capacity > 0 else 0.0
        
        return {
            "activePlants": len(active_plants),
            "totalCapacity": round(total_capacity, 2),
            "currentGeneration": round(current_generation, 2),
            "efficiency": round(efficiency, 2),
            "windCapacity": round(wind_capacity, 2),
            "solarCapacity": round(solar_capacity, 2),
            "schedules": {
                "total": len(all_schedules),
                "pending": len(pending_schedules),
                "approved": len(approved_schedules),
                "revised": len(revised_schedules)
            }
        }
    except Exception as e:
        # Log the error for debugging
        print(f"Error in get_dashboard_stats: {str(e)}")
        # Return a safe fallback with minimal data
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


# ==================== WHATSAPP DATA CRUD ====================
def get_whatsapp_data(
    db: Session,
    skip: int = 0,
    limit: int = 100,
    plant_id: Optional[int] = None,
    date: Optional[date] = None,
    status: Optional[str] = None
) -> List[WhatsAppData]:
    """Get all WhatsApp data with optional filtering"""
    query = db.query(WhatsAppData)
    
    if plant_id:
        query = query.filter(WhatsAppData.plantId == plant_id)
    if date:
        query = query.filter(WhatsAppData.date == date)
    if status:
        query = query.filter(WhatsAppData.status == status)
    
    return query.order_by(WhatsAppData.createdAt.desc()).offset(skip).limit(limit).all()


def get_whatsapp_data_by_id(db: Session, whatsapp_id: int) -> Optional[WhatsAppData]:
    """Get a single WhatsApp data entry by ID"""
    return db.query(WhatsAppData).filter(WhatsAppData.id == whatsapp_id).first()


def create_whatsapp_data(db: Session, whatsapp_data: WhatsAppDataCreate) -> WhatsAppData:
    """Create a new WhatsApp data entry"""
    db_whatsapp = WhatsAppData(**whatsapp_data.dict())
    db.add(db_whatsapp)
    db.commit()
    db.refresh(db_whatsapp)
    return db_whatsapp


def update_whatsapp_data(db: Session, whatsapp_id: int, whatsapp_data: WhatsAppDataUpdate) -> Optional[WhatsAppData]:
    """Update a WhatsApp data entry"""
    db_whatsapp = get_whatsapp_data_by_id(db, whatsapp_id)
    if not db_whatsapp:
        return None
    
    update_data = whatsapp_data.dict(exclude_unset=True)
    for key, value in update_data.items():
        setattr(db_whatsapp, key, value)
    
    db.commit()
    db.refresh(db_whatsapp)
    return db_whatsapp


def delete_whatsapp_data(db: Session, whatsapp_id: int) -> bool:
    """Delete a WhatsApp data entry"""
    db_whatsapp = get_whatsapp_data_by_id(db, whatsapp_id)
    if not db_whatsapp:
        return False
    
    db.delete(db_whatsapp)
    db.commit()
    return True


# ==================== METER DATA CRUD ====================
def get_meter_data(
    db: Session,
    skip: int = 0,
    limit: int = 100,
    plant_id: Optional[int] = None,
    data_date: Optional[date] = None
) -> List[MeterData]:
    """Get all meter data with optional filtering"""
    query = db.query(MeterData)
    
    if plant_id:
        query = query.filter(MeterData.plantId == plant_id)
    if data_date:
        query = query.filter(MeterData.dataDate == data_date)
    
    return query.order_by(MeterData.dataDate.desc(), MeterData.createdAt.desc()).offset(skip).limit(limit).all()


def get_meter_data_by_id(db: Session, meter_id: int) -> Optional[MeterData]:
    """Get a single meter data entry by ID"""
    return db.query(MeterData).filter(MeterData.id == meter_id).first()


def get_latest_meter_data(db: Session, plant_id: int) -> Optional[MeterData]:
    """Get the latest meter data for a plant"""
    return db.query(MeterData).filter(MeterData.plantId == plant_id).order_by(MeterData.dataDate.desc(), MeterData.createdAt.desc()).first()


def create_meter_data(db: Session, meter_data: MeterDataCreate) -> MeterData:
    """Create a new meter data entry"""
    # Convert blockData dict to JSON string
    data_dict = meter_data.dict()
    if isinstance(data_dict.get('blockData'), dict):
        data_dict['blockData'] = json.dumps(data_dict['blockData'])
    
    db_meter = MeterData(**data_dict)
    db.add(db_meter)
    db.commit()
    db.refresh(db_meter)
    return db_meter


def update_meter_data(db: Session, meter_id: int, meter_data: MeterDataUpdate) -> Optional[MeterData]:
    """Update a meter data entry"""
    db_meter = get_meter_data_by_id(db, meter_id)
    if not db_meter:
        return None
    
    update_data = meter_data.dict(exclude_unset=True)
    # Convert blockData dict to JSON string if present
    if 'blockData' in update_data and isinstance(update_data['blockData'], dict):
        update_data['blockData'] = json.dumps(update_data['blockData'])
    
    for key, value in update_data.items():
        setattr(db_meter, key, value)
    
    db.commit()
    db.refresh(db_meter)
    return db_meter


def delete_meter_data(db: Session, meter_id: int) -> bool:
    """Delete a meter data entry"""
    db_meter = get_meter_data_by_id(db, meter_id)
    if not db_meter:
        return False
    
    db.delete(db_meter)
    db.commit()
    return True


# Import new models for CRUD operations
from models import ScheduleReadiness, ScheduleTrigger, ScheduleNotification


# ==================== SCHEDULE READINESS CRUD ====================
def get_schedule_readiness(
    db: Session,
    plant_id: Optional[int] = None,
    status: Optional[str] = None
) -> List:
    """Get schedule readiness records"""
    query = db.query(ScheduleReadiness)
    
    if plant_id:
        query = query.filter(ScheduleReadiness.plant_id == plant_id)
    if status and status != 'All':
        query = query.filter(ScheduleReadiness.status == status)
    
    return query.order_by(ScheduleReadiness.updated_at.desc()).all()


def get_schedule_readiness_by_id(db: Session, readiness_id: int) -> Optional[ScheduleReadiness]:
    """Get a single schedule readiness record by ID"""
    return db.query(ScheduleReadiness).filter(ScheduleReadiness.id == readiness_id).first()


def get_schedule_readiness_by_plant(db: Session, plant_id: int) -> Optional[ScheduleReadiness]:
    """Get schedule readiness for a specific plant"""
    return db.query(ScheduleReadiness).filter(ScheduleReadiness.plant_id == plant_id).first()


def create_schedule_readiness(db: Session, readiness: Dict) -> ScheduleReadiness:
    """Create a new schedule readiness record"""
    db_readiness = ScheduleReadiness(**readiness)
    db.add(db_readiness)
    db.commit()
    db.refresh(db_readiness)
    return db_readiness


def update_schedule_readiness(db: Session, readiness_id: int, update_data: Dict) -> Optional[ScheduleReadiness]:
    """Update a schedule readiness record"""
    db_readiness = get_schedule_readiness_by_id(db, readiness_id)
    if not db_readiness:
        return None
    
    for key, value in update_data.items():
        setattr(db_readiness, key, value)
    
    db.commit()
    db.refresh(db_readiness)
    return db_readiness


def get_schedule_readiness_summary(db: Session) -> Dict[str, Any]:
    """Get summary of all plant readiness statuses"""
    all_readiness = db.query(ScheduleReadiness).all()
    
    # Get all plants to ensure we have records for all
    plants = db.query(Plant).all()
    plant_ids = {p.id for p in plants}
    readiness_plant_ids = {r.plant_id for r in all_readiness}
    
    # Create readiness records for plants that don't have them
    for plant in plants:
        if plant.id not in readiness_plant_ids:
            db_readiness = ScheduleReadiness(
                plant_id=plant.id,
                plant_name=plant.name,
                status="NO_ACTION",
                schedule_date=date.today()
            )
            db.add(db_readiness)
    
    db.commit()
    
    # Refresh and get all
    all_readiness = db.query(ScheduleReadiness).all()
    
    ready_count = len([r for r in all_readiness if r.status == "READY"])
    pending_count = len([r for r in all_readiness if r.status == "PENDING"])
    no_action_count = len([r for r in all_readiness if r.status == "NO_ACTION"])
    
    return {
        "total_plants": len(all_readiness),
        "ready_count": ready_count,
        "pending_count": pending_count,
        "no_action_count": no_action_count,
        "plants": all_readiness
    }


# ==================== SCHEDULE TRIGGER CRUD ====================
def get_schedule_triggers(
    db: Session,
    plant_id: Optional[int] = None,
    trigger_type: Optional[str] = None,
    processed: Optional[bool] = None,
    limit: int = 100
) -> List[ScheduleTrigger]:
    """Get schedule trigger records"""
    query = db.query(ScheduleTrigger)
    
    if plant_id:
        query = query.filter(ScheduleTrigger.plant_id == plant_id)
    if trigger_type:
        query = query.filter(ScheduleTrigger.trigger_type == trigger_type)
    if processed is not None:
        query = query.filter(ScheduleTrigger.processed == processed)
    
    return query.order_by(ScheduleTrigger.created_at.desc()).limit(limit).all()


def create_schedule_trigger(db: Session, trigger_data: Dict) -> ScheduleTrigger:
    """Create a new schedule trigger record"""
    db_trigger = ScheduleTrigger(**trigger_data)
    db.add(db_trigger)
    db.commit()
    db.refresh(db_trigger)
    return db_trigger


def acknowledge_schedule_trigger(db: Session, trigger_id: int) -> Optional[ScheduleTrigger]:
    """Acknowledge a schedule trigger"""
    db_trigger = db.query(ScheduleTrigger).filter(ScheduleTrigger.id == trigger_id).first()
    if not db_trigger:
        return None
    
    db_trigger.acknowledged = True
    db.commit()
    db.refresh(db_trigger)
    return db_trigger


def process_schedule_trigger(db: Session, trigger_id: int) -> Optional[ScheduleTrigger]:
    """Mark a schedule trigger as processed"""
    db_trigger = db.query(ScheduleTrigger).filter(ScheduleTrigger.id == trigger_id).first()
    if not db_trigger:
        return None
    
    db_trigger.processed = True
    db_trigger.acknowledged = True
    db.commit()
    db.refresh(db_trigger)
    return db_trigger


# ==================== SCHEDULE NOTIFICATION CRUD ====================
def get_schedule_notifications(
    db: Session,
    plant_id: Optional[int] = None,
    unread_only: bool = False,
    limit: int = 100
) -> List[ScheduleNotification]:
    """Get schedule notification records"""
    query = db.query(ScheduleNotification)
    
    if plant_id:
        query = query.filter(ScheduleNotification.plant_id == plant_id)
    if unread_only:
        query = query.filter(ScheduleNotification.read == False)
    
    return query.order_by(
        ScheduleNotification.priority.desc(),
        ScheduleNotification.created_at.desc()
    ).limit(limit).all()


def get_schedule_notification_by_id(db: Session, notification_id: int) -> Optional[ScheduleNotification]:
    """Get a single schedule notification by ID"""
    return db.query(ScheduleNotification).filter(ScheduleNotification.id == notification_id).first()


def create_schedule_notification(db: Session, notification_data: Dict) -> ScheduleNotification:
    """Create a new schedule notification record"""
    db_notification = ScheduleNotification(**notification_data)
    db.add(db_notification)
    db.commit()
    db.refresh(db_notification)
    return db_notification


def mark_notification_read(db: Session, notification_id: int) -> Optional[ScheduleNotification]:
    """Mark a notification as read"""
    db_notification = get_schedule_notification_by_id(db, notification_id)
    if not db_notification:
        return None
    
    db_notification.read = True
    db.commit()
    db.refresh(db_notification)
    return db_notification


def mark_all_notifications_read(db: Session, plant_id: Optional[int] = None) -> int:
    """Mark all notifications as read"""
    query = db.query(ScheduleNotification).filter(ScheduleNotification.read == False)
    
    if plant_id:
        query = query.filter(ScheduleNotification.plant_id == plant_id)
    
    count = query.count()
    query.update({"read": True})
    db.commit()
    
    return count


def get_unread_notification_count(db: Session, plant_id: Optional[int] = None) -> int:
    """Get count of unread notifications"""
    query = db.query(ScheduleNotification).filter(ScheduleNotification.read == False)
    
    if plant_id:
        query = query.filter(ScheduleNotification.plant_id == plant_id)
    
    return query.count()
