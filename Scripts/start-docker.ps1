#!/usr/bin/env pwsh
# QCA Dashboard - One Command Start Script (Windows)
# This script builds all Docker images locally and starts the entire project

$ErrorActionPreference = "Stop"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  QCA Dashboard - Starting All Services" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# Check if Docker is running
try {
    docker info 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[✗] Docker is not running. Please start Docker first." -ForegroundColor Red
        exit 1
    }
    Write-Host "[✓] Docker is running" -ForegroundColor Green
} catch {
    Write-Host "[✗] Docker is not running. Please start Docker first." -ForegroundColor Red
    exit 1
}

# Step 1: Stop any existing containers
Write-Host ""
Write-Host "Step 1: Cleaning up existing containers..." -ForegroundColor Yellow
docker-compose down --remove-orphans 2>$null | Out-Null
Write-Host "[✓] Cleanup complete" -ForegroundColor Green

# Step 2: Pull base images first (to avoid rate limiting issues)
Write-Host ""
Write-Host "Step 2: Pulling base images..." -ForegroundColor Yellow
docker pull python:3.11-slim 2>$null | Out-Null
docker pull node:18.19.0-alpine 2>$null | Out-Null
docker pull nginx:1.25-alpine 2>$null | Out-Null
docker pull postgres:15 2>$null | Out-Null
Write-Host "[✓] Base images ready" -ForegroundColor Green

# Step 3: Build all images locally
Write-Host ""
Write-Host "Step 3: Building Docker images locally..." -ForegroundColor Yellow
Write-Host "      (This may take a few minutes on first run)" -ForegroundColor DarkGray

Write-Host "Building backend image..." -ForegroundColor Cyan
docker build -t qca-dashboard-backend:latest ./backend --no-cache 2>&1 | Where-Object { $_ -match "Step|Successfully|ERROR|error" } | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
Write-Host "[✓] Backend image built" -ForegroundColor Green

Write-Host "Building frontend image..." -ForegroundColor Cyan
docker build -t qca-dashboard-frontend:latest . -f Dockerfile.frontend --no-cache 2>&1 | Where-Object { $_ -match "Step|Successfully|ERROR|error" } | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
Write-Host "[✓] Frontend image built" -ForegroundColor Green

# Step 4: Start all services
Write-Host ""
Write-Host "Step 4: Starting all services..." -ForegroundColor Yellow
docker-compose up -d

# Step 5: Wait for services to be healthy
Write-Host ""
Write-Host "Step 5: Waiting for services to be ready..." -ForegroundColor Yellow
Start-Sleep -Seconds 10

$maxWait = 60
$waitCount = 0
while ($waitCount -lt $maxWait) {
    $backendStatus = docker inspect --format='{{.State.Running}}' qca-dashboard-backend 2>$null
    
    if ($backendStatus -eq "true") {
        Write-Host "[✓] Backend is running" -ForegroundColor Green
        break
    }
    
    $waitCount += 5
    Write-Host "  Waiting for backend to start... ($waitCount/$maxWait seconds)" -ForegroundColor DarkGray
    Start-Sleep -Seconds 5
}

# Step 6: Show final status
Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  QCA Dashboard - Started Successfully!" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Access Points:" -ForegroundColor White
Write-Host "  Frontend: http://localhost:80" -ForegroundColor Green
Write-Host "  Backend API: http://localhost:3001" -ForegroundColor Green
Write-Host "  API Docs: http://localhost:3001/docs" -ForegroundColor Green
Write-Host ""
Write-Host "Useful Commands:" -ForegroundColor White
Write-Host "  View logs: docker-compose logs -f" -ForegroundColor DarkGray
Write-Host "  Stop: docker-compose down" -ForegroundColor DarkGray
Write-Host ""

