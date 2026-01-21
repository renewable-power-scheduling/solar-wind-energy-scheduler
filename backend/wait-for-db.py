"""
Wait for database to be ready before starting the application
"""
import sys
import time
import psycopg2
import os

def wait_for_db(max_retries=30, retry_interval=2):
    """Wait for database to be ready"""
    database_url = os.getenv(
        "DATABASE_URL",
        "postgresql://qca_user:qca_password@db:5432/qca_dashboard"
    )
    
    # Parse database URL
    # Format: postgresql://user:password@host:port/database
    try:
        # Extract connection details
        url_parts = database_url.replace("postgresql://", "").split("@")
        auth = url_parts[0].split(":")
        user = auth[0]
        password = auth[1] if len(auth) > 1 else ""
        host_port_db = url_parts[1].split("/")
        host_port = host_port_db[0].split(":")
        host = host_port[0]
        port = int(host_port[1]) if len(host_port) > 1 else 5432
        database = host_port_db[1] if len(host_port_db) > 1 else "postgres"
    except Exception as e:
        print(f"Error parsing DATABASE_URL: {e}")
        return False
    
    print(f"Waiting for database at {host}:{port}/{database}...")
    
    for i in range(max_retries):
        try:
            conn = psycopg2.connect(
                host=host,
                port=port,
                user=user,
                password=password,
                database=database,
                connect_timeout=2
            )
            conn.close()
            print("Database is ready!")
            return True
        except psycopg2.OperationalError as e:
            if i < max_retries - 1:
                print(f"Database not ready yet, waiting... ({i+1}/{max_retries})")
                time.sleep(retry_interval)
            else:
                print(f"Database connection failed after {max_retries} attempts: {e}")
                return False
        except Exception as e:
            print(f"Unexpected error: {e}")
            return False
    
    return False

if __name__ == "__main__":
    if wait_for_db():
        sys.exit(0)
    else:
        sys.exit(1)
