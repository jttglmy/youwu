# Youwu local server (ASCII only, safe for any Windows codepage)
# Serves the youwu folder over HTTP so a phone on the same Wi-Fi can open it.

param([int]$Port = 8080)

$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$mime = @{
  '.html'        = 'text/html; charset=utf-8'
  '.css'         = 'text/css; charset=utf-8'
  '.js'          = 'application/javascript; charset=utf-8'
  '.json'        = 'application/json; charset=utf-8'
  '.webmanifest' = 'application/manifest+json; charset=utf-8'
  '.svg'         = 'image/svg+xml'
  '.png'         = 'image/png'
  '.jpg'         = 'image/jpeg'
  '.jpeg'        = 'image/jpeg'
  '.ico'         = 'image/x-icon'
  '.md'          = 'text/plain; charset=utf-8'
  '.txt'         = 'text/plain; charset=utf-8'
}

# --- pick a free port ---
$listener = $null
for ($p = $Port; $p -lt $Port + 10; $p++) {
  try {
    $l = New-Object -TypeName System.Net.Sockets.TcpListener -ArgumentList @([System.Net.IPAddress]::Any, $p)
    $l.Start()
    $listener = $l
    $Port = $p
    break
  } catch {
    if ($l) { try { $l.Stop() } catch { } }
    $l = $null
  }
}

if (-not $listener) {
  Write-Host ""
  Write-Host "  [ERROR] Ports 8080-8089 are all busy." -ForegroundColor Red
  Write-Host "          Close other programs and try again."
  Write-Host ""
  exit 1
}

# --- find LAN addresses ---
$ips = @()
try {
  $ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -ExpandProperty IPAddress)
} catch {
  try {
    $ips = @([System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
      Where-Object { $_.AddressFamily -eq 'InterNetwork' } |
      ForEach-Object { $_.IPAddressToString } |
      Where-Object { $_ -notlike '127.*' -and $_ -notlike '169.254.*' })
  } catch { }
}

Write-Host ""
Write-Host "  ==========================================" -ForegroundColor Green
Write-Host "    Youwu local server is RUNNING" -ForegroundColor Green
Write-Host "  ==========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  1. Keep this window open." -ForegroundColor White
Write-Host "  2. On your phone (same Wi-Fi), open:" -ForegroundColor White
foreach ($ip in $ips) {
  Write-Host ("       http://" + $ip + ":" + $Port + "/") -ForegroundColor Yellow
}
if ($ips.Count -eq 0) {
  Write-Host "       (no LAN IP found - is this PC on Wi-Fi or a cable?)" -ForegroundColor DarkYellow
}
Write-Host ""
Write-Host ("  Test on this PC: http://localhost:" + $Port + "/") -ForegroundColor Gray
Write-Host ""
Write-Host "  If Windows asks about firewall, click ALLOW." -ForegroundColor DarkYellow
Write-Host "  Close this window to stop." -ForegroundColor DarkYellow
Write-Host ""

# --- request loop ---
while ($true) {
  $client = $null
  try {
    $client = $listener.AcceptTcpClient()
    $client.ReceiveTimeout = 8000
    $stream = $client.GetStream()
    $stream.ReadTimeout = 8000
    $stream.WriteTimeout = 8000

    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII)
    $requestLine = $reader.ReadLine()
    if (-not $requestLine) { continue }

    while ($true) {
      $h = $reader.ReadLine()
      if ($null -eq $h -or $h -eq '') { break }
    }

    $parts = $requestLine -split ' '
    $rawPath = '/'
    if ($parts.Length -ge 2) { $rawPath = $parts[1] }

    $q = $rawPath.IndexOf('?')
    if ($q -ge 0) { $rawPath = $rawPath.Substring(0, $q) }
    try { $rawPath = [System.Uri]::UnescapeDataString($rawPath) } catch { }
    if ($rawPath -eq '/') { $rawPath = '/index.html' }

    $rel = $rawPath.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar)
    $full = [System.IO.Path]::GetFullPath((Join-Path $root $rel))

    $inside = $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)
    $ok = $inside -and (Test-Path -LiteralPath $full -PathType Leaf)

    if (-not $ok) {
      $body = [System.Text.Encoding]::UTF8.GetBytes('404 Not Found')
      $head = "HTTP/1.1 404 Not Found`r`nContent-Type: text/plain; charset=utf-8`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n"
      $hb = [System.Text.Encoding]::ASCII.GetBytes($head)
      $stream.Write($hb, 0, $hb.Length)
      $stream.Write($body, 0, $body.Length)
    } else {
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $ext = [System.IO.Path]::GetExtension($full).ToLower()
      $ct = $mime[$ext]
      if (-not $ct) { $ct = 'application/octet-stream' }
      $head = "HTTP/1.1 200 OK`r`nContent-Type: $ct`r`nContent-Length: $($bytes.Length)`r`nCache-Control: no-store`r`nX-Content-Type-Options: nosniff`r`nConnection: close`r`n`r`n"
      $hb = [System.Text.Encoding]::ASCII.GetBytes($head)
      $stream.Write($hb, 0, $hb.Length)
      $stream.Write($bytes, 0, $bytes.Length)
    }
    $stream.Flush()
  } catch {
    # ignore single request errors
  } finally {
    if ($client) { try { $client.Close() } catch { } }
  }
}
