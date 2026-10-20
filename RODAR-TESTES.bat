@echo off
chcp 65001 >nul
title Ekoplastic - Testes
cd /d "%~dp0"
echo Rodando todos os testes automatizados (uns 2 minutos)...
echo (sobe um servidor temporario em porta isolada, nao mexe no banco de producao)
echo.
node testes\rodar-todos.js
echo.
pause
