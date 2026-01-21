# QCA Dashboard - Check Environment and Run Script
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  QCA Dashboard - Environment Check" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check for Node.js
$nodePath = $null
$npmPath = $null

# Try to find Node.js
$possibleNodePaths = @(
    "$env:ProgramFiles\nodejs\node.exe",
    "$env:ProgramFiles(x86)\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
    "C:\Program Files\nodejs\node.exe",
    "C:\Program Files (x86)\nodejs\node.exe"
)

foreach ($path in $possibleNodePaths) {
    if (Test-Path $path) {
        $nodePath = $path
        $npmPath = Join-Path (Split-Path $path) "npm.cmd"
        break
    }
}

# Check PATH
try {
    $nodeVersion = node --version 2>$null
    if ($nodeVersion) {
        Write-Host "✅ Node.js found: $nodeVersion" -ForegroundColor Green
        $nodePath = "node"
        $npmPath = "npm"
    }
} catch {
    # Node.js not in PATH
}

if (-not $nodePath) {
    Write-Host "❌ Node.js is not installed or not found in PATH" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please install Node.js:" -ForegroundColor Yellow
    Write-Host "1. Go to: https://nodejs.org/" -ForegroundColor Cyan
    Write-Host "2. Download the LTS version" -ForegroundColor Cyan
    Write-Host "3. Run the installer" -ForegroundColor Cyan
    Write-Host "4. Restart your terminal" -ForegroundColor Cyan
    Write-Host "5. Run this script again" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Opening Node.js download page..." -ForegroundColor Yellow
    Start-Process "https://nodejs.org/"
    exit 1
}

Write-Host "✅ Node.js is ready!" -ForegroundColor Green
Write-Host ""

# Check if we're in the right directory
$currentDir = Get-Location
if (-not (Test-Path "package.json")) {
    Write-Host "⚠️  Warning: package.json not found in current directory" -ForegroundColor Yellow
    Write-Host "Current directory: $currentDir" -ForegroundColor Yellow
    Write-Host "Please navigate to the project root directory" -ForegroundColor Yellow
    exit 1
}

Write-Host "📁 Project directory: $currentDir" -ForegroundColor Cyan
Write-Host ""

# Check dependencies
if (-not (Test-Path "node_modules")) {
    Write-Host "📦 Installing frontend dependencies..." -ForegroundColor Yellow
    & $npmPath install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Failed to install dependencies" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "✅ Frontend dependencies already installed" -ForegroundColor Green
}

if (-not (Test-Path "backend\node_modules")) {
    Write-Host "📦 Installing backend dependencies..." -ForegroundColor Yellow
    Set-Location backend
    & $npmPath install
    Set-Location ..
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Failed to install backend dependencies" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "✅ Backend dependencies already installed" -ForegroundColor Green
}

Write-Host ""
Write-Host "🚀 Starting servers..." -ForegroundColor Green
Write-Host ""

# Start backend in new window
Write-Host "Starting backend server..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$PWD\backend'; npm start"

# Wait a moment
Start-Sleep -Seconds 3

# Start frontend
Write-Host "Starting frontend server..." -ForegroundColor Cyan
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Frontend will be available at:" -ForegroundColor Green
Write-Host "  http://localhost:5173" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Backend API will be available at:" -ForegroundColor Green
Write-Host "  http://localhost:3001" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Green
Write-Host ""

& $npmPath run dev
