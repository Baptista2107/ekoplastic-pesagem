@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
title Ekoplastic Pesagem - Descobrir o endereco do Mini PC

echo ============================================================
echo   EKOPLASTIC - DESCOBRIR O ENDERECO DA ESTACAO
echo ============================================================
echo.
echo   Este programa SO LE. Ele nao mexe no sistema de pesagem,
echo   nao reinicia nada, nao envia nada para o GitHub e nao
echo   altera o Mini PC.
echo.
echo   Ele procura a estacao de tres jeitos:
echo     1. pelas unidades de rede mapeadas neste PC
echo     2. pela lista do Tailscale, se estiver instalado
echo     3. varrendo a rede local, se os dois primeiros falharem
echo.
echo   A procura e na porta 3443, a mesma do acesso pelo celular.
echo   A porta 3000 do sistema escuta so em 127.0.0.1 e nunca
echo   responde de fora da propria maquina.
echo.
echo   No fim ele pode gravar o endereco encontrado na linha
echo   MINIPC do ENVIAR-ATUALIZACAO.bat - mas so se voce mandar.
echo.
echo   O log fica em OUTPUT_DESCOBRIR_MINIPC.TXT
echo ============================================================
echo.

if not exist "descobrir-minipc.ps1" goto :semscript
if not exist "server.js" goto :pastaerrada

set "PS=powershell"
where powershell >nul 2>&1
if errorlevel 1 set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0descobrir-minipc.ps1"
if errorlevel 1 goto :falhou
echo.
pause
exit /b 0

:falhou
echo.
echo ------------------------------------------------------------
echo  O PowerShell terminou com erro. Veja o arquivo
echo  OUTPUT_DESCOBRIR_MINIPC.TXT e mande no chat.
echo ------------------------------------------------------------
echo.
pause
exit /b 1

:semscript
echo FALHA: nao achei o arquivo descobrir-minipc.ps1 nesta pasta.
echo Ele vem junto com este atalho. Peca os dois de novo no chat.
echo.
pause
exit /b 1

:pastaerrada
echo FALHA: esta nao parece a pasta do sistema - nao ha server.js aqui.
echo Coloque este atalho dentro da pasta v157 e rode de novo.
echo.
pause
exit /b 1
