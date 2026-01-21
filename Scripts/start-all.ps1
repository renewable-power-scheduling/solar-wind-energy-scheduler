# Start Both Frontend and Backend Servers
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  QCA Dashboard - Starting Servers" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Start Backend in a new window
Write-Host "Starting Backend Server..." -ForegroundColor Green
Start-Process powershell -ArgumentList "-NoExit", "-File", "$PSScriptRoot\start-backend.ps1"

# Wait a moment for backend to start
Start-Sleep -Seconds 3

# Start Frontend
Write-Host "Starting Frontend Server..." -ForegroundColor Green
Set-Location "$PSScriptRoot"
if (-not (Test-Path "node_modules")) {
    Write-Host "Installing frontend dependencies..." -ForegroundColor Yellow
    npm install
}
Write-Host ""
Write-Host "Frontend will be available at: http://localhost:5173" -ForegroundColor Cyan
Write-Host "Backend API will be available at: http://localhost:3001" -ForegroundColor Cyan
Write-Host ""
npm run dev
