@echo off
title Orquestra - Agente de Impressao
cd /d "%~dp0"
echo Iniciando o Agente de Impressao do Orquestra...
echo Deixe esta janela aberta enquanto estiver imprimindo etiquetas.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0agent.ps1"
echo.
echo O agente foi encerrado. Pressione uma tecla para fechar.
pause >nul
