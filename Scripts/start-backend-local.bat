@echo off
REM QCA Dashboard - Quick Start Script for Windows (Local Development)
REM This script starts the backend with SQLite (no PostgreSQL needed)

echo ========================================
echo   QCA Dashboard - Local Development
echo ========================================
echo.

REM Check if virtual environment exists
if not exist backend\venv (
    echo Creating virtual environment...
    cd backend
    python -m venv venv
    cd ..
)

REM Activate virtual environment and install dependencies
echo Installing dependencies...
cd backend
call venv\Scripts\activate.bat
pip install -q -r requirements.txt
cd ..

REM Initialize the database
echo Initializing database...
cd backend
call venv\Scripts\activate.bat
python init_db.py
cd ..

REM Start the backend server
echo.
echo Starting backend server on http://localhost:3001...
echo Press Ctrl+C to stop
echo.
cd backend
call venv\Scripts\activate.bat
uvicorn main:app --host 0.0.0.0 --port 3001 --reload

