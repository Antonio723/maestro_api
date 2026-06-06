@echo off
title Orquestra - Remover Agente do inicio
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0remover-do-inicio.ps1"
echo.
pause
