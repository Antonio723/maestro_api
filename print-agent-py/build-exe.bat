@echo off
REM ==========================================================================
REM  Gera o OrquestraAgenteImpressao.exe a partir do agent.py (uma unica vez,
REM  numa maquina com Python 3 instalado). Depois e so distribuir a PASTA
REM  "dist\OrquestraAgenteImpressao" para as estacoes — elas NAO precisam de
REM  Python.
REM
REM  Usamos --onedir (e nao --onefile) de proposito: o onefile costuma ser
REM  barrado/posto em quarentena por antivirus corporativo (ex.: Bitdefender).
REM  O onedir e bem menos suscetivel. Ainda assim, em frota com EDR pode ser
REM  necessario ASSINAR o .exe ou pedir a liberacao (allowlist) ao TI.
REM ==========================================================================
cd /d "%~dp0"

where python >nul 2>nul || (echo Python 3 nao encontrado. Instale o Python 3. & pause & exit /b 1)

python -m pip install --upgrade pyinstaller || (echo Falha ao instalar o PyInstaller. & pause & exit /b 1)

python -m PyInstaller --onedir --console --noconfirm ^
  --name "OrquestraAgenteImpressao" ^
  --distpath "%~dp0dist" ^
  --workpath "%~dp0build" ^
  --specpath "%~dp0build" ^
  "%~dp0agent.py"

echo.
echo Pronto. O agente esta em:  dist\OrquestraAgenteImpressao\OrquestraAgenteImpressao.exe
echo Distribua a pasta inteira (com a subpasta _internal).
pause
