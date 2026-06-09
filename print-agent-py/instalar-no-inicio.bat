@echo off
title Orquestra - Instalar Agente (Python) em segundo plano
echo Instalando o agente para rodar em segundo plano e iniciar com o Windows...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar-no-inicio.ps1"
echo.
pause
