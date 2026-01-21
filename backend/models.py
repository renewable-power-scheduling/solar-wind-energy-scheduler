"""
SQLAlchemy database models
"""
from sqlalchemy import Column, Integer, String, Float, Date, DateTime, Text, Boolean
from sqlalchemy.sql import func
from database import Base


class Plant(Base):
    __tablename__ = "plants"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False, index=True)
    type = Column(String(50), nullable=False)  # Wind, Solar
    capacity = Column(Float, nullable=False)
    state = Column(String(100), nullable=False)
    status = Column(String(50), default="Active")  # Active, Maintenance
    efficiency = Column(Float, default=0.0)
    latitude = Column(Float, nullable=True)  # Geographic latitude
    longitude = Column(Float, nullable=True)  # Geographic longitude
    location_name = Column(String(255), nullable=True)  # Human-readable location name
    lastUpdated = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Schedule(Base):
    __tablename__ = "schedules"

    id = Column(Integer, primary_key=True, index=True)
    plantName = Column(String(255), nullable=False, index=True)
    type = Column(String(50), nullable=False)  # Day-Ahead, Intraday
    scheduleDate = Column(Date, nullable=False, index=True)
    capacity = Column(Float, nullable=False)
    forecasted = Column(Float, default=0.0)
    actual = Column(Float, default=0.0)
    status = Column(String(50), default="Pending")  # Pending, Approved, Revised, Completed
    deviation = Column(Float, default=0.0)
    blockData = Column(Text, nullable=True)  # JSON string of 96 time blocks
    createdAt = Column(DateTime(timezone=True), server_default=func.now())


class Forecast(Base):
    __tablename__ = "forecasts"

    id = Column(Integer, primary_key=True, index=True)
    plantId = Column(Integer, nullable=False, index=True)
    plantName = Column(String(255), nullable=False)
    forecastDate = Column(Date, nullable=False, index=True)
    hourlyData = Column(Text)  # JSON string of hourly forecast data
    createdAt = Column(DateTime(timezone=True), server_default=func.now())


class Weather(Base):
    __tablename__ = "weather"

    id = Column(Integer, primary_key=True, index=True)
    location = Column(String(100), nullable=False, index=True)
    temperature = Column(Float)
    humidity = Column(Float)
    windSpeed = Column(Float)
    cloudCover = Column(Float)
    pressure = Column(Float)
    visibility = Column(Float)
    forecast = Column(Text)  # JSON string of forecast data
    lastUpdated = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Deviation(Base):
    __tablename__ = "deviations"

    id = Column(Integer, primary_key=True, index=True)
    hour = Column(Integer, nullable=False)
    deviation = Column(Float, nullable=False)
    forecasted = Column(Float, nullable=False)
    actual = Column(Float, nullable=False)
    plantId = Column(Integer, nullable=True)
    createdAt = Column(DateTime(timezone=True), server_default=func.now())


class Report(Base):
    __tablename__ = "reports"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    type = Column(String(100), nullable=False)  # Performance, Schedule, Deviation, etc.
    format = Column(String(50), nullable=False)  # PDF, Excel, CSV
    generatedDate = Column(Date, nullable=False)
    size = Column(String(50))
    status = Column(String(50), default="Generating")  # Generating, Ready, Failed
    filePath = Column(String(500), nullable=True)
    createdAt = Column(DateTime(timezone=True), server_default=func.now())


class Template(Base):
    __tablename__ = "templates"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    vendor = Column(String(100), nullable=False)
    type = Column(String(50), nullable=False)  # Day-Ahead, Intraday
    lastModified = Column(Date, nullable=False)
    status = Column(String(50), default="Active")  # Active, Inactive
    filePath = Column(String(500), nullable=True)
    createdAt = Column(DateTime(timezone=True), server_default=func.now())


class WhatsAppData(Base):
    __tablename__ = "whatsapp_data"

    id = Column(Integer, primary_key=True, index=True)
    plantId = Column(Integer, nullable=False, index=True)
    plantName = Column(String(255), nullable=False)
    state = Column(String(100), nullable=False)
    date = Column(Date, nullable=False, index=True)
    time = Column(String(10), nullable=False)  # HH:MM format
    currentGeneration = Column(Float, nullable=False)
    expectedTrend = Column(String(50), nullable=False)  # Increasing, Stable, Decreasing
    curtailmentStatus = Column(Boolean, default=False)
    curtailmentReason = Column(String(100), nullable=True)  # Grid Constraint, Weather, Maintenance, Other
    weatherCondition = Column(String(50), nullable=True)  # Clear, Partly Cloudy, Cloudy, Sudden Change
    inverterAvailability = Column(Float, nullable=True)  # Percentage
    remarks = Column(Text, nullable=True)
    status = Column(String(50), default="Pending Review")  # Pending Review, Reviewed, Used
    createdAt = Column(DateTime(timezone=True), server_default=func.now())
    updatedAt = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class MeterData(Base):
    __tablename__ = "meter_data"

    id = Column(Integer, primary_key=True, index=True)
    plantId = Column(Integer, nullable=False, index=True)
    plantName = Column(String(255), nullable=False)
    dataDate = Column(Date, nullable=False, index=True)
    blockData = Column(Text, nullable=False)  # JSON string of 96 blocks (15-min intervals)
    source = Column(String(50), default="SCADA")  # SCADA, Manual Upload
    lastReading = Column(DateTime(timezone=True), nullable=True)
    dataPoints = Column(Integer, default=96)  # Number of data points
    delay = Column(Integer, nullable=True)  # Delay in minutes
    createdAt = Column(DateTime(timezone=True), server_default=func.now())
    updatedAt = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class ScheduleReadiness(Base):
    """Track schedule readiness status per site"""
    __tablename__ = "schedule_readiness"

    id = Column(Integer, primary_key=True, index=True)
    plant_id = Column(Integer, nullable=False, index=True)
    plant_name = Column(String(255), nullable=False)
    status = Column(String(50), default="PENDING")  # READY, PENDING, NO_ACTION
    last_checked = Column(DateTime(timezone=True), server_default=func.now())
    next_check_due = Column(DateTime(timezone=True), nullable=True)
    upload_deadline = Column(DateTime(timezone=True), nullable=True)
    schedule_date = Column(Date, nullable=True)
    revision_number = Column(Integer, default=0)
    trigger_reason = Column(String(255), nullable=True)  # Weather, Curtailment, Deviation
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class ScheduleTrigger(Base):
    """Track trigger events that may cause schedule revision"""
    __tablename__ = "schedule_triggers"

    id = Column(Integer, primary_key=True, index=True)
    plant_id = Column(Integer, nullable=False, index=True)
    trigger_type = Column(String(50), nullable=False)  # Weather, Curtailment, Deviation, Manual
    severity = Column(String(50), default="LOW")  # LOW, MEDIUM, HIGH, CRITICAL
    description = Column(Text, nullable=True)
    threshold_value = Column(Float, nullable=True)
    actual_value = Column(Float, nullable=True)
    acknowledged = Column(Boolean, default=False)
    processed = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class ScheduleNotification(Base):
    """Store notifications for operators"""
    __tablename__ = "schedule_notifications"

    id = Column(Integer, primary_key=True, index=True)
    plant_id = Column(Integer, nullable=False, index=True)
    plant_name = Column(String(255), nullable=False)
    notification_type = Column(String(50), nullable=False)  # Schedule Ready, Deadline Warning, Trigger Alert
    title = Column(String(255), nullable=False)
    message = Column(Text, nullable=True)
    priority = Column(String(50), default="NORMAL")  # LOW, NORMAL, HIGH, URGENT
    read = Column(Boolean, default=False)
    action_required = Column(Boolean, default=True)
    deadline = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
