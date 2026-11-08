#Requires -Version 5.1
<#
    Renovo local dev launcher.

    Starts the image API (8000), the ideas API (3000) and the GUI (8080) in THIS console,
    waits until each one answers, then idles.

    All three children share this console, so closing the window kills them. Ctrl+C also
    triggers an explicit taskkill of each process tree, so nothing is left holding a port.

    Run it with dev.bat (double-click) or:
        powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev.ps1
#>

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$logDir = Join-Path $root '_test_output\dev'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$started = New-Object System.Collections.ArrayList

function Fail {
    param([string]$Message, [string]$Detail)
    Write-Host ""
    Write-Host $Message -ForegroundColor Red
    if ($Detail) { Write-Host $Detail -ForegroundColor Yellow }
    Write-Host ""
    if (-not [Console]::IsInputRedirected) { Read-Host "Press Enter to close" | Out-Null }
    exit 1
}

function Test-Port {
    param([int]$Port)
    $client = New-Object System.Net.Sockets.TcpClient
    try { $client.Connect('127.0.0.1', $Port); return $true }
    catch { return $false }
    finally { $client.Dispose() }
}

function Wait-Http {
    param([string]$Url, [int]$Seconds)
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
            if ($response.StatusCode -ge 200) { return $true }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Get-EnvValue {
    param([string]$Path, [string]$Key)
    if (-not (Test-Path $Path)) { return $null }
    foreach ($line in Get-Content -Path $Path) {
        if ($line -match ('^\s*' + [regex]::Escape($Key) + '\s*=\s*(.+?)\s*$')) {
            return $Matches[1].Trim().Trim('"').Trim("'")
        }
    }
    return $null
}

function Stop-Services {
    Write-Host ""
    Write-Host "Stopping Renovo services..." -ForegroundColor Cyan
    foreach ($process in $started) {
        if ($process -and -not $process.HasExited) {
            & taskkill /PID $process.Id /T /F 2>$null | Out-Null
        }
    }
    $started.Clear()
    Write-Host "All services stopped." -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
$python = Join-Path $root '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) {
    Fail "No Python virtualenv at .venv" "Create it with:`n    py -m venv .venv`n    .venv\Scripts\python.exe -m pip install -r requirements.txt"
}

$bun = Join-Path $root '.bun\bun-windows-x64\bun.exe'
if (-not (Test-Path $bun)) {
    $onPath = Get-Command bun -ErrorAction SilentlyContinue
    if ($onPath) {
        $bun = $onPath.Source
    } else {
        Fail "Bun was not found" "Install it from https://bun.sh, or keep a project-local copy at .bun\bun-windows-x64\bun.exe"
    }
}

if (-not (Test-Path (Join-Path $root 'node_modules'))) {
    Fail "GUI dependencies are not installed" "Run: `"$bun`" install"
}

$busy = @()
foreach ($entry in @(@{ Port = 8000; Name = 'image API' }, @{ Port = 3000; Name = 'ideas API' }, @{ Port = 8080; Name = 'GUI' })) {
    if (Test-Port $entry.Port) { $busy += "$($entry.Name) (port $($entry.Port))" }
}
if ($busy.Count -gt 0) {
    Fail ("These ports are already in use: " + ($busy -join ', ')) "Close the other Renovo window first, or find the owner with:`n    netstat -ano | findstr :8000"
}

$rootKey = Get-EnvValue (Join-Path $root '.env') 'HACKCLUB_AI_API_KEY'
$ideasKey = Get-EnvValue (Join-Path $root 'gemini-ideas\.env') 'GEMINI_API_KEY'
if (-not $rootKey -or $rootKey -like '*your-api-key*') {
    Write-Host "WARNING: HACKCLUB_AI_API_KEY is missing from .env - image previews will fail." -ForegroundColor Yellow
}
if (-not $ideasKey -or $ideasKey -like '*your-api-key*') {
    Write-Host "WARNING: GEMINI_API_KEY is missing from gemini-ideas\.env - pricing will fail." -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# Start the three services
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "Starting Renovo..." -ForegroundColor Cyan

$image = Start-Process -FilePath $python `
    -ArgumentList @('-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8000') `
    -NoNewWindow -PassThru `
    -RedirectStandardOutput (Join-Path $logDir 'image.out.log') `
    -RedirectStandardError (Join-Path $logDir 'image.err.log')
[void]$started.Add($image)

$previousPort = $env:PORT
$env:PORT = '3000'
$ideas = Start-Process -FilePath $bun `
    -ArgumentList @('gemini-ideas/server.js') `
    -NoNewWindow -PassThru `
    -RedirectStandardOutput (Join-Path $logDir 'ideas.out.log') `
    -RedirectStandardError (Join-Path $logDir 'ideas.err.log')
if ($null -eq $previousPort) { Remove-Item Env:PORT -ErrorAction SilentlyContinue } else { $env:PORT = $previousPort }
[void]$started.Add($ideas)

$gui = Start-Process -FilePath $bun `
    -ArgumentList @('run', 'dev', '--', '--host', '127.0.0.1', '--port', '8080') `
    -NoNewWindow -PassThru `
    -RedirectStandardOutput (Join-Path $logDir 'gui.out.log') `
    -RedirectStandardError (Join-Path $logDir 'gui.err.log')
[void]$started.Add($gui)

$services = @(
    @{ Name = 'Image API'; Url = 'http://127.0.0.1:8000/api/health'; Process = $image },
    @{ Name = 'Ideas API'; Url = 'http://127.0.0.1:3000/api/health'; Process = $ideas },
    @{ Name = 'GUI';       Url = 'http://127.0.0.1:8080/';            Process = $gui }
)

try {
    $healthy = $true
    foreach ($service in $services) {
        if (Wait-Http -Url $service.Url -Seconds 90) {
            Write-Host ("  {0,-10} ready   {1}" -f $service.Name, $service.Url) -ForegroundColor Green
        } else {
            $healthy = $false
            Write-Host ("  {0,-10} FAILED  see _test_output\dev" -f $service.Name) -ForegroundColor Red
            if ($service.Process.HasExited) {
                Write-Host ("             exited with code {0}" -f $service.Process.ExitCode) -ForegroundColor Yellow
            }
        }
    }

    if (-not $healthy) { throw "One or more services did not start." }

    Write-Host ""
    Write-Host "  GUI:             http://127.0.0.1:8080/" -ForegroundColor Cyan
    Write-Host "  Image test page: http://127.0.0.1:8000/test-ui" -ForegroundColor Cyan
    Write-Host "  Logs:            _test_output\dev\" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "Press Ctrl+C or close this window to stop all three services." -ForegroundColor DarkGray

    while ($true) {
        Start-Sleep -Seconds 2
        foreach ($service in $services) {
            if ($service.Process.HasExited) {
                Write-Host ("{0} stopped unexpectedly (code {1}); shutting the rest down." -f $service.Name, $service.Process.ExitCode) -ForegroundColor Red
                throw "A service exited."
            }
        }
    }
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
} finally {
    Stop-Services
}
