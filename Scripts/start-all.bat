@echo off
echo ========================================
echo   QCA Dashboard - Starting Servers
echo ========================================
echo.

echo Starting Backend Server...
start "Backend Server" cmd /k "cd backend && npm install && npm start"

timeout /t 3 /nobreak >nul

echo Starting Frontend Server...
cd /d "%~dp0"
if not exist "node_modules" (
    echo Installing frontend dependencies...
    call npm install
)

echo.
echo Frontend will be available at: http://localhost:5173
echo Backend API will be available at: http://localhost:3001
echo.
call npm run dev
