"""
SQLAlchemy database models
"""
from sqlalchemy import Column, Integer, String, Float, Date, DateTime, Text, Boolean
from sqlalchemy import LargeBinary
from sqlalchemy.sql import func
from sqlalchemy import UniqueConstraint
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
    penalty_threshold_percent = Column(Float, nullable=True)
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


class AutoUploadSlotUsage(Base):
    """Persist auto-upload slot usage so it works without a browser session."""
    __tablename__ = "auto_upload_slot_usage"
    __table_args__ = (
        UniqueConstraint("plant_code", "schedule_date", "slot_index", name="uq_auto_upload_slot_usage"),
    )

    id = Column(Integer, primary_key=True, index=True)
    plant_code = Column(String(32), nullable=False, index=True)
    schedule_date = Column(Date, nullable=False, index=True)
    slot_index = Column(Integer, nullable=False, index=True)
    schedule_key = Column(String(1024), nullable=True)
    trigger_reason = Column(String(255), nullable=True)
    decision = Column(String(50), nullable=False, default="USED")  # USED | SKIPPED | UPLOADED
    freeze_time = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class TemplateTransformRun(Base):
    """Audit row per template transformation run"""
    __tablename__ = "template_transform_runs"

    id = Column(Integer, primary_key=True, index=True)
    plant_id = Column(Integer, nullable=False, index=True)
    run_date = Column(Date, nullable=False, index=True)
    source_file_key = Column(String(1024), nullable=False)
    source_hash = Column(String(128), nullable=False)
    template_id = Column(String(255), nullable=False)
    template_version = Column(String(64), nullable=False)
    status = Column(String(50), nullable=False, index=True)  # PREVIEW_FAILED | PREVIEW_VALID | GENERATED
    validation_errors = Column(Text, nullable=True)  # JSON array
    output_file_key = Column(String(1024), nullable=True)
    output_file_url = Column(String(1024), nullable=True)
    requested_by = Column(String(255), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class EmailSchedulerJob(Base):
    __tablename__ = "email_scheduler_jobs"

    id = Column(Integer, primary_key=True, index=True)

    requested_by = Column(String(128), nullable=True, index=True)
    role = Column(String(32), nullable=True, index=True)  # admin | testing

    template_id = Column(String(255), nullable=False, index=True)
    plant_code = Column(String(64), nullable=False, index=True)

    scheduled_at = Column(DateTime(timezone=True), nullable=False, index=True)
    auto_send = Column(Boolean, default=False)

    from_email = Column(String(255), nullable=False)
    to_email = Column(Text, nullable=False)  # can be comma-separated
    cc_email = Column(Text, nullable=True)
    employee_name = Column(String(255), nullable=True)

    subject = Column(Text, nullable=False)
    body = Column(Text, nullable=False)

    portal_issue = Column(Boolean, default=False)
    dsm_summary_payload = Column(Text, nullable=True)  # JSON

    schedule_attachment_name = Column(String(500), nullable=True)
    schedule_attachment_bytes = Column(LargeBinary, nullable=True)

    attachment_name = Column(String(500), nullable=True)
    attachment_bytes = Column(LargeBinary, nullable=True)
    attachment_content_type = Column(String(255), nullable=True)

    status = Column(String(50), default="SCHEDULED", index=True)  # SCHEDULED | SENT | FAILED | CANCELED
    sent_at = Column(DateTime(timezone=True), nullable=True)
    error_message = Column(Text, nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class EmailSendLog(Base):
    __tablename__ = "email_send_logs"

    id = Column(Integer, primary_key=True, index=True)

    requested_by = Column(String(128), nullable=True, index=True)  # username/empId from UI header
    employee_name = Column(String(255), nullable=True)
    role = Column(String(32), nullable=True, index=True)  # admin | testing

    template_id = Column(String(255), nullable=True, index=True)
    plant_code = Column(String(64), nullable=True, index=True)
    category = Column(String(64), nullable=True)
    mode = Column(String(64), nullable=True, index=True)  # SEND_NOW | SCHEDULE | DISPATCHER

    from_email = Column(String(255), nullable=True)
    to_email = Column(Text, nullable=True)
    cc_email = Column(Text, nullable=True)
    subject = Column(Text, nullable=True)

    scheduled_at = Column(DateTime(timezone=True), nullable=True, index=True)
    sent_at = Column(DateTime(timezone=True), nullable=True, index=True)

    status = Column(String(50), nullable=False, index=True)  # SCHEDULED | SENT | FAILED
    error_message = Column(Text, nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)


class EmailSchedulerSetting(Base):
    __tablename__ = "email_scheduler_settings"

    id = Column(Integer, primary_key=True, index=True)
    key = Column(String(128), nullable=False, unique=True, index=True)
    value_text = Column(Text, nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class SiteMessageLog(Base):
    __tablename__ = "site_message_logs"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(128), nullable=True, index=True)
    user_role = Column(String(32), nullable=True, index=True)
    site_id = Column(String(64), nullable=False, index=True)
    site_id_raw = Column(String(255), nullable=True)
    event_type = Column(String(64), nullable=False, index=True)
    raw_message = Column(Text, nullable=False)
    event_date = Column(Date, nullable=False, index=True)
    start_time = Column(String(16), nullable=True)
    end_time = Column(String(16), nullable=True)
    mw = Column(Float, nullable=True)
    unit = Column(String(32), nullable=True)
    reduction_type = Column(String(32), nullable=True)
    description = Column(Text, nullable=True)
    dynamodb_table = Column(String(255), nullable=True)
    dynamodb_window_id = Column(String(1024), nullable=True)
    status = Column(String(32), nullable=False, default="SUCCESS", index=True)
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)


class DocumentationDocument(Base):
    """Portal documentation files stored in PostgreSQL."""
    __tablename__ = "documentation_documents"

    id = Column(String(64), primary_key=True, index=True)
    filename = Column(String(512), nullable=False)
    content_type = Column(String(255), nullable=False, default="application/octet-stream")
    size = Column(Integer, nullable=False, default=0)
    file_data = Column(LargeBinary, nullable=False)
    uploaded_by = Column(String(255), nullable=True)
    role = Column(String(50), nullable=True)
    access_category = Column(String(50), nullable=False, default="everyone")
    uploaded_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False, index=True)


class VedanjayScheduleUpload(Base):
    """Immutable Vedanjay schedule upload history stored entirely in PostgreSQL."""
    __tablename__ = "vedanjay_schedule_uploads"
    __table_args__ = (
        UniqueConstraint("plant_code", "schedule_date", "file_hash", name="uq_vedanjay_upload_file"),
    )

    id = Column(Integer, primary_key=True, index=True)
    plant_code = Column(String(32), nullable=False, index=True)
    plant_name = Column(String(255), nullable=False)
    schedule_date = Column(Date, nullable=False, index=True)
    filename = Column(String(500), nullable=False)
    storage_key = Column(String(1024), nullable=False)
    uploader = Column(String(255), nullable=True)
    uploaded_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    file_hash = Column(String(64), nullable=False, index=True)
    original_content_type = Column(String(255), nullable=True)
    original_file = Column(LargeBinary, nullable=False)
    normalized_blocks_json = Column(Text, nullable=False)
    is_active = Column(Boolean, nullable=False, default=True, index=True)
    validation_status = Column(String(50), nullable=False, default="VALID")
    validation_message = Column(Text, nullable=True)


class DailyPenaltySummary(Base):
    """One cached daily result for a plant, date, and schedule source."""
    __tablename__ = "daily_penalty_summaries"
    __table_args__ = (
        UniqueConstraint(
            "plant_code",
            "schedule_date",
            "schedule_source",
            name="uq_daily_penalty_source",
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    plant_code = Column(String(32), nullable=False, index=True)
    plant_name = Column(String(255), nullable=False)
    state = Column(String(100), nullable=True)
    capacity_mw = Column(Float, nullable=True)
    schedule_date = Column(Date, nullable=False, index=True)
    schedule_source = Column(String(32), nullable=False, index=True)
    total_penalty = Column(Float, nullable=True)
    status = Column(String(50), nullable=False, index=True)
    missing_data_reason = Column(Text, nullable=True)
    observation = Column(Text, nullable=True)
    calculated_blocks = Column(Integer, nullable=False, default=0)
    highest_penalty_block = Column(Integer, nullable=True)
    highest_penalty_amount = Column(Float, nullable=True)
    schedule_file = Column(String(1024), nullable=True)
    schedule_hash = Column(String(64), nullable=True)
    meter_file = Column(String(1024), nullable=True)
    meter_hash = Column(String(64), nullable=True)
    calculation_version = Column(String(64), nullable=False)
    upload_id = Column(Integer, nullable=True, index=True)
    calculated_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class BlockPenaltyResult(Base):
    """Block-wise details behind a daily penalty summary."""
    __tablename__ = "block_penalty_results"
    __table_args__ = (
        UniqueConstraint("summary_id", "block_number", name="uq_penalty_summary_block"),
    )

    id = Column(Integer, primary_key=True, index=True)
    summary_id = Column(Integer, nullable=False, index=True)
    plant_code = Column(String(32), nullable=False, index=True)
    schedule_date = Column(Date, nullable=False, index=True)
    schedule_source = Column(String(32), nullable=False, index=True)
    block_number = Column(Integer, nullable=False)
    scheduled_mw = Column(Float, nullable=True)
    actual_meter_mw = Column(Float, nullable=True)
    deviation_mw = Column(Float, nullable=True)
    deviation_percent = Column(Float, nullable=True)
    penalty_amount = Column(Float, nullable=True)
    payable_amount = Column(Float, nullable=True)
    receivable_amount = Column(Float, nullable=True)
    net_settlement = Column(Float, nullable=True)
    ppa_amount = Column(Float, nullable=True)
    status = Column(String(50), nullable=False)
    missing_data_reason = Column(Text, nullable=True)


class GeneratedPenaltyReport(Base):
    """Generated all-plant report history and binary artifacts."""
    __tablename__ = "generated_penalty_reports"

    id = Column(Integer, primary_key=True, index=True)
    report_type = Column(String(20), nullable=False, index=True)
    start_date = Column(Date, nullable=False, index=True)
    end_date = Column(Date, nullable=False, index=True)
    requested_formats = Column(String(50), nullable=False)
    include_block_details = Column(Boolean, nullable=False, default=False)
    status = Column(String(50), nullable=False, default="Generating", index=True)
    requested_by = Column(String(255), nullable=True)
    report_data_json = Column(Text, nullable=True)
    word_filename = Column(String(500), nullable=True)
    word_content = Column(LargeBinary, nullable=True)
    pdf_filename = Column(String(500), nullable=True)
    pdf_content = Column(LargeBinary, nullable=True)
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    completed_at = Column(DateTime(timezone=True), nullable=True)
