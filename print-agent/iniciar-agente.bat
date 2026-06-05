@echo off
title Orquestra - Agente de Impressao
cd /d "%~dp0"
echo Iniciando o Agente de Impressao do Orquestra...
echo Deixe esta janela aberta enquanto for imprimir etiquetas.
echo.
node agent.mjs
echo.
echo O agente foi encerrado. Pressione uma tecla para fechar.
pause >nul
