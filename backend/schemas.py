"""
Pydantic schemas for request/response validation
"""
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
from datetime import date, datetime


# Plant Schemas
class PlantBase(BaseModel):
    name: str
    type: str
    capacity: float
    state: str
    status: Optional[str] = "Active"
    efficiency: Optional[float] = 0.0
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    location_name: Optional[str] = None


class PlantCreate(PlantBase):
    pass


class PlantUpdate(BaseModel):
    name: Optional[str] = None
    type: Optional[str] = None
    capacity: Optional[float] = None
    state: Optional[str] = None
    status: Optional[str] = None
    efficiency: Optional[float] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    location_name: Optional[str] = None


class PlantResponse(PlantBase):
    id: int
    lastUpdated: Optional[datetime] = None

    class Config:
        from_attributes = True


# Schedule Schemas
class ScheduleBase(BaseModel):
    plantName: str
    type: str
    scheduleDate: date
    capacity: float
    forecasted: Optional[float] = 0.0
    actual: Optional[float] = 0.0
    status: Optional[str] = "Pending"
    deviation: Optional[float] = 0.0


class ScheduleBlockData(BaseModel):
    """Schema for individual time block data"""
    block: int
    time: str  # HH:MM format
    forecasted: Optional[float] = 0.0
    actual: Optional[float] = 0.0
    scheduled: Optional[float] = 0.0


class ScheduleCreate(BaseModel):
    plantName: str
    type: str
    scheduleDate: date
    capacity: float
    forecasted: Optional[float] = 0.0
    actual: Optional[float] = 0.0
    status: Optional[str] = "Pending"
    deviation: Optional[float] = 0.0
    # Optional: Include block-level data for 96 time blocks
    blockData: Optional[Dict[str, Any]] = None


class ScheduleUpdate(BaseModel):
    plantName: Optional[str] = None
    type: Optional[str] = None
    scheduleDate: Optional[date] = None
    capacity: Optional[float] = None
    forecasted: Optional[float] = None
    actual: Optional[float] = None
    status: Optional[str] = None
    deviation: Optional[float] = None
    blockData: Optional[Dict[str, Any]] = None


class ScheduleResponse(ScheduleBase):
    id: int
    createdAt: Optional[datetime] = None
    blockData: Optional[Dict[str, Any]] = None

    class Config:
        from_attributes = True
    
    @classmethod
    def from_orm(cls, obj):
        # Call parent from_orm first
        result = super().from_orm(obj)
        # Convert blockData from JSON string to dict if needed
        if hasattr(obj, 'blockData') and obj.blockData:
            try:
                import json
                if isinstance(obj.blockData, str):
                    result.blockData = json.loads(obj.blockData)
                elif isinstance(obj.blockData, dict):
                    result.blockData = obj.blockData
            except (json.JSONDecodeError, TypeError):
                result.blockData = None
        return result


# Forecast Schemas
class ForecastBase(BaseModel):
    plantId: int
    plantName: str
    forecastDate: date
    hourlyData: Optional[Dict[str, Any]] = None


class ForecastCreate(ForecastBase):
    pass


class ForecastResponse(ForecastBase):
    id: int
    createdAt: Optional[datetime] = None

    class Config:
        from_attributes = True


# Weather Schemas
class WeatherBase(BaseModel):
    location: str
    temperature: Optional[float] = None
    humidity: Optional[float] = None
    windSpeed: Optional[float] = None
    cloudCover: Optional[float] = None
    pressure: Optional[float] = None
    visibility: Optional[float] = None
    forecast: Optional[Dict[str, Any]] = None


class WeatherCreate(WeatherBase):
    pass


class WeatherResponse(WeatherBase):
    id: int
    lastUpdated: Optional[datetime] = None

    class Config:
        from_attributes = True


# Deviation Schemas
class DeviationBase(BaseModel):
    hour: int
    deviation: float
    forecasted: float
    actual: float
    plantId: Optional[int] = None


class DeviationCreate(DeviationBase):
    pass


class DeviationResponse(DeviationBase):
    id: int
    createdAt: Optional[datetime] = None

    class Config:
        from_attributes = True


# Report Schemas
class ReportBase(BaseModel):
    name: str
    type: str
    format: str
    generatedDate: date = Field(default_factory=date.today)
    size: Optional[str] = None
    status: Optional[str] = "Generating"
    filePath: Optional[str] = None


class ReportCreate(ReportBase):
    pass


class ReportResponse(ReportBase):
    id: int
    createdAt: Optional[datetime] = None

    class Config:
        from_attributes = True


# Template Schemas
class TemplateBase(BaseModel):
    name: str
    vendor: str
    type: str
    lastModified: date
    status: Optional[str] = "Active"
    filePath: Optional[str] = None


class TemplateCreate(TemplateBase):
    pass


class TemplateResponse(TemplateBase):
    id: int
    createdAt: Optional[datetime] = None

    class Config:
        from_attributes = True


# Dashboard Stats Schema
class DashboardStats(BaseModel):
    activePlants: int
    totalCapacity: float
    currentGeneration: float
    efficiency: float
    windCapacity: float
    solarCapacity: float


# WhatsApp Data Schemas
class WhatsAppDataBase(BaseModel):
    plantId: int
    plantName: str
    state: str
    date: date
    time: str  # HH:MM format
    currentGeneration: float
    expectedTrend: str  # Increasing, Stable, Decreasing
    curtailmentStatus: bool = False
    curtailmentReason: Optional[str] = None
    weatherCondition: Optional[str] = None
    inverterAvailability: Optional[float] = None
    remarks: Optional[str] = None
    status: Optional[str] = "Pending Review"


class WhatsAppDataCreate(WhatsAppDataBase):
    pass


class WhatsAppDataUpdate(BaseModel):
    currentGeneration: Optional[float] = None
    expectedTrend: Optional[str] = None
    curtailmentStatus: Optional[bool] = None
    curtailmentReason: Optional[str] = None
    weatherCondition: Optional[str] = None
    inverterAvailability: Optional[float] = None
    remarks: Optional[str] = None
    status: Optional[str] = None


class WhatsAppDataResponse(WhatsAppDataBase):
    id: int
    createdAt: Optional[datetime] = None
    updatedAt: Optional[datetime] = None

    class Config:
        from_attributes = True


# Meter Data Schemas
class MeterDataBase(BaseModel):
    plantId: int
    plantName: str
    dataDate: date
    blockData: Dict[str, Any]  # 96 blocks of 15-min data
    source: Optional[str] = "SCADA"
    lastReading: Optional[datetime] = None
    dataPoints: Optional[int] = 96
    delay: Optional[int] = None


class MeterDataCreate(MeterDataBase):
    pass


class MeterDataUpdate(BaseModel):
    blockData: Optional[Dict[str, Any]] = None
    lastReading: Optional[datetime] = None
    dataPoints: Optional[int] = None
    delay: Optional[int] = None


class MeterDataResponse(MeterDataBase):
    id: int
    createdAt: Optional[datetime] = None
    updatedAt: Optional[datetime] = None

    class Config:
        from_attributes = True


# ==================== SCHEDULE READINESS SCHEMAS ====================
class ScheduleReadinessBase(BaseModel):
    plant_id: int
    plant_name: str
    status: Optional[str] = "PENDING"
    schedule_date: Optional[date] = None
    revision_number: Optional[int] = 0
    trigger_reason: Optional[str] = None


class ScheduleReadinessCreate(ScheduleReadinessBase):
    pass


class ScheduleReadinessUpdate(BaseModel):
    status: Optional[str] = None
    schedule_date: Optional[date] = None
    revision_number: Optional[int] = None
    trigger_reason: Optional[str] = None
    upload_deadline: Optional[datetime] = None


class ScheduleReadinessResponse(ScheduleReadinessBase):
    id: int
    last_checked: Optional[datetime] = None
    next_check_due: Optional[datetime] = None
    upload_deadline: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class ScheduleReadinessSummary(BaseModel):
    """Summary of all plant readiness statuses"""
    total_plants: int
    ready_count: int
    pending_count: int
    no_action_count: int
    plants: List[ScheduleReadinessResponse]


# ==================== SCHEDULE TRIGGER SCHEMAS ====================
class ScheduleTriggerBase(BaseModel):
    plant_id: int
    trigger_type: str  # Weather, Curtailment, Deviation, Manual
    severity: Optional[str] = "LOW"
    description: Optional[str] = None
    threshold_value: Optional[float] = None
    actual_value: Optional[float] = None


class ScheduleTriggerCreate(ScheduleTriggerBase):
    pass


class ScheduleTriggerResponse(ScheduleTriggerBase):
    id: int
    acknowledged: bool
    processed: bool
    created_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# ==================== SCHEDULE NOTIFICATION SCHEMAS ====================
class ScheduleNotificationBase(BaseModel):
    plant_id: int
    plant_name: str
    notification_type: str  # Schedule Ready, Deadline Warning, Trigger Alert
    title: str
    message: Optional[str] = None
    priority: Optional[str] = "NORMAL"
    action_required: Optional[bool] = True


class ScheduleNotificationCreate(ScheduleNotificationBase):
    pass


class ScheduleNotificationUpdate(BaseModel):
    read: Optional[bool] = None
    action_required: Optional[bool] = None


class ScheduleNotificationResponse(ScheduleNotificationBase):
    id: int
    read: bool
    deadline: Optional[datetime] = None
    created_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class NotificationListResponse(BaseModel):
    """Response for list of notifications"""
    notifications: List[ScheduleNotificationResponse]
    total: int
    unread_count: int


# ==================== TRIGGER CHECK RESULT SCHEMAS ====================
class TriggerCheckResult(BaseModel):
    """Result of triggering schedule check"""
    success: bool
    message: str
    plants_checked: int
    ready_count: int
    pending_count: int
    no_action_count: int
    triggers_created: int


class ManualTriggerRequest(BaseModel):
    """Request to manually trigger schedule revision"""
    reason: Optional[str] = "Manual trigger from dashboard"


class ContinueScheduleRequest(BaseModel):
    """Request to continue existing schedule"""
    pass


class MarkReadyRequest(BaseModel):
    """Request to mark schedule as ready"""
    upload_deadline: Optional[datetime] = None
