param(
    [switch]$Restart,
    [string]$EnvFile = ".env"      # optional project-level env
)

$ErrorActionPreference = "Stop"

# --- Paths ---
$ROOT = Split-Path -Parent $PSCommandPath
$LOG_DIR = Join-Path $ROOT "logs"
New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null

$CONTAINER_NAME = "livekit-server"
$FRONTEND_ENV = Join-Path $ROOT "frontend\.env"
$FRONTEND_ENV_LOCAL = Join-Path $ROOT "frontend\.env.local"

# --- Helper to load simple KEY=VALUE files into env: ---
function Import-EnvFile {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return }
    Get-Content $Path | ForEach-Object {
        if ($_ -match '^\s*#') { return }
        if ($_ -match '^\s*$') { return }
        $k,$v = $_ -split '=',2
        $k = $k.Trim()
        $v = $v.Trim()
        if (-not [string]::IsNullOrWhiteSpace($k)) {
            $name = $k   # keep original casing; env var names are case-insensitive on Windows
            Set-Item -Path "env:$name" -Value $v
            Write-Host "Set $name to $v"
        }
    }
}

# --- Load env from frontend/.env, frontend/.env.local, then .env if present ---
Import-EnvFile -Path $FRONTEND_ENV
Import-EnvFile -Path $FRONTEND_ENV_LOCAL

$ENV_FILE_PATH = if ([System.IO.Path]::IsPathRooted($EnvFile)) { $EnvFile } else { Join-Path $ROOT $EnvFile }
Import-EnvFile -Path $ENV_FILE_PATH

# --- Derive ports ---
if (-not $env:LIVEKIT_HTTP_PORT) {
    if ($env:LIVEKIT_URL -and ($env:LIVEKIT_URL -match ':(\d+)')) {
        $env:LIVEKIT_HTTP_PORT = $Matches[1]
    } else {
        $env:LIVEKIT_HTTP_PORT = 7880
    }
}
if (-not $env:LIVEKIT_UDP_PORT) { $env:LIVEKIT_UDP_PORT = 7882 }

# LiveKit API keys: use .env if set, otherwise local dev defaults
if (-not $env:LIVEKIT_API_KEY)   { $env:LIVEKIT_API_KEY = "devkey";  Write-Host "Using default LIVEKIT_API_KEY (devkey) for local dev." -ForegroundColor Yellow }
if (-not $env:LIVEKIT_API_SECRET){ $env:LIVEKIT_API_SECRET = "secret"; Write-Host "Using default LIVEKIT_API_SECRET for local dev." -ForegroundColor Yellow }

# --- Docker available? ---
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host "Docker not found. Install Docker Desktop or adapt for native mode." -ForegroundColor Red
    exit 1
}

# --- Handle existing container ---
$exists = docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $CONTAINER_NAME }
if ($exists) {
    $running = docker ps --format '{{.Names}}' | Where-Object { $_ -eq $CONTAINER_NAME }
    if ($running) {
        if ($Restart) {
            Write-Host "Stopping existing LiveKit container..."
            docker stop $CONTAINER_NAME | Out-Null
            docker rm $CONTAINER_NAME | Out-Null
        } else {
            Write-Host "LiveKit container is already running. Use -Restart to restart." -ForegroundColor Yellow
            exit 1
        }
    } else {
        docker rm $CONTAINER_NAME | Out-Null
    }
}

# --- Generate minimal livekit.yaml ---
$LIVEKIT_DIR = Join-Path $ROOT "livekit"
New-Item -ItemType Directory -Force -Path $LIVEKIT_DIR | Out-Null
$CONFIG_PATH = Join-Path $LIVEKIT_DIR "livekit.yaml"

@"
port: ${env:LIVEKIT_HTTP_PORT}
rtc:
  tcp_port: 0
  udp_port: ${env:LIVEKIT_UDP_PORT}
keys:
  ${env:LIVEKIT_API_KEY}: ${env:LIVEKIT_API_SECRET}
"@ | Set-Content $CONFIG_PATH -Encoding UTF8

Write-Host "Starting LiveKit (Docker) on HTTP ${env:LIVEKIT_HTTP_PORT}, UDP ${env:LIVEKIT_UDP_PORT}..."

try {
    docker run -d --restart unless-stopped `
      --name $CONTAINER_NAME `
      -p "${env:LIVEKIT_HTTP_PORT}:${env:LIVEKIT_HTTP_PORT}" `
      -p "${env:LIVEKIT_UDP_PORT}:${env:LIVEKIT_UDP_PORT}/udp" `
      -v "${CONFIG_PATH}:/etc/livekit/livekit.yaml:ro" `
      livekit/livekit-server:latest `
      --dev --config /etc/livekit/livekit.yaml | Out-Null
} catch {
    Write-Host "Failed to start LiveKit container (docker run failed): $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Start-Sleep -Seconds 2

if (docker ps --format '{{.Names}}' | Where-Object { $_ -eq $CONTAINER_NAME }) {
    Write-Host "LiveKit container started as '$CONTAINER_NAME'." -ForegroundColor Green
    Write-Host "View logs with: docker logs -f $CONTAINER_NAME"
} else {
    Write-Host "Failed to start LiveKit container (container not found after docker run)." -ForegroundColor Red
    # Don't call docker logs on a container that doesn't exist
    exit 1
}