@echo off
title Orquestra - Agente de Impressao (Python)
cd /d "%~dp0"
echo Iniciando o Agente de Impressao do Orquestra...
echo Deixe esta janela aberta enquanto estiver imprimindo etiquetas.
echo.

REM 1) Prefere o EXE empacotado (nao exige Python instalado).
if exist "%~dp0OrquestraAgenteImpressao.exe" (
  "%~dp0OrquestraAgenteImpressao.exe"
  goto fim
)
if exist "%~dp0OrquestraAgenteImpressao\OrquestraAgenteImpressao.exe" (
  "%~dp0OrquestraAgenteImpressao\OrquestraAgenteImpressao.exe"
  goto fim
)

REM 2) Sem EXE: roda pelo Python local (precisa do Python 3 instalado).
where python >nul 2>nul
if %errorlevel%==0 (
  python "%~dp0agent.py"
  goto fim
)
echo.
echo Nao encontrei o OrquestraAgenteImpressao.exe nem o Python.
echo Gere o EXE com build-exe.bat (uma vez, numa maquina com Python) ou
echo instale o Python 3 nesta estacao.

:fim
echo.
echo O agente foi encerrado. Pressione uma tecla para fechar.
pause >nul
