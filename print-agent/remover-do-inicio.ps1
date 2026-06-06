# Remove o Agente de Impressao do inicio do Windows e encerra o que esta rodando.

$ErrorActionPreference = 'SilentlyContinue'

$startup = [Environment]::GetFolderPath('Startup')
$vbsPath = Join-Path $startup 'OrquestraPrintAgent.vbs'
if (Test-Path $vbsPath) { Remove-Item $vbsPath -Force }

# Encerra o powershell que esta rodando o agent.ps1.
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -like '*agent.ps1*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Write-Host ''
Write-Host '  Agente removido do inicio e encerrado.'
Write-Host ''
