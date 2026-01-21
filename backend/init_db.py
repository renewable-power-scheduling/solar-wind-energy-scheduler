"""
Initialize database with sample data - PostgreSQL compatible version
"""
from database import SessionLocal, engine, Base
from models import Plant, Schedule, Forecast, Weather, Deviation, Report, Template, WhatsAppData, MeterData
from datetime import date, datetime, timedelta
import json
import os
import math
import random

# Create all tables
print("Creating database tables...")
Base.metadata.create_all(bind=engine)

db = SessionLocal()

try:
    # Check if data already exists
    if db.query(Plant).count() > 0:
        print("Database already initialized with data.")
        exit(0)
    
    print("Seeding sample data...")
    
    # Create sample plants
    plants = [
        Plant(
            name="Wind Farm Alpha",
            type="Wind",
            capacity=500.0,
            state="Maharashtra",
            status="Active",
            efficiency=78.5
        ),
        Plant(
            name="Solar Park Beta",
            type="Solar",
            capacity=300.0,
            state="Gujarat",
            status="Active",
            efficiency=82.3
        ),
        Plant(
            name="Wind Farm Gamma",
            type="Wind",
            capacity=450.0,
            state="Tamil Nadu",
            status="Maintenance",
            efficiency=65.2
        ),
        Plant(
            name="Solar Plant Delta",
            type="Solar",
            capacity=250.0,
            state="Rajasthan",
            status="Active",
            efficiency=75.8
        ),
        Plant(
            name="Wind Farm Epsilon",
            type="Wind",
            capacity=600.0,
            state="Maharashtra",
            status="Active",
            efficiency=80.2
        ),
        Plant(
            name="Solar Plant Zeta",
            type="Solar",
            capacity=350.0,
            state="Gujarat",
            status="Active",
            efficiency=85.1
        ),
    ]
    
    for plant in plants:
        db.add(plant)
    db.commit()
    print(f"Created {len(plants)} plants")
    
    # Create sample schedules
    schedules = [
        Schedule(
            plantName="Wind Farm Alpha",
            type="Day-Ahead",
            scheduleDate=date.today(),
            capacity=500.0,
            forecasted=380.0,
            actual=372.0,
            status="Active",
            deviation=-2.1
        ),
        Schedule(
            plantName="Solar Park Beta",
            type="Intraday",
            scheduleDate=date.today(),
            capacity=300.0,
            forecasted=245.0,
            actual=251.0,
            status="Completed",
            deviation=2.4
        ),
    ]
    
    for schedule in schedules:
        db.add(schedule)
    db.commit()
    print(f"Created {len(schedules)} schedules")
    
    # Create sample weather data
    weather = Weather(
        location="Maharashtra",
        temperature=28.5,
        humidity=65.0,
        windSpeed=12.3,
        cloudCover=35.0,
        pressure=1013.0,
        visibility=10.0,
        forecast=json.dumps({"7-day": "forecast available"})
    )
    db.add(weather)
    db.commit()
    print("Created weather data")
    
    # Create sample deviations
    for i in range(24):
        deviation = Deviation(
            hour=i,
            deviation=round((i % 10 - 5) * 0.5, 2),
            forecasted=200 + (i * 10),
            actual=200 + (i * 10) + (i % 5 - 2) * 5,
            plantId=1
        )
        db.add(deviation)
    db.commit()
    print("Created 24 deviation records")
    
    # Create sample templates
    templates = [
        Template(
            name="Standard Day-Ahead Template",
            vendor="NLDC",
            type="Day-Ahead",
            lastModified=date.today() - timedelta(days=4),
            status="Active"
        ),
        Template(
            name="Intraday Schedule Template",
            vendor="RLDC",
            type="Intraday",
            lastModified=date.today() - timedelta(days=6),
            status="Active"
        ),
    ]
    
    for template in templates:
        db.add(template)
    db.commit()
    print(f"Created {len(templates)} templates")
    
    # Create sample meter data for each plant
    # Generate 96 blocks of 15-minute interval data
    all_plants = db.query(Plant).all()
    for plant in all_plants:
        is_solar = plant.type == "Solar"
        block_data = {}
        total_generation = 0
        
        for i in range(96):
            hour = i // 4
            minute = (i % 4) * 15
            time_str = f"{hour:02d}:{minute:02d}"
            
            if is_solar:
                # Solar: Peak at noon, zero at night
                if 6 <= hour <= 18:
                    solar_progress = (hour - 6 + minute / 60) / 12
                    generation = max(0, round(math.sin(solar_progress * math.pi) * plant.capacity * 0.7, 2))
                else:
                    generation = 0
            else:
                # Wind: Variable throughout day
                wind_base = plant.capacity * 0.3 + math.sin((i / 96) * 2 * math.pi - math.pi / 2) * plant.capacity * 0.2
                generation = max(0, round(wind_base + random.uniform(-10, 10), 2))
            
            block_data[f"block_{i + 1}"] = {
                "block": i + 1,
                "time": time_str,
                "generation": generation,
                "availableCapacity": 90 if is_solar else 95,
                "availability": round(90 + random.uniform(0, 10), 1)
            }
            total_generation += generation
        
        meter_data = MeterData(
            plantId=plant.id,
            plantName=plant.name,
            dataDate=date.today(),
            blockData=json.dumps(block_data),
            source="SCADA",
            lastReading=datetime.now(),
            dataPoints=96,
            delay=random.randint(5, 15)
        )
        db.add(meter_data)
    db.commit()
    print(f"Created meter data for {len(all_plants)} plants")
    
    # Create sample WhatsApp data for each plant
    for plant in db.query(Plant).all():
        # Create 3-5 entries per plant
        for i in range(random.randint(3, 5)):
            whatsapp_entry = WhatsAppData(
                plantId=plant.id,
                plantName=plant.name,
                state=plant.state,
                date=date.today() - timedelta(days=i),
                time=f"{random.randint(8, 18)}:{random.choice(['00', '15', '30', '45'])}",
                currentGeneration=round(plant.capacity * random.uniform(0.3, 0.8), 1),
                expectedTrend=random.choice(["Increasing", "Stable", "Decreasing"]),
                curtailmentStatus=random.random() > 0.8,
                curtailmentReason=random.choice(["Grid Constraint", "Weather", "Maintenance", None]) if random.random() > 0.8 else None,
                weatherCondition=random.choice(["Clear", "Partly Cloudy", "Cloudy", "Sudden Change"]),
                inverterAvailability=round(random.uniform(85, 99), 1),
                remarks=f"Regular update - {plant.type} plant operating normally",
                status=random.choice(["Pending Review", "Reviewed", "Used"])
            )
            db.add(whatsapp_entry)
    db.commit()
    print("Created WhatsApp data entries")
    
    print("=" * 50)
    print("Database initialized successfully with sample data!")
    print("=" * 50)
    
except Exception as e:
    print(f"Error initializing database: {e}")
    import traceback
    traceback.print_exc()
    db.rollback()
finally:
    db.close()

