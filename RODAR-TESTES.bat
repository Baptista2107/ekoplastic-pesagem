@echo off
chcp 65001 >nul
title Ekoplastic - Piso de Testes
cd /d "%~dp0"
echo Rodando piso de testes automatizados...
echo (sobe um servidor temporario em porta isolada, nao mexe no banco de producao)
echo.
node testes\piso-testes.js
echo.
pause
