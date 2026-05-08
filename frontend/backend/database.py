"""
Database configuration for PostgreSQL (version 15 compatible)
"""
from sqlalchemy import create_engine, event
from sqlalchemy.orm import declarative_base, sessionmaker
import os

# PostgreSQL Configuration
# Prefer explicit DATABASE_URL. Otherwise, choose a safe default based on whether we're running in Docker.
DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    use_docker = str(os.getenv("USE_DOCKER", "")).strip().lower() in {"1", "true", "yes", "y"}
    host = os.getenv("POSTGRES_HOST") or ("db" if use_docker else "localhost")
    port = os.getenv("POSTGRES_PORT") or "5432"
    user = os.getenv("POSTGRES_USER") or "qca_user"
    password = os.getenv("POSTGRES_PASSWORD") or "qca_password"
    db_name = os.getenv("POSTGRES_DB") or "qca_dashboard"
    DATABASE_URL = f"postgresql://{user}:{password}@{host}:{port}/{db_name}"

# Validate that we're using PostgreSQL
if DATABASE_URL.startswith("sqlite"):
    raise ValueError(
        "SQLite is not supported. Please set DATABASE_URL to a PostgreSQL connection string.\n"
        "Example: postgresql://qca_user:qca_password@localhost:5432/qca_dashboard"
    )

# Create PostgreSQL engine with connection pooling
# pool_size: number of connections to maintain
# max_overflow: additional connections allowed beyond pool_size
# pool_pre_ping: verify connections before use
# pool_recycle: recycle connections after this many seconds
engine = create_engine(
    DATABASE_URL,
    pool_size=10,
    max_overflow=20,
    pool_pre_ping=True,
    pool_recycle=3600,
    echo=False  # Set to True for debugging SQL queries
)

# Session factory with autoflush and autocommit disabled
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Base class for all models
Base = declarative_base()


def get_db():
    """Dependency to get database session"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    """Initialize database tables"""
    Base.metadata.create_all(bind=engine)
    return engine


# PostgreSQL-specific optimizations
@event.listens_for(engine, "connect")
def set_session_vars(dbapi_connection, connection_record):
    """Set PostgreSQL session variables for better performance"""
    cursor = dbapi_connection.cursor()
    # Set timezone to UTC
    cursor.execute("SET timezone = 'UTC'")
    # Enable extended query protocol for better performance
    cursor.execute("SET statement_timeout = '60s'")
    cursor.close()
