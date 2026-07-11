"""
Initialize database with sample data - PostgreSQL compatible version
"""
from database import SessionLocal, engine, Base
from models import Plant, Schedule, Forecast, Weather, Deviation, Report, Template, WhatsAppData, MeterData, DocumentationDocument
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
    # Always ensure SAWDA exists (requested hard-coded plant).
    try:
        existing_sawda = db.query(Plant).filter(Plant.name == "SAWDA").first()
        if not existing_sawda:
            db.add(
                Plant(
                    name="SAWDA",
                    type="Solar",
                    capacity=7.5,
                    state="Madhya Pradesh",
                    status="Active",
                    efficiency=0.0,
                    latitude=21.02138889,
                    longitude=75.60027778,
                    location_name="Sawda, Madhya Pradesh",
                )
            )
            db.commit()
            print("Inserted hard-coded plant: SAWDA")
        else:
            # Keep record aligned with the hard-coded definition.
            updated = False
            if (existing_sawda.type or "") != "Solar":
                existing_sawda.type = "Solar"
                updated = True
            if float(getattr(existing_sawda, "capacity", 0) or 0) != 7.5:
                existing_sawda.capacity = 7.5
                updated = True
            if (existing_sawda.state or "") != "Madhya Pradesh":
                existing_sawda.state = "Madhya Pradesh"
                updated = True
            if getattr(existing_sawda, "latitude", None) != 21.02138889:
                existing_sawda.latitude = 21.02138889
                updated = True
            if getattr(existing_sawda, "longitude", None) != 75.60027778:
                existing_sawda.longitude = 75.60027778
                updated = True
            if updated:
                db.commit()
                print("Updated hard-coded plant: SAWDA")
    except Exception as e:
        db.rollback()
        print(f"Warning: failed to upsert SAWDA plant: {e}")

    try:
        existing_anjangaon = db.query(Plant).filter(Plant.name.in_(["Anjangaon", "ANJANGAON"])).first()
        if not existing_anjangaon:
            db.add(
                Plant(
                    name="ANJANGAON",
                    type="Solar",
                    capacity=7.5,
                    state="Madhya Pradesh",
                    status="Active",
                    efficiency=0.0,
                    latitude=None,
                    longitude=None,
                    location_name="ANJANGAON",
                )
            )
            db.commit()
            print("Inserted hard-coded plant: ANJANGAON")
        else:
            updated = False
            if (existing_anjangaon.name or "") != "ANJANGAON":
                existing_anjangaon.name = "ANJANGAON"
                updated = True
            if (existing_anjangaon.location_name or "") != "ANJANGAON":
                existing_anjangaon.location_name = "ANJANGAON"
                updated = True
            if (existing_anjangaon.type or "") != "Solar":
                existing_anjangaon.type = "Solar"
                updated = True
            if float(getattr(existing_anjangaon, "capacity", 0) or 0) != 7.5:
                existing_anjangaon.capacity = 7.5
                updated = True
            if (existing_anjangaon.state or "") != "Madhya Pradesh":
                existing_anjangaon.state = "Madhya Pradesh"
                updated = True
            if updated:
                db.commit()
                print("Updated hard-coded plant: ANJANGAON")
    except Exception as e:
        db.rollback()
        print(f"Warning: failed to upsert ANJANGAON plant: {e}")

    try:
        existing_andad = db.query(Plant).filter(Plant.name.in_(["Andad", "ANDAD"])).first()
        if not existing_andad:
            db.add(
                Plant(
                    name="ANDAD",
                    type="Solar",
                    capacity=7.5,
                    state="Madhya Pradesh",
                    status="Active",
                    efficiency=0.0,
                    latitude=21.95972222,
                    longitude=75.80583333,
                    location_name="Andad, Madhya Pradesh",
                )
            )
            db.commit()
            print("Inserted hard-coded plant: ANDAD")
        else:
            updated = False
            if (existing_andad.name or "") != "ANDAD":
                existing_andad.name = "ANDAD"
                updated = True
            if (existing_andad.location_name or "") != "Andad, Madhya Pradesh":
                existing_andad.location_name = "Andad, Madhya Pradesh"
                updated = True
            if (existing_andad.type or "") != "Solar":
                existing_andad.type = "Solar"
                updated = True
            if float(getattr(existing_andad, "capacity", 0) or 0) != 7.5:
                existing_andad.capacity = 7.5
                updated = True
            if (existing_andad.state or "") != "Madhya Pradesh":
                existing_andad.state = "Madhya Pradesh"
                updated = True
            if getattr(existing_andad, "latitude", None) != 21.95972222:
                existing_andad.latitude = 21.95972222
                updated = True
            if getattr(existing_andad, "longitude", None) != 75.80583333:
                existing_andad.longitude = 75.80583333
                updated = True
            if updated:
                db.commit()
                print("Updated hard-coded plant: ANDAD")
    except Exception as e:
        db.rollback()
        print(f"Warning: failed to upsert ANDAD plant: {e}")

    try:
        existing_gugariyakhedi = db.query(Plant).filter(Plant.name.in_(["Gugariyakhedi", "GUGARIYAKHEDI"])).first()
        if not existing_gugariyakhedi:
            db.add(
                Plant(
                    name="GUGARIYAKHEDI",
                    type="Solar",
                    capacity=7.5,
                    state="Madhya Pradesh",
                    status="Active",
                    efficiency=0.0,
                    latitude=21.83944444,
                    longitude=75.71888889,
                    location_name="Gugariyakhedi, Madhya Pradesh",
                )
            )
            db.commit()
            print("Inserted hard-coded plant: GUGARIYAKHEDI")
        else:
            updated = False
            if (existing_gugariyakhedi.name or "") != "GUGARIYAKHEDI":
                existing_gugariyakhedi.name = "GUGARIYAKHEDI"
                updated = True
            if (existing_gugariyakhedi.location_name or "") != "Gugariyakhedi, Madhya Pradesh":
                existing_gugariyakhedi.location_name = "Gugariyakhedi, Madhya Pradesh"
                updated = True
            if (existing_gugariyakhedi.type or "") != "Solar":
                existing_gugariyakhedi.type = "Solar"
                updated = True
            if float(getattr(existing_gugariyakhedi, "capacity", 0) or 0) != 7.5:
                existing_gugariyakhedi.capacity = 7.5
                updated = True
            if (existing_gugariyakhedi.state or "") != "Madhya Pradesh":
                existing_gugariyakhedi.state = "Madhya Pradesh"
                updated = True
            if getattr(existing_gugariyakhedi, "latitude", None) != 21.83944444:
                existing_gugariyakhedi.latitude = 21.83944444
                updated = True
            if getattr(existing_gugariyakhedi, "longitude", None) != 75.71888889:
                existing_gugariyakhedi.longitude = 75.71888889
                updated = True
            if updated:
                db.commit()
                print("Updated hard-coded plant: GUGARIYAKHEDI")
    except Exception as e:
        db.rollback()
        print(f"Warning: failed to upsert GUGARIYAKHEDI plant: {e}")

    try:
        existing_balakwada = db.query(Plant).filter(Plant.name.in_(["Balakwada", "BALAKWADA"])).first()
        if not existing_balakwada:
            db.add(
                Plant(
                    name="BALAKWADA",
                    type="Solar",
                    capacity=7.5,
                    state="Madhya Pradesh",
                    status="Active",
                    efficiency=0.0,
                    latitude=22.00583333,
                    longitude=75.52333333,
                    location_name="Balakwada, Madhya Pradesh",
                )
            )
            db.commit()
            print("Inserted hard-coded plant: BALAKWADA")
        else:
            updated = False
            if (existing_balakwada.name or "") != "BALAKWADA":
                existing_balakwada.name = "BALAKWADA"
                updated = True
            if (existing_balakwada.location_name or "") != "Balakwada, Madhya Pradesh":
                existing_balakwada.location_name = "Balakwada, Madhya Pradesh"
                updated = True
            if (existing_balakwada.type or "") != "Solar":
                existing_balakwada.type = "Solar"
                updated = True
            if float(getattr(existing_balakwada, "capacity", 0) or 0) != 7.5:
                existing_balakwada.capacity = 7.5
                updated = True
            if (existing_balakwada.state or "") != "Madhya Pradesh":
                existing_balakwada.state = "Madhya Pradesh"
                updated = True
            if getattr(existing_balakwada, "latitude", None) != 22.00583333:
                existing_balakwada.latitude = 22.00583333
                updated = True
            if getattr(existing_balakwada, "longitude", None) != 75.52333333:
                existing_balakwada.longitude = 75.52333333
                updated = True
            if updated:
                db.commit()
                print("Updated hard-coded plant: BALAKWADA")
    except Exception as e:
        db.rollback()
        print(f"Warning: failed to upsert BALAKWADA plant: {e}")

    try:
        existing_nandgaon = db.query(Plant).filter(Plant.name.in_(["Nandgaon", "NANDGAON"])).first()
        if not existing_nandgaon:
            db.add(
                Plant(
                    name="NANDGAON",
                    type="Solar",
                    capacity=7.5,
                    state="Madhya Pradesh",
                    status="Active",
                    efficiency=0.0,
                    latitude=21.88222222,
                    longitude=75.48027778,
                    location_name="Nandgaon, Madhya Pradesh",
                )
            )
            db.commit()
            print("Inserted hard-coded plant: NANDGAON")
        else:
            updated = False
            if (existing_nandgaon.name or "") != "NANDGAON":
                existing_nandgaon.name = "NANDGAON"
                updated = True
            if (existing_nandgaon.location_name or "") != "Nandgaon, Madhya Pradesh":
                existing_nandgaon.location_name = "Nandgaon, Madhya Pradesh"
                updated = True
            if (existing_nandgaon.type or "") != "Solar":
                existing_nandgaon.type = "Solar"
                updated = True
            if float(getattr(existing_nandgaon, "capacity", 0) or 0) != 7.5:
                existing_nandgaon.capacity = 7.5
                updated = True
            if (existing_nandgaon.state or "") != "Madhya Pradesh":
                existing_nandgaon.state = "Madhya Pradesh"
                updated = True
            if getattr(existing_nandgaon, "latitude", None) != 21.88222222:
                existing_nandgaon.latitude = 21.88222222
                updated = True
            if getattr(existing_nandgaon, "longitude", None) != 75.48027778:
                existing_nandgaon.longitude = 75.48027778
                updated = True
            if updated:
                db.commit()
                print("Updated hard-coded plant: NANDGAON")
    except Exception as e:
        db.rollback()
        print(f"Warning: failed to upsert NANDGAON plant: {e}")

    seed_enabled = os.getenv("SEED_SAMPLE_DATA", "false").strip().lower() == "true"
    if not seed_enabled:
        print("Seed disabled (set SEED_SAMPLE_DATA=true to enable sample data).")
        exit(0)

    # Check if data already exists
    if int(db.query(Plant).count() or 0) > 0:
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
        Template(
            name="Week-ahead Schedule Template",
            vendor="SLDC",
            type="Week-ahead",
            lastModified=date.today(),
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
        plant_type = str(getattr(plant, "type", "") or "")
        is_solar = plant_type == "Solar"
        block_data = {}
        total_generation = 0
        capacity = float(getattr(plant, "capacity", 0) or 0)
        
        for i in range(96):
            hour = i // 4
            minute = (i % 4) * 15
            time_str = f"{hour:02d}:{minute:02d}"
            
            if is_solar:
                # Solar: Peak at noon, zero at night
                if 6 <= hour <= 18:
                    solar_progress = (hour - 6 + minute / 60) / 12
                    generation = max(0, round(math.sin(solar_progress * math.pi) * capacity * 0.7, 2))
                else:
                    generation = 0
            else:
                # Wind: Variable throughout day
                wind_base = capacity * 0.3 + math.sin((i / 96) * 2 * math.pi - math.pi / 2) * capacity * 0.2
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
        capacity = float(getattr(plant, "capacity", 0) or 0)
        # Create 3-5 entries per plant
        for i in range(random.randint(3, 5)):
            whatsapp_entry = WhatsAppData(
                plantId=plant.id,
                plantName=plant.name,
                state=plant.state,
                date=date.today() - timedelta(days=i),
                time=f"{random.randint(8, 18)}:{random.choice(['00', '15', '30', '45'])}",
                currentGeneration=round(capacity * random.uniform(0.3, 0.8), 1),
                expectedTrend=random.choice(["Increasing", "Stable", "Decreasing"]),
                curtailmentStatus=random.random() > 0.8,
                curtailmentReason=random.choice(["Grid Constraint", "Weather", "Maintenance", None]) if random.random() > 0.8 else None,
                weatherCondition=random.choice(["Clear", "Partly Cloudy", "Cloudy", "Sudden Change"]),
                inverterAvailability=round(random.uniform(85, 99), 1),
                remarks=f"Regular update - {plant_type} plant operating normally",
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
