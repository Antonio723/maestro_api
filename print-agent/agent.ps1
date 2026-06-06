# Orquestra - Agente de Impressao de Etiquetas (PowerShell nativo, sem instalar nada).
# Escuta em 127.0.0.1:<porta> e imprime ZPL cru na impressora COMPARTILHADA informada
# (copy /b para \\host\compartilhamento). O navegador (front) envia o ZPL via HTTP.
#
# Uso:  powershell -ExecutionPolicy Bypass -File agent.ps1   (ou o iniciar-agente.bat)

$ErrorActionPreference = 'Stop'
$Port = if ($env:ORQ_AGENT_PORT) { [int]$env:ORQ_AGENT_PORT } else { 9110 }

function Find-HeaderEnd($bytes) {
  for ($i = 0; $i -le $bytes.Length - 4; $i++) {
    if ($bytes[$i] -eq 13 -and $bytes[$i+1] -eq 10 -and $bytes[$i+2] -eq 13 -and $bytes[$i+3] -eq 10) { return $i }
  }
  return -1
}

function Get-HeaderValue($headerText, $name) {
  foreach ($line in ($headerText -split "`r`n")) {
    if ($line -match "^(?i)$([regex]::Escape($name)):\s*(.*)$") { return $Matches[1].Trim() }
  }
  return $null
}

function Read-Request($stream) {
  $ms = New-Object System.IO.MemoryStream
  $buf = New-Object byte[] 8192
  while ($true) {
    $read = $stream.Read($buf, 0, $buf.Length)
    if ($read -le 0) { break }
    $ms.Write($buf, 0, $read)
    $bytes = $ms.ToArray()
    $headerEnd = Find-HeaderEnd $bytes
    if ($headerEnd -ge 0) {
      $headerText = [Text.Encoding]::ASCII.GetString($bytes, 0, $headerEnd)
      $contentLength = 0
      $cl = Get-HeaderValue $headerText 'Content-Length'
      if ($cl) { $contentLength = [int]$cl }
      $bodyStart = $headerEnd + 4
      $have = $bytes.Length - $bodyStart
      while ($have -lt $contentLength) {
        $read2 = $stream.Read($buf, 0, $buf.Length)
        if ($read2 -le 0) { break }
        $ms.Write($buf, 0, $read2)
        $have += $read2
      }
      $all = $ms.ToArray()
      $body = ''
      if ($contentLength -gt 0 -and $all.Length -gt $bodyStart) {
        $len = [Math]::Min($contentLength, $all.Length - $bodyStart)
        $body = [Text.Encoding]::UTF8.GetString($all, $bodyStart, $len)
      }
      return @{ Header = $headerText; Body = $body }
    }
  }
  return $null
}

function Get-CorsHeaders($headerText) {
  $origin = Get-HeaderValue $headerText 'Origin'
  if (-not $origin) { $origin = '*' }
  $h = [ordered]@{
    'Access-Control-Allow-Origin'  = $origin
    'Access-Control-Allow-Methods' = 'GET, POST, OPTIONS'
    'Access-Control-Allow-Headers' = 'Content-Type'
  }
  if (Get-HeaderValue $headerText 'Access-Control-Request-Private-Network') {
    $h['Access-Control-Allow-Private-Network'] = 'true'
  }
  return $h
}

function Send-Response($stream, [int]$status, $extraHeaders, [string]$body) {
  $bodyBytes = [Text.Encoding]::UTF8.GetBytes($body)
  $head = "HTTP/1.1 $status X`r`n"
  foreach ($k in $extraHeaders.Keys) { $head += "${k}: $($extraHeaders[$k])`r`n" }
  $head += "Content-Type: application/json; charset=utf-8`r`n"
  $head += "Content-Length: $($bodyBytes.Length)`r`n"
  $head += "Connection: close`r`n`r`n"
  $headBytes = [Text.Encoding]::ASCII.GetBytes($head)
  $stream.Write($headBytes, 0, $headBytes.Length)
  if ($bodyBytes.Length -gt 0) { $stream.Write($bodyBytes, 0, $bodyBytes.Length) }
  $stream.Flush()
}

function Send-Json($stream, [int]$status, $obj, $cors) {
  Send-Response $stream $status $cors ($obj | ConvertTo-Json -Compress)
}

function Get-PrinterList {
  try {
    return @(Get-Printer | Select-Object Name, ShareName, Shared | ForEach-Object {
      @{ name = "$($_.Name)"; shareName = "$($_.ShareName)"; shared = [bool]$_.Shared }
    })
  } catch { return @() }
}

function Invoke-RawPrint([string]$zpl, [string]$printer, [string]$printerHost) {
  if (-not $printer -or ($printer -notmatch '^[\w .$()+#-]{1,80}$')) { throw 'Nome de compartilhamento invalido.' }
  if (-not $printerHost) { $printerHost = 'localhost' }
  if ($printerHost -notmatch '^[A-Za-z0-9._-]{1,255}$') { throw 'Host invalido.' }
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("orq-" + [Guid]::NewGuid().ToString('N') + ".zpl")
  [IO.File]::WriteAllBytes($tmp, [Text.Encoding]::GetEncoding('iso-8859-1').GetBytes($zpl))
  try {
    $unc = "\\$printerHost\$printer"
    $argLine = '/c copy /b "{0}" "{1}"' -f $tmp, $unc
    $p = Start-Process -FilePath 'cmd.exe' -ArgumentList $argLine -NoNewWindow -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "copy retornou codigo $($p.ExitCode)" }
  } finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  }
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
Write-Host ""
Write-Host "  Orquestra - Agente de Impressao"
Write-Host "  Ouvindo em http://127.0.0.1:$Port"
Write-Host "  Deixe esta janela aberta. Feche-a para parar o agente."
Write-Host ""

while ($true) {
  $client = $null
  try {
    $client = $listener.AcceptTcpClient()
    $client.ReceiveTimeout = 6000
    $stream = $client.GetStream()
    $req = Read-Request $stream
    if (-not $req) { continue }

    $reqLine = ($req.Header -split "`r`n")[0]
    $rl = $reqLine -split ' '
    $method = $rl[0]
    $path = ($rl[1] -split '\?')[0]
    $cors = Get-CorsHeaders $req.Header

    if ($method -eq 'OPTIONS') {
      Send-Response $stream 204 $cors ''
    }
    elseif ($method -eq 'GET' -and $path -eq '/health') {
      Send-Json $stream 200 @{ ok = $true; agent = 'orquestra-print-ps'; platform = 'win32' } $cors
    }
    elseif ($method -eq 'GET' -and $path -eq '/printers') {
      Send-Json $stream 200 @{ ok = $true; printers = (Get-PrinterList) } $cors
    }
    elseif ($method -eq 'POST' -and $path -eq '/print') {
      try {
        $data = $req.Body | ConvertFrom-Json
        Invoke-RawPrint $data.zpl $data.printer $data.host
        Send-Json $stream 200 @{ ok = $true; printer = $data.printer } $cors
      } catch {
        Send-Json $stream 200 @{ ok = $false; error = "$($_.Exception.Message)" } $cors
      }
    }
    else {
      Send-Json $stream 404 @{ ok = $false; error = 'rota nao encontrada' } $cors
    }
  } catch {
    # erros por conexao nao derrubam o agente
  } finally {
    if ($client) { try { $client.Close() } catch {} }
  }
}
