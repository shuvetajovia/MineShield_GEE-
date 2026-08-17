# MineShield — One-Click Launcher
# Run this script from the project root: d:\MineShield_GEE\

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  ▲  MineShield v2.0 — AI Rockfall Prediction System" -ForegroundColor Red
Write-Host "  ─────────────────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host ""

# Check Python 3.11
try {
    $pyver = py -3.11 --version 2>&1
    Write-Host "  [OK] Python: $pyver" -ForegroundColor Green
} catch {
    Write-Host "  [ERR] Python 3.11 not found. Install it and retry." -ForegroundColor Red
    exit 1
}

# Install dependencies
Write-Host ""
Write-Host "  [*] Installing backend dependencies..." -ForegroundColor Yellow
Set-Location "$PSScriptRoot\backend"
py -3.11 -m pip install -r requirements.txt -q
Write-Host "  [OK] Dependencies installed" -ForegroundColor Green

# Start backend in background
Write-Host ""
Write-Host "  [>>] Starting FastAPI backend on http://localhost:8000 ..." -ForegroundColor Cyan
$backend = Start-Process -FilePath "C:\Users\Admin\AppData\Local\Programs\Python\Python311\python.exe" `
    -ArgumentList "-m uvicorn main:app --reload --host 0.0.0.0 --port 8000" `
    -WorkingDirectory "$PSScriptRoot\backend" `
    -PassThru -WindowStyle Normal

Write-Host "  [OK] Backend started (PID: $($backend.Id))" -ForegroundColor Green
Write-Host ""

# Wait for backend to be ready
Write-Host "  Waiting for backend to initialize..." -ForegroundColor Yellow
Start-Sleep -Seconds 5

# Open frontend in default browser
$frontendPath = "$PSScriptRoot\frontend\index.html"
Write-Host "  Opening MineShield frontend..." -ForegroundColor Cyan
Start-Process "http://localhost:8000"

Write-Host ""
Write-Host "  ════════════════════════════════════════════════" -ForegroundColor DarkGray
Write-Host "  MineShield is running!" -ForegroundColor Green
Write-Host ""
Write-Host "  Backend API : http://localhost:8000" -ForegroundColor White
Write-Host "  API Docs    : http://localhost:8000/docs" -ForegroundColor White
Write-Host "  Frontend    : $frontendPath" -ForegroundColor White
Write-Host ""
Write-Host "  Press Ctrl+C to stop the backend server." -ForegroundColor DarkGray
Write-Host "  ════════════════════════════════════════════════" -ForegroundColor DarkGray
Write-Host ""

# Keep window open and wait for backend process
try {
    $backend.WaitForExit()
} catch {
    Write-Host "  Backend stopped." -ForegroundColor Yellow
}
