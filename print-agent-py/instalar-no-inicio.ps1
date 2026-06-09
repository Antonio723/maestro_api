# Instala o Agente de Impressao (Python) para rodar EM SEGUNDO PLANO (sem janela)
# e INICIAR COM O WINDOWS. Usa o pythonw.exe (Python sem console) e cria um .vbs
# na pasta Inicializar que sobe o agent.py oculto. Ja inicia agora.
#
# Requer Python 3 instalado nesta estacao.

$ErrorActionPreference = 'Stop'
$here  = Split-Path -Parent $MyInvocation.MyCommand.Path
$agent = Join-Path $here 'agent.py'

if (-not (Test-Path $agent)) { throw "agent.py nao encontrado em $here" }

# Prefere o pythonw.exe (sem console). Se nao achar, cai para python.exe (o .vbs
# ainda esconde a janela, mas pode piscar por um instante).
$pyw = (Get-Command pythonw.exe -ErrorAction SilentlyContinue).Source
if (-not $pyw) {
  $py = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
  if (-not $py) { throw "Python 3 nao encontrado. Instale o Python 3 (com 'Add to PATH')." }
  $pyExe = $py
} else {
  $pyExe = $pyw
}

$startup = [Environment]::GetFolderPath('Startup')
$vbsPath = Join-Path $startup 'OrquestraPrintAgentPy.vbs'

# Linha VBS que roda o pythonw com janela oculta (0 = hidden).
$inner    = '"{0}" "{1}"' -f $pyExe, $agent
$innerVbs = $inner -replace '"', '""'
$vbsLine  = 'CreateObject("WScript.Shell").Run "{0}", 0, False' -f $innerVbs
Set-Content -LiteralPath $vbsPath -Value $vbsLine -Encoding ASCII

# Inicia agora (em segundo plano, sem janela).
Start-Process 'wscript.exe' -ArgumentList ('"{0}"' -f $vbsPath)

Write-Host ''
Write-Host '  Agente (Python) instalado para iniciar com o Windows, em segundo plano.'
Write-Host ('  Usando: {0}' -f $pyExe)
Write-Host '  Ele JA esta rodando agora (sem janela).'
Write-Host '  Para desativar, rode o remover-do-inicio.bat.'
Write-Host ''
