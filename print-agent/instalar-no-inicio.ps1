# Instala o Agente de Impressao para rodar EM SEGUNDO PLANO (sem janela) e
# INICIAR COM O WINDOWS. Cria um atalho .vbs na pasta Inicializar que sobe o
# agent.ps1 com a janela oculta, e ja inicia agora.

$ErrorActionPreference = 'Stop'
$here  = Split-Path -Parent $MyInvocation.MyCommand.Path
$agent = Join-Path $here 'agent.ps1'

if (-not (Test-Path $agent)) { throw "agent.ps1 nao encontrado em $here" }

$startup = [Environment]::GetFolderPath('Startup')
$vbsPath = Join-Path $startup 'OrquestraPrintAgent.vbs'

# Linha VBS que roda o powershell com janela oculta (0 = hidden).
$inner    = 'powershell -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $agent
$innerVbs = $inner -replace '"', '""'
$vbsLine  = 'CreateObject("WScript.Shell").Run "{0}", 0, False' -f $innerVbs
Set-Content -LiteralPath $vbsPath -Value $vbsLine -Encoding ASCII

# Inicia agora (em segundo plano, sem janela).
Start-Process 'wscript.exe' -ArgumentList ('"{0}"' -f $vbsPath)

Write-Host ''
Write-Host '  Agente instalado para iniciar com o Windows, em segundo plano.'
Write-Host '  Ele JA esta rodando agora (sem janela).'
Write-Host '  Para desativar, rode o remover-do-inicio.bat.'
Write-Host ''
