"""
Schedule Readiness Service
Handles site-wise asynchronous schedule preparation logic
"""
import json
import math
from datetime import datetime, date, timedelta
from typing import Optional, Dict, Any, List
from sqlalchemy.orm import Session
from sqlalchemy import func

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from models import ScheduleReadiness, ScheduleTrigger, ScheduleNotification, Plant, MeterData, Weather, WhatsAppData


class ScheduleReadinessService:
    """Service for checking schedule readiness and triggers per site"""
    
    # Configuration thresholds
    DEVIATION_THRESHOLD = 10.0  # % deviation to trigger revision
    WEATHER_CHANGE_THRESHOLD = 15.0  # % change in forecast to trigger
    CURTAILMENT_SIGNAL = True  # Any curtailment triggers revision
    UPLOAD_DEADLINE_HOURS = 4  # Hours deadline after schedule becomes READY
    
    def __init__(self, db: Session):
        self.db = db
    
    def check_all_plants(self) -> Dict[str, int]:
        """
        Check all plants for schedule readiness triggers.
        Returns summary of status counts.
        """
        plants = self.db.query(Plant).all()
        
        status_counts = {
            'READY': 0,
            'PENDING': 0,
            'NO_ACTION': 0
        }
        
        for plant in plants:
            self.check_plant_readiness(plant.id)
            # Get updated status
            readiness = self.get_plant_readiness(plant.id)
            if readiness:
                status_counts[readiness.status] += 1
        
        self.db.commit()
        return status_counts
    
    def check_plant_readiness(self, plant_id: int) -> ScheduleReadiness:
        """
        Check a plant's schedule readiness status.
        
        Algorithm:
        1. Check if schedule directory has updated files
        2. Check for triggers (weather, curtailment, deviation)
        3. Update status accordingly
        """
        plant = self.db.query(Plant).filter(Plant.id == plant_id).first()
        if not plant:
            return None
        
        # Get existing readiness or create new
        readiness = self.db.query(ScheduleReadiness).filter(
            ScheduleReadiness.plant_id == plant_id
        ).first()
        
        if not readiness:
            readiness = ScheduleReadiness(
                plant_id=plant_id,
                plant_name=plant.name,
                status="NO_ACTION",
                schedule_date=date.today()
            )
            self.db.add(readiness)
            self.db.commit()
            self.db.refresh(readiness)
        
        # Check for triggers
        weather_trigger = self._check_weather_change(plant_id)
        curtailment_trigger = self._check_curtailment(plant_id)
        deviation_trigger = self._check_deviation(plant_id)
        
        # Collect active triggers
        active_triggers = [t for t in [weather_trigger, curtailment_trigger, deviation_trigger] if t]
        has_active_triggers = len(active_triggers) > 0
        
        # Check for updated schedule files (simulated - in production, check actual directory)
        has_updated_files = self._check_schedule_files(plant_id)
        
        # Determine status
        new_status = self._determine_status(has_updated_files, has_active_triggers)
        
        # Determine trigger reason if status is PENDING
        trigger_reason = None
        if new_status == "PENDING" and active_triggers:
            trigger_types = list(set([t.trigger_type for t in active_triggers]))
            trigger_reason = ", ".join(trigger_types)
            
            # Create notifications for triggers
            for trigger in active_triggers:
                self._create_notification(plant_id, plant.name, trigger)
        
        # Update readiness record
        old_status = readiness.status
        readiness.status = new_status
        readiness.last_checked = datetime.now()
        readiness.trigger_reason = trigger_reason
        
        # If status changed to READY, set upload deadline
        if new_status == "READY" and old_status != "READY":
            readiness.upload_deadline = datetime.now() + timedelta(hours=self.UPLOAD_DEADLINE_HOURS)
            readiness.revision_number = readiness.revision_number + 1
            
            # Create notification for READY status
            self._create_ready_notification(plant_id, plant.name, readiness.upload_deadline)
        
        # If status changed to NO_ACTION, clear trigger reason
        if new_status == "NO_ACTION":
            readiness.trigger_reason = None
        
        self.db.commit()
        self.db.refresh(readiness)
        
        return readiness
    
    def _check_schedule_files(self, plant_id: int) -> bool:
        """
        Check if updated schedule files exist for a plant.
        In production, this would check the actual file directory.
        """
        # Simulated check - in production, check:
        # - uploads/schedules/{plant_id}/
        # - Look for files with recent timestamp
        
        # For now, return False (no updated files)
        # This would be replaced with actual file system check
        return False
    
    def _check_deviation(self, plant_id: int) -> Optional[ScheduleTrigger]:
        """
        Check meter data for significant deviations.
        
        Uses meter data for CURRENT block only.
        Returns trigger if deviation exceeds threshold.
        """
        # Get latest meter data
        meter_data = self.db.query(MeterData).filter(
            MeterData.plantId == plant_id
        ).order_by(MeterData.dataDate.desc(), MeterData.createdAt.desc()).first()
        
        if not meter_data:
            return None
        
        # Parse block data
        try:
            block_data = json.loads(meter_data.blockData) if isinstance(meter_data.blockData, str) else meter_data.blockData
        except (json.JSONDecodeError, TypeError):
            return None
        
        if not block_data:
            return None
        
        # Get current time block (now)
        current_hour = datetime.now().hour
        current_minute = (datetime.now().minute // 15) * 15
        current_block_key = f"block_{current_hour * 4 + current_minute // 15 + 1}"
        
        current_block = block_data.get(current_block_key, {})
        
        if not current_block:
            return None
        
        # Calculate deviation
        generation = current_block.get('generation', 0)
        scheduled = current_block.get('scheduled', 0)
        
        if scheduled == 0:
            return None
        
        deviation_percent = ((generation - scheduled) / scheduled) * 100
        
        if abs(deviation_percent) >= self.DEVIATION_THRESHOLD:
            # Create trigger record
            trigger = ScheduleTrigger(
                plant_id=plant_id,
                trigger_type="Deviation",
                severity="HIGH" if abs(deviation_percent) >= 20 else "MEDIUM",
                description=f"Meter deviation of {deviation_percent:.1f}% detected",
                threshold_value=self.DEVIATION_THRESHOLD,
                actual_value=deviation_percent
            )
            self.db.add(trigger)
            self.db.commit()
            
            return trigger
        
        return None
    
    def _check_weather_change(self, plant_id: int) -> Optional[ScheduleTrigger]:
        """
        Check for significant weather forecast changes.
        
        Uses forecast data for FUTURE blocks.
        Returns trigger if change exceeds threshold.
        """
        # Get current weather
        weather = self.db.query(Weather).filter(
            Weather.location == f"Plant_{plant_id}"
        ).first()
        
        if not weather:
            return None
        
        # Parse forecast data
        try:
            forecast_data = json.loads(weather.forecast) if isinstance(weather.forecast, str) else weather.forecast
        except (json.JSONDecodeError, TypeError):
            return None
        
        if not forecast_data:
            return None
        
        # Get plant type to determine relevant weather parameter
        plant = self.db.query(Plant).filter(Plant.id == plant_id).first()
        if not plant:
            return None
        
        if plant.type == "Wind":
            # Check wind speed change
            current_wind = weather.windSpeed or 0
            forecast_wind = forecast_data.get('windSpeed', current_wind)
            
            if forecast_wind > 0:
                wind_change = ((forecast_wind - current_wind) / current_wind) * 100 if current_wind > 0 else 0
                
                if abs(wind_change) >= self.WEATHER_CHANGE_THRESHOLD:
                    trigger = ScheduleTrigger(
                        plant_id=plant_id,
                        trigger_type="Weather",
                        severity="HIGH" if abs(wind_change) >= 25 else "MEDIUM",
                        description=f"Wind forecast change of {wind_change:.1f}% detected",
                        threshold_value=self.WEATHER_CHANGE_THRESHOLD,
                        actual_value=wind_change
                    )
                    self.db.add(trigger)
                    self.db.commit()
                    return trigger
        else:
            # Solar - check cloud cover change
            current_cloud = weather.cloudCover or 0
            forecast_cloud = forecast_data.get('cloudCover', current_cloud)
            
            if current_cloud > 0:
                cloud_change = ((forecast_cloud - current_cloud) / current_cloud) * 100
                
                if abs(cloud_change) >= self.WEATHER_CHANGE_THRESHOLD:
                    trigger = ScheduleTrigger(
                        plant_id=plant_id,
                        trigger_type="Weather",
                        severity="HIGH" if abs(cloud_change) >= 25 else "MEDIUM",
                        description=f"Cloud cover forecast change of {cloud_change:.1f}% detected",
                        threshold_value=self.WEATHER_CHANGE_THRESHOLD,
                        actual_value=cloud_change
                    )
                    self.db.add(trigger)
                    self.db.commit()
                    return trigger
        
        return None
    
    def _check_curtailment(self, plant_id: int) -> Optional[ScheduleTrigger]:
        """
        Check for curtailment signals.
        
        Returns trigger if curtailment is active.
        """
        # Check WhatsApp data for curtailment status
        whatsapp_data = self.db.query(WhatsAppData).filter(
            WhatsAppData.plantId == plant_id
        ).order_by(WhatsAppData.createdAt.desc()).first()
        
        if not whatsapp_data:
            return None
        
        if whatsapp_data.curtailmentStatus:
            trigger = ScheduleTrigger(
                plant_id=plant_id,
                trigger_type="Curtailment",
                severity="CRITICAL",
                description=f"Curtailment active: {whatsapp_data.curtailmentReason or 'No reason specified'}",
                actual_value=1
            )
            self.db.add(trigger)
            self.db.commit()
            return trigger
        
        return None
    
    def _determine_status(
        self,
        has_updated_files: bool,
        has_active_triggers: bool
    ) -> str:
        """
        Determine schedule status based on conditions.
        
        Returns:
        - READY: Updated schedule files exist
        - NO_ACTION: No triggers, continue existing schedule
        - PENDING: Triggers detected, awaiting action
        """
        if has_updated_files:
            return "READY"
        elif has_active_triggers:
            return "PENDING"
        else:
            return "NO_ACTION"
    
    def _create_notification(
        self,
        plant_id: int,
        plant_name: str,
        trigger: ScheduleTrigger
    ) -> ScheduleNotification:
        """Create notification for a trigger event"""
        # Check if notification already exists for this trigger
        existing = self.db.query(ScheduleNotification).filter(
            ScheduleNotification.plant_id == plant_id,
            ScheduleNotification.notification_type == "Trigger Alert",
            ScheduleNotification.created_at > datetime.now() - timedelta(hours=1)
        ).first()
        
        if existing:
            return existing
        
        title_map = {
            "Weather": "Weather Change Detected",
            "Curtailment": "Curtailment Signal Active",
            "Deviation": "Meter Deviation Detected"
        }
        
        message_map = {
            "Weather": f"Weather forecast change detected for {plant_name}. Schedule revision may be required.",
            "Curtailment": f"Curtailment signal active for {plant_name}. {trigger.description}",
            "Deviation": f"Meter deviation of {trigger.actual_value:.1f}% detected for {plant_name}."
        }
        
        notification = ScheduleNotification(
            plant_id=plant_id,
            plant_name=plant_name,
            notification_type="Trigger Alert",
            title=title_map.get(trigger.trigger_type, "Trigger Detected"),
            message=message_map.get(trigger.trigger_type, trigger.description),
            priority="HIGH" if trigger.severity in ["HIGH", "CRITICAL"] else "NORMAL",
            action_required=True
        )
        
        self.db.add(notification)
        self.db.commit()
        
        return notification
    
    def _create_ready_notification(
        self,
        plant_id: int,
        plant_name: str,
        deadline: datetime
    ) -> ScheduleNotification:
        """Create notification when schedule becomes READY"""
        notification = ScheduleNotification(
            plant_id=plant_id,
            plant_name=plant_name,
            notification_type="Schedule Ready",
            title="Schedule Ready for Upload",
            message=f"Updated schedule for {plant_name} is ready for upload. Deadline: {deadline.strftime('%Y-%m-%d %H:%M')}",
            priority="URGENT",
            action_required=True,
            deadline=deadline
        )
        
        self.db.add(notification)
        self.db.commit()
        
        return notification
    
    def trigger_manual_revision(
        self,
        plant_id: int,
        reason: str = "Manual Trigger"
    ) -> ScheduleReadiness:
        """Manually trigger schedule revision for a plant"""
        # Create a manual trigger
        trigger = ScheduleTrigger(
            plant_id=plant_id,
            trigger_type="Manual",
            severity="MEDIUM",
            description=f"Manual revision triggered: {reason}"
        )
        self.db.add(trigger)
        
        # Check and update readiness
        readiness = self.check_plant_readiness(plant_id)
        
        return readiness
    
    def continue_existing_schedule(self, plant_id: int) -> ScheduleReadiness:
        """Continue with existing (day-ahead) schedule - clears triggers"""
        plant = self.db.query(Plant).filter(Plant.id == plant_id).first()
        if not plant:
            return None
        
        # Acknowledge all triggers for this plant
        self.db.query(ScheduleTrigger).filter(
            ScheduleTrigger.plant_id == plant_id,
            ScheduleTrigger.processed == False
        ).update({
            "acknowledged": True,
            "processed": True
        })
        
        # Update readiness to NO_ACTION
        readiness = self.db.query(ScheduleReadiness).filter(
            ScheduleReadiness.plant_id == plant_id
        ).first()
        
        if readiness:
            readiness.status = "NO_ACTION"
            readiness.trigger_reason = None
            readiness.last_checked = datetime.now()
            self.db.commit()
            self.db.refresh(readiness)
        
        return readiness
    
    def mark_schedule_ready(
        self,
        plant_id: int,
        upload_deadline: Optional[datetime] = None
    ) -> ScheduleReadiness:
        """Mark schedule as ready for upload"""
        plant = self.db.query(Plant).filter(Plant.id == plant_id).first()
        if not plant:
            return None
        
        readiness = self.db.query(ScheduleReadiness).filter(
            ScheduleReadiness.plant_id == plant_id
        ).first()
        
        if not readiness:
            readiness = ScheduleReadiness(
                plant_id=plant_id,
                plant_name=plant.name,
                status="READY"
            )
            self.db.add(readiness)
        
        readiness.status = "READY"
        readiness.upload_deadline = upload_deadline or (datetime.now() + timedelta(hours=self.UPLOAD_DEADLINE_HOURS))
        readiness.revision_number = readiness.revision_number + 1
        readiness.last_checked = datetime.now()
        
        # Create notification
        self._create_ready_notification(plant_id, plant.name, readiness.upload_deadline)
        
        self.db.commit()
        self.db.refresh(readiness)
        
        return readiness
    
    def get_plant_readiness(self, plant_id: int) -> Optional[ScheduleReadiness]:
        """Get plant's current schedule readiness status"""
        return self.db.query(ScheduleReadiness).filter(
            ScheduleReadiness.plant_id == plant_id
        ).first()
    
    def get_all_readiness(self, status_filter: Optional[str] = None) -> List[ScheduleReadiness]:
        """Get all plant readiness statuses"""
        query = self.db.query(ScheduleReadiness)
        
        if status_filter and status_filter != 'All':
            query = query.filter(ScheduleReadiness.status == status_filter)
        
        return query.order_by(ScheduleReadiness.updated_at.desc()).all()
    
    def get_notifications(
        self,
        unread_only: bool = False,
        plant_id: Optional[int] = None
    ) -> List[ScheduleNotification]:
        """Get pending notifications"""
        query = self.db.query(ScheduleNotification)
        
        if unread_only:
            query = query.filter(ScheduleNotification.read == False)
        
        if plant_id:
            query = query.filter(ScheduleNotification.plant_id == plant_id)
        
        return query.order_by(
            ScheduleNotification.created_at.desc()
        ).all()
    
    def mark_notification_read(self, notification_id: int) -> Optional[ScheduleNotification]:
        """Mark a notification as read"""
        notification = self.db.query(ScheduleNotification).filter(
            ScheduleNotification.id == notification_id
        ).first()
        
        if notification:
            notification.read = True
            self.db.commit()
            self.db.refresh(notification)
        
        return notification


def calculate_block_deviation(
    meter_data: Dict[str, Any],
    forecast_data: Dict[str, Any],
    block_number: int
) -> float:
    """
    Calculate deviation for a specific time block.
    
    Uses meter data for CURRENT block.
    Uses forecast data for FUTURE blocks.
    """
    block_key = f"block_{block_number}"
    
    meter_block = meter_data.get(block_key, {})
    forecast_block = forecast_data.get(block_key, {})
    
    meter_value = meter_block.get('generation', 0)
    forecast_value = forecast_block.get('forecast', 0)
    
    if forecast_value == 0:
        return 0.0
    
    return ((meter_value - forecast_value) / forecast_value) * 100


def generate_revision_schedule(
    plant_id: int,
    db: Session,
    current_meter_data: Dict[str, Any],
    forecast_data: Dict[str, Any],
    weather_data: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Generate revised schedule for a plant.
    
    Algorithm:
    - Current block: Use actual meter data
    - Future blocks: Use forecast + weather adjustment
    - Normal sites: Continue existing schedule
    - Exception sites: Generate new schedule
    """
    block_data = {}
    
    for i in range(1, 97):  # 96 blocks
        block_key = f"block_{i}"
        
        if i <= 4:  # Current/future blocks - use forecast + weather
            forecast = forecast_data.get(block_key, {}).get('forecast', 0)
            scheduled = forecast
            
            # Apply weather adjustment if available
            if weather_data:
                weather_factor = weather_data.get('adjustment_factor', 1.0)
                scheduled = scheduled * weather_factor
            
            block_data[block_key] = {
                'block': i,
                'time': _get_block_time(i),
                'forecast': forecast,
                'actual': current_meter_data.get(block_key, {}).get('generation', forecast),
                'scheduled': round(scheduled, 2),
                'source': 'forecast'
            }
        else:  # Future blocks - use forecast only
            forecast = forecast_data.get(block_key, {}).get('forecast', 0)
            
            block_data[block_key] = {
                'block': i,
                'time': _get_block_time(i),
                'forecast': forecast,
                'actual': 0,
                'scheduled': round(forecast, 2),
                'source': 'forecast'
            }
    
    return {
        'plant_id': plant_id,
        'schedule_date': date.today().isoformat(),
        'total_blocks': 96,
        'block_data': block_data,
        'generated_at': datetime.now().isoformat()
    }


def _get_block_time(block_number: int) -> str:
    """Convert block number to time string (HH:MM)"""
    hour = (block_number - 1) // 4
    minute = ((block_number - 1) % 4) * 15
    return f"{hour:02d}:{minute:02d}"

