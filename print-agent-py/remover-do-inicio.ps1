# Remove o Agente de Impressao (Python) do inicio do Windows e encerra o que
# estiver rodando.

$ErrorActionPreference = 'SilentlyContinue'

$startup = [Environment]::GetFolderPath('Startup')
$vbsPath = Join-Path $startup 'OrquestraPrintAgentPy.vbs'
if (Test-Path $vbsPath) { Remove-Item $vbsPath -Force }

# Encerra o python/pythonw que esta rodando o agent.py.
Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" |
  Where-Object { $_.CommandLine -like '*agent.py*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Write-Host ''
Write-Host '  Agente (Python) removido do inicio e encerrado.'
Write-Host ''
