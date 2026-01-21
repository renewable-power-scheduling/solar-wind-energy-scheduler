# QCA Dashboard - Manual Start Script
# This script starts Database, Backend, and Frontend in separate PowerShell windows

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  QCA Dashboard - Manual Start Script  " -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if Docker is running
Write-Host "Checking Docker..." -ForegroundColor Yellow
try {
    docker ps | Out-Null
    Write-Host "✓ Docker is running" -ForegroundColor Green
} catch {
    Write-Host "✗ Docker is not running. Please start Docker Desktop." -ForegroundColor Red
    exit 1
}

# Start Database
Write-Host ""
Write-Host "Starting Database (PostgreSQL)..." -ForegroundColor Green
$dbExists = docker ps -a --filter "name=qca-dashboard-db" --format "{{.Names}}"
if ($dbExists -eq "qca-dashboard-db") {
    $dbRunning = docker ps --filter "name=qca-dashboard-db" --format "{{.Names}}"
    if ($dbRunning -eq "qca-dashboard-db") {
        Write-Host "✓ Database container already running" -ForegroundColor Green
    } else {
        docker start qca-dashboard-db | Out-Null
        Write-Host "✓ Database container started" -ForegroundColor Green
    }
} else {
    docker run -d --name qca-dashboard-db -e POSTGRES_USER=qca_user -e POSTGRES_PASSWORD=qca_password -e POSTGRES_DB=qca_dashboard -p 5432:5432 postgres:15 | Out-Null
    Write-Host "✓ Database container created and started" -ForegroundColor Green
}

# Wait for database to be ready
Write-Host "Waiting for database to be ready..." -ForegroundColor Yellow
Start-Sleep -Seconds 5

# Start Backend
Write-Host ""
Write-Host "Starting Backend (FastAPI)..." -ForegroundColor Green
$backendScript = @"
cd `"$PWD\backend`"
if (-not (Test-Path venv)) {
    Write-Host 'Creating virtual environment...' -ForegroundColor Yellow
    python -m venv venv
}
Write-Host 'Activating virtual environment...' -ForegroundColor Yellow
.\venv\Scripts\Activate.ps1
Write-Host 'Installing/updating dependencies...' -ForegroundColor Yellow
pip install -q -r requirements.txt
Write-Host 'Starting Backend API server...' -ForegroundColor Green
Write-Host 'Backend will be available at: http://localhost:3001' -ForegroundColor Cyan
Write-Host 'API Docs at: http://localhost:3001/docs' -ForegroundColor Cyan
Write-Host ''
uvicorn main:app --host 0.0.0.0 --port 3001 --reload
"@

Start-Process powershell -ArgumentList "-NoExit", "-Command", $backendScript
Write-Host "✓ Backend starting in new window" -ForegroundColor Green

# Wait for backend to initialize
Write-Host "Waiting for backend to initialize..." -ForegroundColor Yellow
Start-Sleep -Seconds 8

# Start Frontend
Write-Host ""
Write-Host "Starting Frontend (React + Vite)..." -ForegroundColor Green
$frontendScript = @"
cd `"$PWD`"
if (-not (Test-Path node_modules)) {
    Write-Host 'Installing dependencies...' -ForegroundColor Yellow
    npm install
}
Write-Host 'Starting Frontend development server...' -ForegroundColor Green
Write-Host 'Frontend will be available at: http://localhost:5173' -ForegroundColor Cyan
Write-Host ''
npm run dev
"@

Start-Process powershell -ArgumentList "-NoExit", "-Command", $frontendScript
Write-Host "✓ Frontend starting in new window" -ForegroundColor Green

# Summary
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  All Services Starting..." -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Service URLs:" -ForegroundColor Yellow
Write-Host "  Database:   localhost:5432" -ForegroundColor White
Write-Host "  Backend:    http://localhost:3001" -ForegroundColor White
Write-Host "  API Docs:   http://localhost:3001/docs" -ForegroundColor White
Write-Host "  Frontend:   http://localhost:5173" -ForegroundColor White
Write-Host ""
Write-Host "Note: Services are starting in separate windows." -ForegroundColor Yellow
Write-Host "Wait a few seconds for all services to be ready." -ForegroundColor Yellow
Write-Host ""
Write-Host "To stop services:" -ForegroundColor Yellow
Write-Host "  - Close the PowerShell windows for Backend and Frontend" -ForegroundColor White
Write-Host "  - Run: docker stop qca-dashboard-db" -ForegroundColor White
Write-Host ""
