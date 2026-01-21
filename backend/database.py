"""
Database configuration for PostgreSQL (version 15 compatible)
"""
from sqlalchemy import create_engine, event
from sqlalchemy.orm import declarative_base, sessionmaker
import os

# PostgreSQL Configuration
# Get DATABASE_URL from environment, default to PostgreSQL
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://qca_user:qca_password@localhost:5432/qca_dashboard"
)

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

